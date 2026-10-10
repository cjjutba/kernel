import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { bashVerdict, IDLE_STOP_MS, limitsFromEvent, limitsFromUsage, matchesRoomRule, mergeLimit, roomRule, sessionEnv, Sessions, type SessionDeps } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'

// The SDK is replaced by a scripted session: each query() records its options and yields whatever the test feeds it.
// An abort ends the stream with an error, as the real one does when Kernel stops the process.
const sdk = vi.hoisted(() => ({ calls: [] as { options: Options; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Options }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    signal?.addEventListener('abort', () => { for (const w of waiters.splice(0)) w.reject(aborted()) })
    sdk.calls.push({ options, feed: (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) } })
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted ? Promise.reject(aborted()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      }),
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {}
    }
  }
}))

const lists = { neverAllow: ['git push origin main'], alwaysAsk: ['rm -rf', 'drizzle-kit push'] }

describe('Bash rules', () => {
  it('blocks Never allow, lets room rules beat Always ask, and leaves everything else to Claude Code', () => {
    expect(bashVerdict('git push origin main', lists, ['git push origin main'])).toBe('deny')
    expect(bashVerdict('pnpm drizzle-kit push', lists, [])).toBe('ask')
    expect(bashVerdict('pnpm drizzle-kit push', lists, ['pnpm drizzle-kit push'])).toBe('allow')
    expect(bashVerdict('npm test', lists, [])).toBeUndefined()
  })

  it('matches room rules the way Claude Code matches Bash rules', () => {
    expect(matchesRoomRule('git log --oneline -1', 'git log --oneline -1')).toBe(true)
    expect(matchesRoomRule('git log --oneline -2', 'git log --oneline -1')).toBe(false)
    expect(matchesRoomRule('git log', 'git log:*')).toBe(true)
    expect(matchesRoomRule('git log -5', 'git log:*')).toBe(true)
    expect(matchesRoomRule('git logs', 'git log:*')).toBe(false)
  })

  it('never lets a prefix rule cover a chained command', () => {
    for (const c of ['npm run build && pnpm db:reset', 'npm run build; rm -rf dist', 'npm run build | sh', 'npm run build\ndrizzle-kit push', 'npm run build $(curl x)'])
      expect(matchesRoomRule(c, 'npm run build:*'), c).toBe(false)
    expect(bashVerdict('npm run build && pnpm db:reset', { neverAllow: [], alwaysAsk: ['pnpm db:reset'] }, ['npm run build:*'])).toBe('ask')
  })

  it("saves Claude Code's own suggestion when it has one, else the exact command", () => {
    expect(roomRule(' rm -rf dist ')).toBe('rm -rf dist')
    const one = [{ type: 'addRules' as const, behavior: 'allow' as const, destination: 'localSettings' as const, rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }] }]
    expect(roomRule('npm run build -- --watch', one)).toBe('npm run build:*')
    expect(roomRule('npm run build -- --watch', one, true)).toBe('npm run build -- --watch')
    const two = [{ ...one[0], rules: [{ toolName: 'Bash', ruleContent: 'cd:*' }, { toolName: 'Bash', ruleContent: 'npm run build:*' }] }]
    expect(roomRule('cd web && npm run build', two)).toBe('cd web && npm run build')
  })
})

