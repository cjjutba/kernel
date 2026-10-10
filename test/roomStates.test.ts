import { describe, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { HOLD_TIMEOUT_SEC, RESTART_NUDGE, Sessions } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { tempRepo } from './helpers'

// A scripted SDK, as in sessionRunner.test.ts, plus `fail` to end a session the way a crashed process does.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; prompt: any; feed: (m: unknown) => void; fail: (e: Error) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}), tool: () => ({}),
  query: ({ prompt, options }: { prompt: unknown; options: { abortController?: AbortController } }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    signal?.addEventListener('abort', () => { for (const w of waiters.splice(0)) w.reject(aborted()) })
    const call = {
      options, prompt,
      feed: (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) },
      fail: (e: Error) => { const w = waiters.shift(); if (w) w.reject(e) }
    }
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted ? Promise.reject(aborted()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 10))
const starter = join(__dirname, '..', 'docs', 'starter-agents')
const noor: AgentDef = { id: 'noor', name: 'Noor', role: 'Engine', description: '', lead: false, prompt: '', file: 'noor.md' }

async function runner() {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-states-')), 'kernel.db'))
  const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/x', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
  store.saveWorkspace(ws)
  store.saveChat(chat)
  const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 } } as unknown as AppSettings
  const sessions = new Sessions({ store, approvals: new Approvals(store), settings: () => settings, agentFor: () => noor, mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => undefined })
  const pushes: PushEvent[] = []
  const on = (e: PushEvent) => pushes.push(e)
  bus.on('push', on)
  const statuses = () => pushes.filter((e) => e.type === 'agent.status').map((e) => (e as Extract<PushEvent, { type: 'agent.status' }>))
  return { store, sessions, chat, statuses, done: () => bus.off('push', on) }
}

const text = (t: string) => [{ type: 'text' as const, text: t }]
const hookExit2 = (event: string, stderr = 'refused') => ({ type: 'system', subtype: 'hook_response', hook_id: 'h', hook_name: event, hook_event: event, output: '', stdout: '', stderr, exit_code: 2, outcome: 'error', uuid: `h-${event}`, session_id: 's1' })
const toolUse = (id: string) => ({ type: 'assistant', uuid: `a-${id}`, parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a.ts' } }] } })
const toolResult = (id: string, isError = false) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'refused' : 'ok', is_error: isError }] } })
const success = (uuid: string) => ({ type: 'result', subtype: 'success', uuid, duration_ms: 1 })

describe('pausing a room', () => {
  it('lets a running turn reach its next tool call, holds it there, and holds new sends until Resume', async () => {
    const { sessions, chat, store, statuses, done } = await runner()
    await sessions.send(chat.id, text('first'))
    const call = sdk.calls[sdk.calls.length - 1]
    const hold = (call.options as Options).hooks!.PreToolUse!.find((m) => !m.matcher && m.hooks.length === 1 && m.hooks[0].name !== 'report')!.hooks.at(-1) as HookCallback
    const before = sdk.calls.length

    sessions.pause('room')
    let released = false
    const waiting = hold({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: '/tmp' } as never, 'x', { signal: new AbortController().signal } as never).then(() => { released = true })
    await flush()
    expect(released).toBe(false)

    // Held sends show in the chat's queue, and nothing reaches the SDK.
    expect(await sessions.send(chat.id, text('second'))).toEqual({ queued: true, why: 'running' })
    expect(sessions.queued(chat.id)).toHaveLength(1)
    expect(sdk.calls.length).toBe(before)

    // The turn that was running ends: the held message still waits, and the agent shows as paused, not idle.
    call.feed({ type: 'result', subtype: 'success', uuid: 'r', duration_ms: 1 })
    await flush()
    expect(sessions.queued(chat.id)).toHaveLength(1)
    expect(statuses().at(-1)).toMatchObject({ agentId: 'noor', status: 'paused' })

    sessions.resume('room')
    await waiting
    expect(released).toBe(true)
    expect(sessions.queued(chat.id)).toHaveLength(0)
    expect(store.items(chat.id).filter((i) => i.kind === 'user')).toHaveLength(2)
    done()
  })
})

