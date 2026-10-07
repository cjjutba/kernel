import { describe, expect, it, vi } from 'vitest'
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
import { Sessions } from '../src/main/services/sessions'
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
    expect(await sessions.send(chat.id, text('second'))).toEqual({ queued: true })
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

describe('agent states from real events', () => {
  it('shows an agent as blocked with the hook\'s own output when a hook exits 2, and clears it when the agent moves on', async () => {
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

    // A hook that passes is not a block.
    call.feed({ type: 'assistant', uuid: 'a', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Attaching it.' }] } })
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'working' })
    call.feed({ type: 'system', subtype: 'hook_response', hook_id: 'h', hook_name: 'PostToolUse', hook_event: 'PostToolUse', output: '', stdout: '', stderr: 'oops', exit_code: 2, outcome: 'error', uuid: 'u2', session_id: 's1' })
    await flush()
    expect(statuses().at(-1)).toMatchObject({ status: 'working' })
    bus.off('activity', onAct)
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
    k.store.db.close()
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
    k.store.db.close()
  })

  it('restarts a chat through the channel', async () => {
    const k = await kernel()
    const h = k.handlers()
    const room = await k.addRoom(await tempRepo({ '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou lead.' }))
    const chat = await k.leadChat(room.id)
    const before = sdk.calls.length
    expect(await h['chats.restart']({ chatId: chat.id })).toEqual({ ok: true })
    expect(sdk.calls.length).toBe(before + 1)
    k.sessions.stopAll()
    await flush()
    k.store.db.close()
  })
})
