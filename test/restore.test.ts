import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, ChatItem, Workspace } from '@shared/types'
import { setUp, tempRepo, freePort } from './helpers'
import { Kernel } from '../src/main/kernel'
import { hookToken } from '../src/main/services/hookToken'
import { Store } from '../src/main/db'
import { CRASH_NOTE, CRASH_WAIT_NOTE, LIMIT_LIFTED, QUIT_BUDGET_MS, QUIT_NOTE, QUIT_WAIT_NOTE, RELAUNCH_NUDGE, TOOL_STOPPED } from '../src/main/services/sessions'

// A scripted SDK: each query() records its options and yields what the test feeds it. An interrupt ends the turn with
// error_during_execution, as the real one does, and an abort ends the stream.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[], onQuery: undefined as undefined | (() => void), deaf: false }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}), tool: () => ({}),
  query: ({ options }: { options: { abortController?: AbortController } }) => {
    // The naming request a first message starts (KERNEL-1024) isn't a session: it records nothing and never answers.
    if ((options as { persistSession?: boolean; maxTurns?: number }).persistSession === false && (options as { maxTurns?: number }).maxTurns === 1) return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
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

describe('restore', () => {
  it('recreates the worktree from the branch and keeps the chats', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
      '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), team: { leadMode: 'build' }, worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', leadWaitForSetup: true } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })

    const project = await k.addProject(repo)
    const ws = await k.createWorkspace(project.id, { prompt: 'Build the table', agentId: 'christian', title: 'Invoice table' })
    const chats = k.store.chats(ws.id).map((c) => c.id)
    // Archive keeps the branch, so Restore can find it again.
    await k.archiveWorkspace(ws.id, false)
    await k.archive.cleanedUp(ws.id)
    expect(k.store.workspace(ws.id)).toMatchObject({ status: 'archived' })
    expect(k.store.workspace(ws.id)?.archivedAt).toBeGreaterThan(0)
    await expect(stat(ws.path)).rejects.toThrow()

    // Restore sets the worktree up again before the agent goes on (KERNEL-77).
    const back = await k.handlers()['workspaces.restore']({ workspaceId: ws.id })
    expect(back).toMatchObject({ id: ws.id, status: 'setup', branch: ws.branch })
    expect(back.archivedAt).toBeUndefined()
    expect((await stat(ws.path)).isDirectory()).toBe(true)
    expect(k.store.chats(ws.id).map((c) => c.id)).toEqual(chats)
    await setUp(k, ws.id)

    // A workspace made while this one was archived may take its port. Restore picks another.
    const other = await k.createWorkspace(project.id, { prompt: 'Another', agentId: 'christian', title: 'Other' })
    k.store.saveWorkspace({ ...other, port: ws.port })
    await k.archiveWorkspace(ws.id, false)
    await k.archive.cleanedUp(ws.id)
    expect((await k.restoreWorkspace(ws.id)).port).not.toBe(ws.port)
    await setUp(k, ws.id)

    // A branch deleted on archive cannot come back, and the message says so.
    await k.archiveWorkspace(ws.id, true)
    await k.archive.cleanedUp(ws.id)
    await expect(k.restoreWorkspace(ws.id)).rejects.toThrow(/no longer exists/)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')

    // With no chat open, a new chat with Kernel starts with setup (KERNEL-405), and its first message waits only for the chat's worktree
    // (KERNEL-490, KERNEL-542).
    const { id: chatId } = await k.handlers()['lead.start']({ projectId: project.id, prompt: 'Who is blocked?' })
    expect(k.sessions.queued(chatId).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Who is blocked?' }]])
    expect(k.store.chat(chatId)?.workspaceId).toBe((await k.leadChat(project.id)).workspaceId)
  }, 30000)
})