describe('the pause hold', () => {
  it('outlasts the CLI\'s 600 second hook default, and ends when the call is aborted', async () => {
    const { sessions, chat, done } = await runner()
    await sessions.send(chat.id, text('first'))
    const matchers = (sdk.calls.at(-1)!.options as Options).hooks!.PreToolUse!
    const matcher = matchers.find((m) => m.timeout !== undefined)!
    expect(matcher.timeout).toBeGreaterThan(600 * 100)
    expect(matcher.timeout).toBe(HOLD_TIMEOUT_SEC)

    sessions.pause('room')
    const abort = new AbortController()
    let released = false
    const waiting = (matcher.hooks[0] as HookCallback)({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: '/tmp' } as never, 'x', { signal: abort.signal } as never).then(() => { released = true })
    await flush()
    expect(released).toBe(false)
    abort.abort()
    await waiting
    expect(released).toBe(true)
    done()
  })

  it('takes its abort listener off the call when Resume ends the wait', async () => {
    const { sessions, chat, done } = await runner()
    await sessions.send(chat.id, text('first'))
    const matcher = (sdk.calls.at(-1)!.options as Options).hooks!.PreToolUse!.find((m) => m.timeout !== undefined)!
    sessions.pause('room')
    const abort = new AbortController()
    const waiting = (matcher.hooks[0] as HookCallback)({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: '/tmp' } as never, 'x', { signal: abort.signal } as never)
    await flush()
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1)
    sessions.resume('room')
    await waiting
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0)
    done()
  })

  it('keeps held sends across a restart, and leaves needs, blocked and offline alone when pausing', async () => {
    const { sessions, chat, statuses, done } = await runner()
    await sessions.send(chat.id, text('first'))
    const call = sdk.calls.at(-1)!
    sessions.pause('room')
    expect(statuses().at(-1)).toMatchObject({ status: 'working' })

    // A permission request during the pause shows as needs.
    const abort = new AbortController()
    const asking = (call.options as Options).canUseTool!('Edit', { file_path: 'a.ts' }, { signal: abort.signal, suggestions: [], toolUseID: 't1' } as never)
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'needs' })
    abort.abort()
    await asking
    expect(statuses().at(-1)).toMatchObject({ status: 'paused' })

    // A hook that refuses a step during the pause shows as blocked.
    call.feed(hookExit2('PreToolUse'))
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'blocked', activity: 'Blocked by the PreToolUse hook' })

    // A process that dies during the pause shows as offline.
    call.fail(new Error('exit code 137'))
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'offline' })

    await sessions.send(chat.id, text('held'))
    await sessions.restart(chat.id)
    expect(sessions.queued(chat.id).map((q) => q.parts)).toEqual([text('held'), text(RESTART_NUDGE)])
    done()
  })

  it('sends held messages before the restart nudge when the room is not paused', async () => {
    const { sessions, chat, store, done } = await runner()
    await sessions.send(chat.id, text('first'))
    expect(await sessions.send(chat.id, text('held'))).toEqual({ queued: true, why: 'running' })
    const before = sdk.calls.length
    await sessions.restart(chat.id)
    expect(sdk.calls.length).toBe(before + 1)
    const users = () => store.items(chat.id).filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.parts : []))
    expect(users().at(-1)).toEqual(text('held'))
    expect(sessions.queued(chat.id).map((q) => q.parts)).toEqual([text(RESTART_NUDGE)])

    sdk.calls.at(-1)!.feed(success('r1'))
    await flush()
    expect(users().at(-1)).toEqual(text(RESTART_NUDGE))
    expect(sessions.queued(chat.id)).toEqual([])
    done()
  })
})