describe('session env', () => {
  it('never hands an API key to a session', () => {
    const env = sessionEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 'tok' }, { KERNEL_PORT: '4300' })
    expect(env).toEqual({ PATH: '/bin', KERNEL_PORT: '4300' })
  })

  it('turns agent teams on or off for Kernel sessions, whatever the shell exports, and leaves it alone when not asked (KERNEL-73)', () => {
    expect(sessionEnv({ PATH: '/bin' }, {}, { agentTeams: true })).toEqual({ PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
    expect(sessionEnv({ PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, {}, { agentTeams: false })).toEqual({ PATH: '/bin' })
    expect(sessionEnv({ PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, {})).toEqual({ PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
  })
})

describe('usage', () => {
  const usage = (five: number, week: number): SDKControlGetUsageResponse => ({
    session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
    subscription_type: 'max', rate_limits_available: true, behaviors: null,
    rate_limits: { five_hour: { utilization: five, resets_at: '2026-10-07T08:20:00+00:00' }, seven_day: { utilization: week, resets_at: null }, seven_day_opus: null }
  } as unknown as SDKControlGetUsageResponse)

  it("reads both windows from rate_limit_event, keeping the named window's status", () => {
    const info = { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1791361200, unifiedWindows: { five_hour: { utilization: 0.81, resetsAt: 1791361200 }, seven_day: { utilization: 0.16, resetsAt: 1791921600 } } }
    expect(limitsFromEvent(info as any)).toEqual([
      { type: 'five_hour', status: 'allowed_warning', utilization: 0.81, resetsAt: 1791361200 },
      { type: 'seven_day', utilization: 0.16, resetsAt: 1791921600 }
    ])
  })

  it('converts the usage call to rate_limit_event units', () => {
    expect(limitsFromUsage(usage(58, 17))).toEqual([
      { type: 'five_hour', utilization: 0.58, resetsAt: 1791361200 },
      { type: 'seven_day', utilization: 0.17, resetsAt: undefined }
    ])
    // Fable's own weekly window is the one rate_limit_event calls seven_day_overage_included.
    const fable = usage(58, 17)
    fable.rate_limits!.model_scoped = [{ display_name: 'Fable', utilization: 100, resets_at: '2026-10-07T08:20:00+00:00' }]
    expect(limitsFromUsage(fable)).toContainEqual({ type: 'seven_day_overage_included', utilization: 1, resetsAt: 1791361200 })
  })

  it('clears a stored status once its window resets', () => {
    const hit = { type: 'five_hour' as const, status: 'rejected' as const, utilization: 1, resetsAt: 1000 }
    expect(mergeLimit(hit, { type: 'five_hour', utilization: 0.99 }, 999_000).status).toBe('rejected')
    expect(mergeLimit(hit, { type: 'five_hour', utilization: 0.02, resetsAt: 19000 }, 999_000)).toEqual({ type: 'five_hour', status: 'allowed', utilization: 0.02, resetsAt: 19000 })
    expect(mergeLimit(hit, { type: 'five_hour', utilization: 0.02 }, 1_000_001).status).toBe('allowed')
  })

  it('lifts a rejection early when a reading shows clear room, and not on a reset time read back a second off', () => {
    const hit = { type: 'five_hour' as const, status: 'rejected' as const, utilization: 1, resetsAt: 1000 }
    expect(mergeLimit(hit, { type: 'five_hour', utilization: 0 }, 999_000).status).toBe('allowed')
    expect(mergeLimit(hit, { type: 'five_hour', utilization: 1, resetsAt: 1001 }, 999_000).status).toBe('rejected')
  })

  it('asks a live session on demand and falls back to event data when the call fails', async () => {
    const s = new Sessions({} as SessionDeps)
    const inner = s as unknown as { live: Map<string, unknown>; limits: Map<string, unknown> }
    inner.limits.set('five_hour', { type: 'five_hour', status: 'allowed_warning', utilization: 0.8 })
    expect(await s.usage()).toEqual([{ type: 'five_hour', status: 'allowed_warning', utilization: 0.8 }])

    let answer: () => Promise<SDKControlGetUsageResponse> = () => Promise.reject(new Error('not supported'))
    inner.live.set('chat', { abort: new AbortController(), query: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => answer() } })
    expect(await s.usage()).toEqual([{ type: 'five_hour', status: 'allowed_warning', utilization: 0.8 }])

    answer = async () => usage(85, 20)
    expect(await s.usage()).toEqual([
      { type: 'five_hour', status: 'allowed_warning', utilization: 0.85, resetsAt: 1791361200 },
      { type: 'seven_day', status: 'allowed', utilization: 0.2 }
    ])
  })
})

describe('Always allow in this room', () => {
  it('saves the rule on the room once, and it survives a restart', async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    const open = () => new Kernel({ dataDir, home })
    const k = open()
    const room = await k.addRoom(repo)
    const deps = (k.sessions as unknown as { d: SessionDeps }).d
    deps.allowInRoom(room.id, 'git log --oneline -1')
    deps.allowInRoom(room.id, 'git log --oneline -1')
    expect(deps.roomAllow(room.id)).toEqual(['git log --oneline -1'])
    k.store.db.close()

    const again = open()
    expect(again.store.room(room.id)?.allow).toEqual(['git log --oneline -1'])
    again.store.db.close()
  })
})

describe('idle stop (KERNEL-183)', () => {
  afterEach(() => { vi.useRealTimers(); bus.removeAllListeners('push'); bus.removeAllListeners('activity') })

  const noor: AgentDef = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Noor.' } as AgentDef
  const rowan: AgentDef = { ...noor, id: 'rowan', name: 'Rowan', role: 'Lead', lead: true }
  // Lets the scripted stream reach Kernel. Fake timers move by a millisecond, which no idle clock notices.
  const flush = () => vi.advanceTimersByTimeAsync(1)

  async function setup(o: { agent?: AgentDef; agentLimit?: number } = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-idle-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: (o.agent ?? noor).id, port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat(chat)
    store.saveChat({ ...chat, id: 'other', title: 'Other' })
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: o.agentLimit ?? 0 } } as unknown as AppSettings
    const exits: string[] = []
    const cutOff: string[][] = []
    const sessions = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: () => o.agent ?? noor, mcpFor: () => undefined,
      roomAllow: () => [], allowInRoom: () => {}, onExit: (_ws, c) => { exits.push(c.id) }, onCutOff: (ids) => { cutOff.push(ids) }
    })
    const pushes: PushEvent[] = []
    const activity: { kind: string }[] = []
    bus.on('push', (e: PushEvent) => pushes.push(e))
    bus.on('activity', (e: { kind: string }) => activity.push(e))
    const sid = 'session-1'
    /** Sends a message and runs the turn it starts to its end. */
    const turn = async (chatId = chat.id, o: { from?: 'kernel' } = {}) => {
      await sessions.send(chatId, [{ type: 'text', text: 'Add a pdf_url column' }], o)
      const call = sdk.calls.at(-1)!
      call.feed({ type: 'system', subtype: 'init', session_id: chatId === chat.id ? sid : 'session-2', apiKeySource: 'none' })
      call.feed({ type: 'result', subtype: 'success', uuid: `r${sdk.calls.length}`, duration_ms: 5 })
      await flush()
      return call
    }
    const stopped = (call: { options: Options }) => !!call.options.abortController?.signal.aborted
    return { store, sessions, turn, stopped, pushes, activity, exits, cutOff, sid }
  }

  it('stops the process after 10 idle minutes and adds no status, row or crash', async () => {
    const { sessions, turn, stopped, pushes, activity, exits, store, sid } = await setup()
    const call = await turn()
    expect(sessions.isRunning('chat')).toBe(false)
    pushes.length = 0
    activity.length = 0
    const items = store.items('chat').length

    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 10)
    expect(stopped(call)).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(stopped(call)).toBe(true)

    // Nothing tells anyone: no offline or idle status, no log row, no transcript row, no crash for the Lead.
    expect(pushes.filter((e) => e.type === 'agent.status' || e.type === 'chat.running')).toEqual([])
    expect(activity).toEqual([])
    expect(store.items('chat')).toHaveLength(items)
    expect(exits).toEqual([])
    // The hook server drops managed sessions' hooks, so Claude Code's SessionEnd on the way out adds no "ended the session" row.
    expect(sessions.isManaged(sid)).toBe(true)
  })

  it('resumes the same conversation on the next message, with the model, effort and plan mode the chat has now', async () => {
    const { sessions, turn, store, sid } = await setup()
    await turn()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    await sessions.configure('chat', { model: 'claude-opus-5-5', effort: 'high', plan: true })

    const next = await turn()
    expect(sdk.calls.at(-1)).toBe(next)
    expect(next.options).toMatchObject({ resume: sid, model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan' })
    expect(next.options.sessionId).toBeUndefined()

    // The reply streams into the transcript as before.
    await sessions.send('chat', [{ type: 'text', text: 'And an index' }])
    sdk.calls.at(-1)!.feed({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none' })
    sdk.calls.at(-1)!.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Indexed it.' }] } })
    await flush()
    expect(store.items('chat').at(-1)).toMatchObject({ kind: 'text', text: 'Indexed it.' })
  })

  it('counts the idle time from the last turn, and never stops a turn that is running', async () => {
    const { sessions, turn, stopped } = await setup()
    const call = await turn()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 60_000)
    await turn()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stopped(call)).toBe(false)
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(call)).toBe(true)

    // A turn that runs for an hour keeps its process.
    await sessions.send('chat', [{ type: 'text', text: 'Run the migration' }])
    const long = sdk.calls.at(-1)!
    await vi.advanceTimersByTimeAsync(6 * IDLE_STOP_MS)
    expect(sessions.isRunning('chat')).toBe(true)
    expect(stopped(long)).toBe(false)
  })

  it('gives the same turnFrom, kernelTurn and blocked status before and after the stop', async () => {
    const { sessions, turn, pushes } = await setup()
    const call = await turn('chat', { from: 'kernel' })
    expect(sessions.kernelTurn('chat')).toBe(true)
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(sdk.calls.at(-1)).toBe(call)
    expect(sessions.kernelTurn('chat')).toBe(true)
    expect(sessions.turnFrom('chat')).toBe('kernel')

    // A hook refused a step and the agent gave up: the chat shows blocked, process or not.
    await sessions.send('chat', [{ type: 'text', text: 'Push it' }])
    const next = sdk.calls.at(-1)!
    next.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    next.feed({ type: 'system', subtype: 'hook_response', hook_event: 'PreToolUse', exit_code: 2, stderr: 'No pushes to main', output: '', stdout: '' })
    next.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'r-blocked', duration_ms: 5 })
    await flush()
    expect(sessions.turnFrom('chat')).toBeUndefined()
    pushes.length = 0
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(next.options.abortController?.signal.aborted).toBe(true)
    expect(pushes.filter((e) => e.type === 'agent.status')).toEqual([])
    // Close chat still clears the block it kept, as it does for a chat with a process.
    sessions.stop('chat')
    expect(pushes.filter((e) => e.type === 'agent.status')).toEqual([expect.objectContaining({ status: 'idle' })])
  })

  it('keeps the process while messages wait, and stops it once the queue is gone', async () => {
    const { sessions, turn, stopped } = await setup({ agentLimit: 1 })
    const call = await turn()
    // Another chat takes the only slot, so a message to this one waits.
    await sessions.send('other', [{ type: 'text', text: 'Busy' }])
    const { queued, why } = await sessions.send('chat', [{ type: 'text', text: 'Waits' }])
    expect({ queued, why }).toEqual({ queued: true, why: 'capacity' })
    await vi.advanceTimersByTimeAsync(3 * IDLE_STOP_MS)
    expect(stopped(call)).toBe(false)

    sessions.unqueue('chat', sessions.queued('chat')[0].id)
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(call)).toBe(true)
  })

  it('keeps the process of a chat held for setup, even once its brief is removed', async () => {
    const { sessions, turn, stopped } = await setup()
    const call = await turn()
    sessions.hold('chat', [{ type: 'text', text: 'The brief' }])
    // The user removes the held brief in the composer, so only the hold for setup keeps the process.
    sessions.unqueue('chat', sessions.queued('chat')[0].id)
    expect(sessions.queued('chat')).toEqual([])
    await vi.advanceTimersByTimeAsync(3 * IDLE_STOP_MS)
    expect(stopped(call)).toBe(false)
    sessions.release('chat')
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(call)).toBe(true)
  })

  it('keeps the process while every room is held, offline or signed out, and stops it once the hold lifts', async () => {
    const { sessions, turn, stopped } = await setup()
    const call = await turn()
    sessions.holdAll('offline')
    await vi.advanceTimersByTimeAsync(3 * IDLE_STOP_MS)
    expect(stopped(call)).toBe(false)
    sessions.releaseAll('offline')
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(call)).toBe(true)
  })

  it('keeps the process while the room is paused, and stops it after the room resumes', async () => {
    const { sessions, turn, stopped } = await setup()
    const call = await turn()
    sessions.pause('room')
    await vi.advanceTimersByTimeAsync(3 * IDLE_STOP_MS)
    expect(stopped(call)).toBe(false)
    sessions.resume('room')
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(call)).toBe(true)
  })

  it('keeps the process of a chat a usage limit cut off', async () => {
    const { sessions, stopped, cutOff } = await setup()
    await sessions.send('chat', [{ type: 'text', text: 'Go' }])
    const call = sdk.calls.at(-1)!
    call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 86_400 } })
    call.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'r-limit', duration_ms: 5 })
    await flush()
    expect(cutOff.at(-1)).toEqual(['chat'])
    await vi.advanceTimersByTimeAsync(3 * IDLE_STOP_MS)
    expect(stopped(call)).toBe(false)
  })

  it('keeps the process while a background task runs, and ignores ambient ones', async () => {
    const { turn, stopped } = await setup()
    const call = await turn()
    const tasks = (list: { task_id: string; ambient?: boolean }[]) => call.feed({ type: 'system', subtype: 'background_tasks_changed', tasks: list.map((t) => ({ task_type: 'local_bash', description: 'dev server', ...t })) })
    tasks([{ task_id: 't1' }, { task_id: 'watch', ambient: true }])
    await flush()
    await vi.advanceTimersByTimeAsync(3 * IDLE_STOP_MS)
    expect(stopped(call)).toBe(false)

    tasks([{ task_id: 'watch', ambient: true }])
    await flush()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(call)).toBe(true)
  })

  it("starts a Lead turn from a team update after the Lead's chat was stopped", async () => {
    const { sessions, turn, stopped, sid } = await setup({ agent: rowan })
    const call = await turn()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(call)).toBe(true)

    expect(sessions.post('chat', [{ type: 'text', text: 'Noor opened PR #12' }])).toBe(true)
    expect(sdk.calls.at(-1)!.options).toMatchObject({ resume: sid })
    expect(sessions.isRunning('chat')).toBe(true)
    expect(sessions.kernelTurn('chat')).toBe(true)
  })
})