describe('agents that were working when Kernel quit or crashed (KERNEL-215)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 20))
  const text = (t: string) => [{ type: 'text' as const, text: t }]
  const callIn = (cwd: string, after = 0) => sdk.calls.slice(after).find((c) => c.options.cwd === cwd)!
  const users = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i: ChatItem) => (i.kind === 'user' ? [(i.parts[0] as { text: string }).text] : []))
  const notes = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i: ChatItem) => (i.kind === 'note' ? [i.text] : []))
  async function until<T>(read: () => T | undefined | false): Promise<T> {
    for (let i = 0; i < 200; i++) { const v = read(); if (v) return v; await flush() }
    throw new Error('timed out')
  }

  /** Kernel planning and Christian building, both mid-turn, with a message queued for Christian and Christian's Bash call still running. */
  async function working() {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
      '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), team: { leadMode: 'build' }, worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', leadWaitForSetup: true } }))
    const where = { dataDir, home }
    const k = new Kernel(where)
    await k.start()
    const project = await k.addProject(repo)
    const lead = await k.leadChat(project.id)
    const leadWs = await setUp(k, lead.id)
    await k.sessions.send(lead.id, text('Plan the invoice table'))
    callIn(leadWs.path).feed({ type: 'system', subtype: 'init', session_id: 'kernel-session', apiKeySource: 'none' })
    const ws = await k.createWorkspace(project.id, { prompt: 'Build the table', agentId: 'christian', title: 'Invoice table', leadChatId: lead.id })
    const christian = k.store.chats(ws.id)[0]
    const call = callIn(ws.path)
    call.feed({ type: 'system', subtype: 'init', session_id: 'christian-session', apiKeySource: 'none' })
    call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }] } })
    await flush()
    expect(await k.sessions.send(christian.id, text('Then add a test'))).toMatchObject({ queued: true })
    return { k, where, project, lead, leadWs, ws, christian }
  }

  async function relaunch(where: { dataDir: string; home: string }, o: { signedIn?: () => Promise<boolean> } = {}) {
    const before = sdk.calls.length
    const k = new Kernel(where)
    k.signedInReader = o.signedIn ?? (async () => true)
    await k.start()
    // Carried-on chats wait for the launch check, which runs in the background after start().
    await flush()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    return { k, before }
  }

  it('carries every working agent on after a quit, the Lead with its Kernel tools, and what was queued goes first', async () => {
    const { k, where, lead, leadWs, ws, christian } = await working()
    await k.stop()
    const { k: k2, before } = await relaunch(where)

    // Christian: the stuck Bash row failed, the note says Kernel quit, and the queued message went out first, in the same conversation.
    expect(k2.store.items(christian.id).find((i) => i.kind === 'tool')).toMatchObject({ status: 'failed', output: TOOL_STOPPED })
    expect(notes(k2, christian)).toEqual([QUIT_NOTE])
    expect(k2.sessions.isRunning(christian.id)).toBe(true)
    expect(users(k2, christian).at(-1)).toBe('Then add a test')
    expect(k2.sessions.queued(christian.id).map((q) => (q.parts[0] as { text: string }).text)).toEqual([RELAUNCH_NUDGE])
    const kaiCall = callIn(ws.path, before)
    expect(kaiCall.options.resume).toBe('christian-session')
    expect(kaiCall.options.systemPrompt.append).toContain('You are Christian.')
    kaiCall.feed({ type: 'result', subtype: 'success', uuid: 'r2', duration_ms: 1 })
    await flush()
    expect(users(k2, christian).at(-1)).toBe(RELAUNCH_NUDGE)

    // Kernel carries on by itself too, with its prompt and its Kernel tools (amends D-116).
    const leadCall = callIn(leadWs.path, before)
    expect(k2.sessions.isRunning(lead.id)).toBe(true)
    expect(users(k2, lead).at(-1)).toBe(RELAUNCH_NUDGE)
    expect(leadCall.options.resume).toBe('kernel-session')
    expect(leadCall.options.systemPrompt.append).toContain('You are Kernel.')
    expect(leadCall.options.mcpServers?.kernel).toBeDefined()

    // Christian's crash rides along in Kernel's next update: it carries on, so it doesn't wake Kernel.
    const saved = k2.store.meta<{ pending: [string, { events: { kind: string; resumed?: boolean; workspaceId: string }[] }][] }>('leadUpdates')
    expect(saved?.pending.flatMap(([, p]) => p.events)).toContainEqual(expect.objectContaining({ kind: 'crash', resumed: true, workspaceId: ws.id }))
  }, 30000)

  it('says Kernel closed unexpectedly after a crash, and ends its leftover claude process before anything resumes', async () => {
    const { k, where, christian } = await working()
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
      expect(notes(k2, christian)).toEqual([CRASH_NOTE])
      expect(k2.sessions.isRunning(christian.id)).toBe(true)
    } finally { sdk.onQuery = undefined }
  }, 30000)

  it('says the agent waited for an answer when a permission or a question was up at the quit, and still carries it on', async () => {
    const { k, where, ws, christian } = await working()
    const call = callIn(ws.path)
    void call.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which table?', header: 'Table', options: [{ label: 'Invoices', description: '' }, { label: 'Refunds', description: '' }], multiSelect: false }] }, { signal: call.options.abortController.signal, toolUseID: 't2', suggestions: [] })
    const asked = await until(() => k.store.approvals({}).find((a) => a.chatId === christian.id))
    await k.stop()
    const { k: k2 } = await relaunch(where)
    expect(k2.store.approval(asked.id)?.status).toBe('expired')
    expect(notes(k2, christian)).toEqual([QUIT_WAIT_NOTE])
    expect(k2.sessions.isRunning(christian.id)).toBe(true)
    expect(users(k2, christian).at(-1)).toBe('Then add a test')
    expect(k2.sessions.queued(christian.id).map((q) => (q.parts[0] as { text: string }).text)).toEqual([RELAUNCH_NUDGE])
  }, 30000)

  it('says the same after a crash, where only the launch finds the question still pending', async () => {
    const { k, where, ws, christian } = await working()
    const call = callIn(ws.path)
    void call.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which table?', header: 'Table', options: [{ label: 'Invoices', description: '' }, { label: 'Refunds', description: '' }], multiSelect: false }] }, { signal: call.options.abortController.signal, toolUseID: 't2', suggestions: [] })
    const asked = await until(() => k.store.approvals({}).find((a) => a.chatId === christian.id))
    await k.stop()
    // What a kill leaves: no clean exit marker, nothing written down at a quit, and the question saved as pending.
    const store = new Store(join(where.dataDir, 'kernel.db'))
    store.saveMeta('cleanExit', false)
    store.saveMeta('waitedOnUser', [])
    store.saveApproval({ ...store.approval(asked.id)!, status: 'pending' })
    store.db.close()
    const { k: k2 } = await relaunch(where)
    expect(k2.store.approval(asked.id)?.status).toBe('expired')
    expect(notes(k2, christian)).toEqual([CRASH_WAIT_NOTE])
    expect(k2.sessions.isRunning(christian.id)).toBe(true)
  }, 30000)

  it('carries on once the launch check finishes, and lets go of every project even when the check throws', async () => {
    const { k, where, christian } = await working()
    await k.stop()
    const { k: k2 } = await relaunch(where, { signedIn: async () => { throw new Error('claude is not installed') } })
    expect(k2.sessions.heldFor()).toEqual([])
    expect(k2.sessions.isRunning(christian.id)).toBe(true)
  }, 30000)

  it('waits for sign-in when Claude Code is signed out at launch, then carries on', async () => {
    const { k, where, lead, christian } = await working()
    await k.stop()
    // The sign-in read is slow, as `claude auth status` can be. start() doesn't wait for it.
    let answer!: (signedIn: boolean) => void
    const { k: k2, before } = await relaunch(where, { signedIn: () => new Promise((r) => { answer = r }) })
    // Only the chats that carry on wait for it: no project is held, and nothing started.
    expect(k2.sessions.heldFor()).toEqual([])
    expect(sdk.calls.length).toBe(before)
    // Signed out: the launch hold becomes a sign-in hold. Nothing started, the notes are there and both chats wait.
    answer(false)
    await flush()
    expect(sdk.calls.length).toBe(before)
    expect(k2.sessions.heldFor()).toEqual(['auth'])
    expect(k2.sessions.isRunning(christian.id)).toBe(false)
    expect(k2.sessions.isRunning(lead.id)).toBe(false)
    expect(notes(k2, christian)).toEqual([QUIT_NOTE])
    expect(k2.store.meta('cutOff')).toMatchObject({ [christian.id]: { reason: 'quit' }, [lead.id]: { reason: 'quit' } })
    // Signed in, as by `claude /login` in a terminal: both carry on, Christian with the queued message first.
    k2.accountReader = async () => ({ signedIn: true })
    await k2.readAccount()
    expect(k2.sessions.isRunning(christian.id)).toBe(true)
    expect(k2.sessions.isRunning(lead.id)).toBe(true)
    expect(users(k2, christian).at(-1)).toBe('Then add a test')
    expect(users(k2, lead).at(-1)).toBe(RELAUNCH_NUDGE)
  }, 30000)

  it("stops inside KERNEL-214's 5 second quit cap when a turn ignores the interrupt and an outside approval is waiting", async () => {
    const { k, where, christian } = await working()
    const port = JSON.parse(await readFile(join(where.dataDir, 'settings.json'), 'utf8')).hookPort
    const repo = k.store.projects()[0].path
    // A Claude Code session outside Kernel waits on an approval in the Inbox, which holds its request to the hook server open.
    const outside = fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-kernel-token': hookToken(where.dataDir) },
      body: JSON.stringify({ session_id: 'outside', transcript_path: '/t', cwd: repo, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm db:reset' } })
    }).then((r) => r.json(), () => 'dropped')
    await vi.waitFor(() => expect(k.store.approvals({ pendingOnly: true }).some((a) => a.source === 'hook')).toBe(true), { timeout: 10_000 })
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
    // It got the fallback answer, so Claude Code asks in its own window, and the approval ended while the database was open.
    expect(await outside).toEqual({})
    const store = new Store(join(where.dataDir, 'kernel.db'))
    expect(store.approvals({}).filter((a) => a.source === 'hook').map((a) => a.status)).toEqual(['expired'])
    expect(store.meta('cleanExit')).toBe(true)
    expect(store.meta('working')).toContain(christian.id)
    store.db.close()
  }, 30000)

  it('sends the nudge to a chat a quit cut off by the abort once the launch check finishes (KERNEL-396)', async () => {
    const { k, where, christian } = await working()
    for (const q of k.sessions.queued(christian.id)) k.sessions.unqueue(christian.id, q.id)
    // The turn ignores the interrupt and there is no budget, as in the live test's abort case.
    sdk.deaf = true
    try { await k.stop({ budgetMs: 0 }) } finally { sdk.deaf = false }
    let answer!: (signedIn: boolean) => void
    const { k: k2 } = await relaunch(where, { signedIn: () => new Promise((r) => { answer = r }) })
    // `claude auth status` is still running when start() returns, so the nudge hasn't gone out yet.
    expect(notes(k2, christian)).toEqual([QUIT_NOTE])
    expect(users(k2, christian)).not.toContain(RELAUNCH_NUDGE)
    answer(true)
    await flush()
    expect(k2.sessions.isRunning(christian.id)).toBe(true)
    expect(users(k2, christian).at(-1)).toBe(RELAUNCH_NUDGE)
  }, 30000)

  it("loads a cut-off list saved before KERNEL-215 as a limit, and the chat carries on with its agent's prompt", async () => {
    const { k, where, ws, christian } = await working()
    await k.stop()
    const store = new Store(join(where.dataDir, 'kernel.db'))
    store.saveMeta('working', [])
    store.saveMeta('queues', {})
    store.saveMeta('cutOff', [christian.id])
    store.db.close()
    const { k: k2, before } = await relaunch(where)
    expect(users(k2, christian).at(-1)).toBe(LIMIT_LIFTED)
    expect(callIn(ws.path, before).options.systemPrompt.append).toContain('You are Christian.')
  }, 30000)

  it('keeps a temporary limit window across a restart and still holds the chat, and drops one older than 5 hours (KERNEL-1030)', async () => {
    const { k, where, christian } = await working()
    await k.stop()
    const hour = (rejectedAt: number) => ({ type: 'five_hour', status: 'rejected', provisional: true, rejectedAt })
    const store = new Store(join(where.dataDir, 'kernel.db'))
    store.saveMeta('working', [])
    store.saveMeta('queues', {})
    store.saveMeta('cutOff', { [christian.id]: 'limit' })
    store.saveMeta('limits', [hour(Date.now() - 60_000)])
    store.db.close()
    const { k: k2 } = await relaunch(where)
    expect((await k2.sessions.usage([])).find((l) => l.type === 'five_hour')).toMatchObject({ status: 'rejected', provisional: true })
    expect(users(k2, christian).at(-1)).not.toBe(LIMIT_LIFTED)
    await k2.stop({ budgetMs: 0 })

    const old = new Store(join(where.dataDir, 'kernel.db'))
    old.saveMeta('limits', [hour(Date.now() - 6 * 3600_000)])
    old.db.close()
    const { k: k3 } = await relaunch(where)
    expect((await k3.sessions.usage([])).find((l) => l.type === 'five_hour')).toMatchObject({ status: 'allowed' })
  }, 30000)
})