describe('agent states from real events', () => {
  it('shows an agent as blocked with the hook\'s own output when a hook exits 2, and keeps it until the turn may finish', async () => {
    const { sessions, chat, statuses, done } = await runner()
    const events: { kind: string; data?: Record<string, unknown>; warn?: boolean }[] = []
    const onAct = (e: { kind: string; data?: Record<string, unknown>; warn?: boolean }) => events.push(e)
    bus.on('activity', onAct)
    await sessions.send(chat.id, text('close T-11'))
    const call = sdk.calls[sdk.calls.length - 1]
    expect((call.options as Options).includeHookEvents).toBe(true)
    call.feed({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: 'none' })
    call.feed({ type: 'system', subtype: 'hook_response', hook_id: 'h', hook_name: 'TaskCompleted', hook_event: 'TaskCompleted', output: '', stdout: '', stderr: 'exit 2: no test output attached to T-11', exit_code: 2, outcome: 'error', uuid: 'u', session_id: 's1' })
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'blocked', activity: 'Blocked by the TaskCompleted hook' })
    expect(events.find((e) => e.warn)).toMatchObject({ kind: 'agent.status', data: { detail: expect.stringContaining('TaskCompleted hook'), output: ['exit 2: no test output attached to T-11'] } })

    // The agent answering the hook is still blocked: the hook has not let the task finish yet.
    call.feed({ type: 'assistant', uuid: 'a', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Attaching it.' }] } })
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'blocked' })
    // PostToolUse cannot refuse a step, so its exit 2 is not a block.
    const warned = events.filter((e) => e.warn).length
    call.feed(hookExit2('PostToolUse', 'oops'))
    await flush()
    expect(events.filter((e) => e.warn)).toHaveLength(warned)
    // The turn finishing means the hook let it through.
    call.feed(success('r'))
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'idle' })
    bus.off('activity', onAct)
    done()
  })

  it('keeps a PreToolUse block through the agent giving up, and ends it with a new message or a step that goes through', async () => {
    const { sessions, chat, statuses, done } = await runner()
    await sessions.send(chat.id, text('push it'))
    const call = sdk.calls.at(-1)!
    call.feed({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: 'none' })
    call.feed(toolUse('t1'))
    call.feed(hookExit2('PreToolUse', 'no pushes to main'))
    call.feed(toolResult('t1', true))
    call.feed({ type: 'assistant', uuid: 'a2', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'The hook refused the push.' }] } })
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'blocked', activity: 'Blocked by the PreToolUse hook' })

    // The agent gives up and ends its turn: it still needs someone to look.
    call.feed(success('r1'))
    await flush()
    expect(sessions.isRunning(chat.id)).toBe(false)
    expect(statuses().at(-1)).toMatchObject({ status: 'blocked' })

    // A new message ends it.
    await sessions.send(chat.id, text('push to a branch instead'))
    expect(statuses().at(-1)).toMatchObject({ status: 'working' })

    // So does a later step that goes through.
    call.feed(toolUse('t2'))
    call.feed(hookExit2('PreToolUse'))
    call.feed(toolResult('t2', true))
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'blocked' })
    call.feed(toolUse('t3'))
    call.feed(toolResult('t3'))
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'working' })
    done()
  })

  it('drops a block the agent gave up on when its chat is stopped, as Archive and Close chat do', async () => {
    const { sessions, chat, statuses, done } = await runner()
    await sessions.send(chat.id, text('push it'))
    const call = sdk.calls.at(-1)!
    call.feed({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: 'none' })
    call.feed(toolUse('t1'))
    call.feed(hookExit2('PreToolUse', 'no pushes to main'))
    call.feed(toolResult('t1', true))
    call.feed(success('r1'))
    await flush()
    expect(sessions.isRunning(chat.id)).toBe(false)
    expect(statuses().at(-1)).toMatchObject({ status: 'blocked' })

    sessions.stop(chat.id)
    await flush()
    expect(statuses().at(-1)).toMatchObject({ agentId: 'noor', status: 'idle' })
    done()
  })

  it('keeps a Stop block while the agent works on what the hook asked, until the turn may end', async () => {
    const { sessions, chat, statuses, done } = await runner()
    await sessions.send(chat.id, text('finish up'))
    const call = sdk.calls.at(-1)!
    call.feed({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: 'none' })
    call.feed(hookExit2('Stop', 'tests have not run'))
    call.feed(toolUse('t1'))
    call.feed(toolResult('t1'))
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'blocked', activity: 'Blocked by the Stop hook' })
    call.feed(success('r1'))
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'idle' })
    done()
  })

  it('goes offline when the process dies, and Restart session resumes the same conversation', async () => {
    const { sessions, chat, store, statuses, done } = await runner()
    const events: { kind: string; text: string; data?: Record<string, unknown> }[] = []
    const onAct = (e: { kind: string; text: string; data?: Record<string, unknown> }) => events.push(e)
    bus.on('activity', onAct)
    await sessions.send(chat.id, text('build it'))
    const call = sdk.calls[sdk.calls.length - 1]
    call.feed({ type: 'system', subtype: 'init', session_id: 'sess-9', apiKeySource: 'none' })
    await flush()
    call.fail(new Error('exit code 137'))
    await flush()
    expect(statuses().at(-1)).toMatchObject({ agentId: 'noor', status: 'offline', activity: 'Session ended in invoice-schema' })
    expect(events.find((e) => e.kind === 'session.end')).toMatchObject({ text: 'went offline in', data: { detail: expect.stringContaining('exit code 137') } })
    expect(sessions.isRunning(chat.id)).toBe(false)

    const before = sdk.calls.length
    await sessions.restart(chat.id)
    expect(sdk.calls.length).toBe(before + 1)
    expect((sdk.calls.at(-1)!.options as Options).resume).toBe('sess-9')
    expect(store.items(chat.id).at(-1)).toMatchObject({ kind: 'user' })
    expect(statuses().at(-1)).toMatchObject({ status: 'working' })
    bus.off('activity', onAct)
    done()
  })

  it('does not call a Stop an offline session', async () => {
    const { sessions, chat, statuses, done } = await runner()
    await sessions.send(chat.id, text('go'))
    sessions.stop(chat.id)
    await flush()
    expect(statuses().some((s) => s.status === 'offline')).toBe(false)
    done()
  })
})

