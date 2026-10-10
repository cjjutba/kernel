import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, ChatItem, Workspace } from '@shared/types'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { hookToken } from '../src/main/services/hookToken'
import { Store } from '../src/main/db'
import { CRASH_NOTE, LIMIT_LIFTED, QUIT_BUDGET_MS, QUIT_NOTE, RELAUNCH_NUDGE, TOOL_STOPPED } from '../src/main/services/sessions'

// A scripted SDK: each query() records its options and yields what the test feeds it. An interrupt ends the turn with
// error_during_execution, as the real one does, and an abort ends the stream.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[], onQuery: undefined as undefined | (() => void), deaf: false }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}), tool: () => ({}),
  query: ({ options }: { options: { abortController?: AbortController } }) => {
    sdk.onQuery?.()
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    signal?.addEventListener('abort', () => { for (const w of waiters.splice(0)) w.reject(aborted()) })
    const feed = (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) }
    sdk.calls.push({ options, feed })
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted ? Promise.reject(aborted()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      }),
      interrupt: async () => { if (!sdk.deaf) feed({ type: 'result', subtype: 'error_during_execution', uuid: `i${sdk.calls.length}`, duration_ms: 1 }) },
      setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async () => {}
    }
  }
}))

describe('restore and Ask Rowan', () => {
  it('recreates the worktree from the branch and keeps the chats', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const sent: string[] = []
    k.sessions.send = async (_chatId, parts) => { sent.push(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')); return { queued: false } }

    const room = await k.addRoom(repo)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    const chats = k.store.chats(ws.id).map((c) => c.id)
    // Archive keeps the branch, so Restore can find it again.
    await k.archiveWorkspace(ws.id, false)
    expect(k.store.workspace(ws.id)).toMatchObject({ status: 'archived' })
    expect(k.store.workspace(ws.id)?.archivedAt).toBeGreaterThan(0)
    await expect(stat(ws.path)).rejects.toThrow()

    const back = await k.handlers()['workspaces.restore']({ workspaceId: ws.id })
    expect(back).toMatchObject({ id: ws.id, status: 'ready', branch: ws.branch })
    expect(back.archivedAt).toBeUndefined()
    expect((await stat(ws.path)).isDirectory()).toBe(true)
    expect(k.store.chats(ws.id).map((c) => c.id)).toEqual(chats)

    // A workspace made while this one was archived may take its port. Restore picks another.
    const other = await k.createWorkspace(room.id, { prompt: 'Another', agentId: 'kai', title: 'Other' })
    k.store.saveWorkspace({ ...other, port: ws.port })
    await k.archiveWorkspace(ws.id, false)
    expect((await k.restoreWorkspace(ws.id)).port).not.toBe(ws.port)

    // A branch deleted on archive cannot come back, and the message says so.
    await k.archiveWorkspace(ws.id, true)
    await expect(k.restoreWorkspace(ws.id)).rejects.toThrow(/no longer exists/)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')

    const { chatId } = await k.handlers()['lead.ask']({ roomId: room.id, text: 'Who is blocked?' })
    expect(sent[sent.length - 1]).toBe('Who is blocked?')
    expect(k.store.chat(chatId)?.workspaceId).toBe((await k.leadChat(room.id)).workspaceId)
  }, 30000)
})

describe('agents that were working when Kernel quit or crashed (KERNEL-215)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 20))
  const text = (t: string) => [{ type: 'text' as const, text: t }]
  const callIn = (cwd: string, after = 0) => sdk.calls.slice(after).find((c) => c.options.cwd === cwd)!
  const users = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i: ChatItem) => (i.kind === 'user' ? [(i.parts[0] as { text: string }).text] : []))
  const notes = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i: ChatItem) => (i.kind === 'note' ? [i.text] : []))

  /** Rowan planning and Kai building, both mid-turn, with a message queued for Kai and Kai's Bash call still running. */
  async function working() {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const where = { dataDir, home }
    const k = new Kernel(where)
    await k.start()
    const room = await k.addRoom(repo)
    const lead = await k.leadChat(room.id)
    const leadWs = k.store.workspace(lead.workspaceId)!
    await k.sessions.send(lead.id, text('Plan the invoice table'))
    callIn(leadWs.path).feed({ type: 'system', subtype: 'init', session_id: 'rowan-session', apiKeySource: 'none' })
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const kai = k.store.chats(ws.id)[0]
    const call = callIn(ws.path)
    call.feed({ type: 'system', subtype: 'init', session_id: 'kai-session', apiKeySource: 'none' })
    call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }] } })
    await flush()
    expect(await k.sessions.send(kai.id, text('Then add a test'))).toMatchObject({ queued: true })
    return { k, where, room, lead, leadWs, ws, kai }
  }

  async function relaunch(where: { dataDir: string; home: string }, o: { signedIn?: boolean } = {}) {
    const before = sdk.calls.length
    const k = new Kernel(where)
    k.accountReader = async () => ({ signedIn: o.signedIn ?? true })
    await k.start()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    return { k, before }
  }

  it('carries every working agent on after a quit, the Lead with its Kernel tools, and what was queued goes first', async () => {
    const { k, where, lead, leadWs, ws, kai } = await working()
    await k.stop()
    const { k: k2, before } = await relaunch(where)

    // Kai: the stuck Bash row failed, the note says Kernel quit, and the queued message went out first, in the same conversation.
    expect(k2.store.items(kai.id).find((i) => i.kind === 'tool')).toMatchObject({ status: 'failed', output: TOOL_STOPPED })
    expect(notes(k2, kai)).toEqual([QUIT_NOTE])
    expect(k2.sessions.isRunning(kai.id)).toBe(true)
    expect(users(k2, kai).at(-1)).toBe('Then add a test')
    expect(k2.sessions.queued(kai.id).map((q) => (q.parts[0] as { text: string }).text)).toEqual([RELAUNCH_NUDGE])
    const kaiCall = callIn(ws.path, before)
    expect(kaiCall.options.resume).toBe('kai-session')
    expect(kaiCall.options.systemPrompt.append).toContain('You are Kai.')
    kaiCall.feed({ type: 'result', subtype: 'success', uuid: 'r2', duration_ms: 1 })
    await flush()
    expect(users(k2, kai).at(-1)).toBe(RELAUNCH_NUDGE)

    // Rowan carries on by itself too, with its prompt and its Kernel tools (amends D-116).
    const leadCall = callIn(leadWs.path, before)
    expect(k2.sessions.isRunning(lead.id)).toBe(true)
    expect(users(k2, lead).at(-1)).toBe(RELAUNCH_NUDGE)
    expect(leadCall.options.resume).toBe('rowan-session')
    expect(leadCall.options.systemPrompt.append).toContain('You are Rowan.')
    expect(leadCall.options.mcpServers?.kernel).toBeDefined()

    // Kai's crash rides along in Rowan's next update: it carries on, so it doesn't wake Rowan.
    const saved = k2.store.meta<{ pending: [string, { events: { kind: string; resumed?: boolean; workspaceId: string }[] }][] }>('leadUpdates')
    expect(saved?.pending.flatMap(([, p]) => p.events)).toContainEqual(expect.objectContaining({ kind: 'crash', resumed: true, workspaceId: ws.id }))
  }, 30000)

  it('says Kernel closed unexpectedly after a crash, and ends its leftover claude process before anything resumes', async () => {
    const { k, where, kai } = await working()
    await k.stop()
    // What a kill -9 leaves: no clean exit marker, and a claude process from that run still going.
    const dir = await mkdtemp(join(tmpdir(), 'kernel-pids-'))
    const claude = join(dir, 'claude')
    await symlink('/bin/sleep', claude)
    const left: ChildProcess = spawn(claude, ['30'], { stdio: 'ignore' })
    onTestFinished(() => { left.kill('SIGKILL') })
    const store = new Store(join(where.dataDir, 'kernel.db'))
    store.saveMeta('cleanExit', false)
    store.saveMeta('claudePids', [{ pid: left.pid, command: claude }])
    store.db.close()
    const aliveAtResume: boolean[] = []
    sdk.onQuery = () => { aliveAtResume.push(left.exitCode === null && left.signalCode === null) }
    try {
      const { k: k2 } = await relaunch(where)
      expect(left.signalCode).toBe('SIGTERM')
      expect(aliveAtResume.length).toBeGreaterThan(0)
      expect(aliveAtResume.every((alive) => !alive)).toBe(true)
      expect(notes(k2, kai)).toEqual([CRASH_NOTE])
      expect(k2.sessions.isRunning(kai.id)).toBe(true)
    } finally { sdk.onQuery = undefined }
  }, 30000)

  it('waits for sign-in when Claude Code is signed out at launch, then carries on', async () => {
    const { k, where, lead, kai } = await working()
    await k.stop()
    const { k: k2, before } = await relaunch(where, { signedIn: false })
    // Nothing started: the notes are there and both chats wait for the sign-in.
    expect(sdk.calls.length).toBe(before)
    expect(k2.sessions.heldFor()).toEqual(['auth'])
    expect(k2.sessions.isRunning(kai.id)).toBe(false)
    expect(k2.sessions.isRunning(lead.id)).toBe(false)
    expect(notes(k2, kai)).toEqual([QUIT_NOTE])
    expect(k2.store.meta('cutOff')).toMatchObject({ [kai.id]: 'quit', [lead.id]: 'quit' })
    // Signed in, as by `claude /login` in a terminal: both carry on, Kai with the queued message first.
    k2.accountReader = async () => ({ signedIn: true })
    await k2.readAccount()
    expect(k2.sessions.isRunning(kai.id)).toBe(true)
    expect(k2.sessions.isRunning(lead.id)).toBe(true)
    expect(users(k2, kai).at(-1)).toBe('Then add a test')
    expect(users(k2, lead).at(-1)).toBe(RELAUNCH_NUDGE)
  }, 30000)

  it("stops inside KERNEL-214's 5 second quit cap when a turn ignores the interrupt and an outside approval is waiting", async () => {
    const { k, where, kai } = await working()
    const port = JSON.parse(await readFile(join(where.dataDir, 'settings.json'), 'utf8')).hookPort
    const repo = k.store.rooms()[0].path
    // A Claude Code session outside Kernel waits on an approval in the Inbox, which holds its request to the hook server open.
    const outside = fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-kernel-token': hookToken(where.dataDir) },
      body: JSON.stringify({ session_id: 'outside', transcript_path: '/t', cwd: repo, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm db:reset' } })
    }).catch(() => undefined)
    await vi.waitFor(() => expect(k.store.approvals({ pendingOnly: true }).some((a) => a.source === 'hook')).toBe(true))
    sdk.deaf = true
    try {
      const t0 = Date.now()
      // Restart to update and before-quit can both ask: they wait for the same stop.
      const first = k.stop()
      expect(k.stop()).toBe(first)
      await first
      const took = Date.now() - t0
      expect(took).toBeGreaterThanOrEqual(QUIT_BUDGET_MS)
      expect(took).toBeLessThan(4000)
    } finally { sdk.deaf = false }
    await outside
    const store = new Store(join(where.dataDir, 'kernel.db'))
    expect(store.meta('cleanExit')).toBe(true)
    expect(store.meta('working')).toContain(kai.id)
    store.db.close()
  }, 30000)

  it("loads a cut-off list saved before KERNEL-215 as a limit, and the chat carries on with its agent's prompt", async () => {
    const { k, where, ws, kai } = await working()
    await k.stop()
    const store = new Store(join(where.dataDir, 'kernel.db'))
    store.saveMeta('working', [])
    store.saveMeta('queues', {})
    store.saveMeta('cutOff', [kai.id])
    store.db.close()
    const { k: k2, before } = await relaunch(where)
    expect(users(k2, kai).at(-1)).toBe(LIMIT_LIFTED)
    expect(callIn(ws.path, before).options.systemPrompt.append).toContain('You are Kai.')
  }, 30000)
})