describe('restoring a workspace sets it up again (KERNEL-77, KERNEL-1016)', () => {
  const text = (t: string) => [{ type: 'text' as const, text: t }]
  /** A project whose setup logs each run and fails while `fail.txt` was copied in, with Christian's workspace set up once. */
  async function restorable(mode: 'worktree' | 'current' = 'worktree') {
    const log = join(await mkdtemp(join(tmpdir(), 'kernel-log-')), 'setup.txt')
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.gitignore': '.env.local\nfail.txt\n',
      '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
      '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.',
      '.kernel/settings.toml': `[scripts]\nsetup = "echo run >> ${log} && test ! -f fail.txt"\n\n[files]\ncopy = [".env.local", "fail.txt"]\n`
    })
    await writeFile(join(repo, '.env.local'), 'V=1\n')
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), team: { leadMode: 'build' }, worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', leadWaitForSetup: true } }))
    const k = new Kernel({ dataDir, home })
    k.signedInReader = async () => true
    await k.start()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    const project = await k.addProject(repo)
    const ws = await k.createWorkspace(project.id, { prompt: 'Build the table', agentId: 'christian', title: 'Invoice table', mode })
    const chat = k.store.chats(ws.id)[0]
    const runs = async () => (await readFile(log, 'utf8')).trim().split('\n').length
    const starts = async () => (await k.handlers()['checkpoints.list']({ workspaceId: ws.id })).filter((c) => c.start).length
    return { k, repo, project, ws, chat, runs, starts }
  }

  it('reruns files.copy and setup, takes no start checkpoint, and restarts the idle session once it passes (KERNEL-1016)', async () => {
    const { k, repo, ws, chat, runs, starts } = await restorable()
    expect(await runs()).toBe(1)
    expect(await starts()).toBe(1)
    await k.archiveWorkspace(ws.id, false)
    await k.archive.cleanedUp(ws.id)
    await writeFile(join(repo, '.env.local'), 'V=2\n')
    const restart = vi.spyOn(k.sessions, 'restartIdle')
    const back = await k.restoreWorkspace(ws.id)
    expect(back.status).toBe('setup')
    await setUp(k, ws.id)
    expect(await runs()).toBe(2)
    expect(await readFile(join(ws.path, '.env.local'), 'utf8')).toBe('V=2\n')
    expect(await starts()).toBe(1)
    await vi.waitFor(() => expect(restart).toHaveBeenCalledWith([ws.id]))
    expect(k.sessions.queued(chat.id)).toEqual([])
  }, 30000)

  it('lets a message start a turn while setup runs (KERNEL-1016)', async () => {
    const { k, ws, chat } = await restorable()
    await k.archiveWorkspace(ws.id, false)
    await k.archive.cleanedUp(ws.id)
    const back = await k.restoreWorkspace(ws.id)
    expect(back.status).toBe('setup')
    expect(k.sessions.isHeld(chat.id)).toBe(false)
    expect(k.sessions.waitsFor(chat.id)).not.toBe('setup')
    const before = sdk.calls.length
    expect(await k.sessions.send(chat.id, text('Carry on'))).not.toEqual({ queued: true, why: 'setup' })
    await vi.waitFor(() => expect(sdk.calls.length).toBe(before + 1))
    await setUp(k, ws.id)
  }, 30000)

  it('holds nothing through a failed setup, and Run again still works', async () => {
    const { k, repo, ws, chat, runs } = await restorable()
    await k.archiveWorkspace(ws.id, false)
    await k.archive.cleanedUp(ws.id)
    await writeFile(join(repo, 'fail.txt'), 'no\n')
    await k.restoreWorkspace(ws.id)
    await setUp(k, ws.id, 'failed')
    expect(k.sessions.isHeld(chat.id)).toBe(false)
    expect(k.sessions.waitsFor(chat.id)).not.toBe('setup')
    const before = sdk.calls.length
    expect(await k.sessions.send(chat.id, text('Carry on'))).not.toEqual({ queued: true, why: 'setup' })
    await vi.waitFor(() => expect(sdk.calls.length).toBe(before + 1))
    await rm(join(ws.path, 'fail.txt'))
    expect((await k.retrySetup(ws.id)).status).toBe('ready')
    expect(await runs()).toBe(3)
  }, 30000)

  it('brings a current-branch workspace back ready, with no setup', async () => {
    const { k, ws, runs } = await restorable('current')
    expect(await runs()).toBe(1)
    await k.archiveWorkspace(ws.id, false)
    await k.archive.cleanedUp(ws.id)
    expect((await k.restoreWorkspace(ws.id)).status).toBe('ready')
    expect(await runs()).toBe(1)
  }, 30000)
})