async function kernel() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt') }))
  const k = new Kernel({ dataDir, home, starterDir: starter, claudeSettingsFile: join(home, 'claude-settings.json') })
  await k.start()
  return k
}

describe('room pause and team templates', () => {
  it('records who paused the room, and clears it on resume', async () => {
    const k = await kernel()
    const room = await k.addRoom(await tempRepo())
    const h = k.handlers()
    expect(await h['rooms.setPaused']({ roomId: room.id, paused: true })).toMatchObject({ paused: true, pausedBy: 'you' })
    expect(k.sessions.isPaused(room.id)).toBe(true)
    expect(k.pauseRoom(room.id, 'limit')).toMatchObject({ paused: true, pausedBy: 'limit' })
    const resumed = await h['rooms.setPaused']({ roomId: room.id, paused: false })
    expect(resumed.paused).toBe(false)
    expect(resumed.pausedBy).toBeUndefined()
    expect(k.sessions.isPaused(room.id)).toBe(false)
    await k.stop()
  })

  it('seats a starter team, a pair, or another room\'s agents in an empty room, and refuses a room that has agents', async () => {
    const k = await kernel()
    const h = k.handlers()
    const a = await k.addRoom(await tempRepo()), b = await k.addRoom(await tempRepo()), c = await k.addRoom(await tempRepo())
    expect((await h['agents.seed']({ roomId: a.id, template: { kind: 'starter' } })).map((x) => x.id).sort()).toEqual(['ivy', 'kai', 'noor', 'rowan', 'theo'])
    expect((await h['agents.seed']({ roomId: b.id, template: { kind: 'pair' } })).map((x) => x.id).sort()).toEqual(['kai', 'rowan'])
    await expect(h['agents.seed']({ roomId: b.id, template: { kind: 'starter' } })).rejects.toThrow('already has agents')
    expect((await h['agents.seed']({ roomId: c.id, template: { kind: 'copy', fromRoomId: a.id } })).length).toBe(5)
    expect(await readdir(join(c.path, '.claude', 'agents'))).toHaveLength(5)
    await k.stop()
  })

  it('keeps needs, blocked and offline through a pause and a resume', async () => {
    const k = await kernel()
    const room = await k.addRoom(await tempRepo({ '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou lead.', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.', '.claude/agents/ivy.md': '---\nname: ivy\ndescription: QA.\n---\nIvy.', '.claude/agents/noor.md': '---\nname: noor\ndescription: Engine.\n---\nNoor.' }))
    await k.agents(room.id)
    const seen: Record<string, string> = {}
    const on = (e: PushEvent) => { if (e.type === 'agent.status') seen[e.agentId] = e.status }
    bus.on('push', on)
    bus.push({ type: 'agent.status', roomId: room.id, agentId: 'kai', status: 'needs' })
    bus.push({ type: 'agent.status', roomId: room.id, agentId: 'noor', status: 'blocked' })
    bus.push({ type: 'agent.status', roomId: room.id, agentId: 'ivy', status: 'offline' })
    k.pauseRoom(room.id, 'you')
    expect(seen).toMatchObject({ rowan: 'paused', kai: 'needs', noor: 'blocked', ivy: 'offline' })
    k.resumeRoom(room.id)
    expect(seen).toMatchObject({ rowan: 'idle', kai: 'needs', noor: 'blocked', ivy: 'offline' })
    bus.off('push', on)
    await k.stop()
  })

  it('gives an agent whose running chat is in plan mode planning on resume, not working', async () => {
    const k = await kernel()
    const room = await k.addRoom(await tempRepo({ '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou lead.' }))
    await k.agents(room.id)
    const chat = await k.leadChat(room.id)
    await k.sessions.configure(chat.id, { plan: true })
    const seen: Record<string, string> = {}
    const on = (e: PushEvent) => { if (e.type === 'agent.status') seen[e.agentId] = e.status }
    bus.on('push', on)
    await k.sessions.send(chat.id, text('plan the invoices page'))
    expect(seen.rowan).toBe('planning')
    k.pauseRoom(room.id, 'you')
    expect(seen.rowan).toBe('paused')
    k.resumeRoom(room.id)
    expect(seen.rowan).toBe('planning')
    bus.off('push', on)
    await k.stop()
  })

  it('restarts a chat through the channel', async () => {
    const k = await kernel()
    const h = k.handlers()
    const room = await k.addRoom(await tempRepo({ '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou lead.' }))
    const chat = await k.leadChat(room.id)
    const before = sdk.calls.length
    expect(await h['chats.restart']({ chatId: chat.id })).toEqual({ ok: true })
    expect(sdk.calls.length).toBe(before + 1)
    await flush()
    await k.stop()
  })
})

describe('switched-off skills and MCP servers (KERNEL-226)', () => {
  const agents = {
    '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou lead.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.',
    '.claude/agents/theo.md': '---\nname: theo\ndescription: Reviewer. Reviews PRs.\nrole: Reviewer\n---\nYou are Theo.'
  }
  const started = async (cwd: string) => {
    for (let i = 0; i < 200 && !sdk.calls.some((c) => c.options.cwd === cwd); i++) await flush()
    return sdk.calls.filter((c) => c.options.cwd === cwd).at(-1)!.options as Options
  }

  it("keeps a Lead's and a reviewer's Kernel tools when the room switches a server named kernel off, and leaves out the rest", async () => {
    const k = await kernel()
    const h = k.handlers()
    const room = await k.addRoom(await tempRepo(agents))
    await h['settings.setRoom']({ roomId: room.id, patch: { disabled: { skills: ['impeccable'], mcp: ['chrome-devtools', 'kernel'] } } })
    const off = { skillOverrides: { impeccable: 'off' }, deniedMcpServers: [{ serverName: 'chrome-devtools' }] }
    const lead = await k.leadChat(room.id)
    await k.sessions.send(lead.id, text('plan the invoices page'))
    const leadOptions = await started(k.store.workspace(lead.workspaceId)!.path)
    expect(Object.keys(leadOptions.mcpServers ?? {})).toEqual(['kernel'])
    expect(leadOptions.settings).toEqual(off)
    const author = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review PR #42', leadChatId: lead.id, reviewOf: author.id })
    const reviewOptions = await started(review.path)
    expect(Object.keys(reviewOptions.mcpServers ?? {})).toEqual(['kernel'])
    expect(reviewOptions.settings).toEqual(off)
    await k.stop()
  })

  it('starts the next session with a server switched back on', async () => {
    const k = await kernel()
    const h = k.handlers()
    const room = await k.addRoom(await tempRepo(agents))
    await h['settings.setRoom']({ roomId: room.id, patch: { disabled: { mcp: ['chrome-devtools'] } } })
    const lead = await k.leadChat(room.id)
    await k.sessions.send(lead.id, text('one'))
    const cwd = k.store.workspace(lead.workspaceId)!.path
    expect((await started(cwd)).settings).toEqual({ deniedMcpServers: [{ serverName: 'chrome-devtools' }] })
    await h['settings.setRoom']({ roomId: room.id, patch: { disabled: { mcp: [] } } })
    k.sessions.stop(lead.id)
    await k.sessions.send(lead.id, text('two'))
    expect((await started(cwd)).settings).toBeUndefined()
    await k.stop()
  })
})
