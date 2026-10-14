import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, Options, Query, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { NO_PROMPTS } from '../src/main/services/exec'
import { bashVerdict, matchesRoomRule, roomRule } from '../src/main/services/bashGuard'
import { IDLE_STOP_MS, LIMIT_LIFTED, limitsFromEvent, limitsFromUsage, mergeLimit, sessionEnv, SESSION_GONE_NOTE, Sessions, type CutOffReason, type LimitPatch, type SessionDeps } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { ClaudeRunner, readUsage } from '../src/main/services/providers/claude'
import { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'

// The SDK is replaced by a scripted session: each query() records its options and yields whatever the test feeds it.
// An abort ends the stream with an error, as the real one does when Kernel stops the process. A `late` session keeps its
// stream open after the abort until `end()`, as a process does while it exits. `end()` is the process exiting on its own.
const sdk = vi.hoisted(() => ({ calls: [] as { options: Options; feed: (m: unknown) => void; end: () => void; late: boolean }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Options }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    let ended = false
    const call = {
      options, late: false,
      feed: (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) },
      end: () => { ended = true; for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true }) }
    }
    signal?.addEventListener('abort', () => { if (!call.late) for (const w of waiters.splice(0)) w.reject(aborted()) })
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted && !call.late ? Promise.reject(aborted()) : ended ? Promise.resolve({ value: undefined, done: true })
          : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
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
    expect(matchesRoomRule('git log --oneline -1', ['git log --oneline -1'])).toBe(true)
    expect(matchesRoomRule('git log --oneline -2', ['git log --oneline -1'])).toBe(false)
    expect(matchesRoomRule('git log', ['git log:*'])).toBe(true)
    expect(matchesRoomRule('git log -5', ['git log:*'])).toBe(true)
    expect(matchesRoomRule('git logs', ['git log:*'])).toBe(false)
  })

  it('never lets a prefix rule cover a chain with a command it does not cover (KERNEL-454)', () => {
    for (const c of ['npm run build && pnpm db:reset', 'npm run build; rm -rf dist', 'npm run build | sh', 'npm run build\ndrizzle-kit push', 'npm run build $(curl x)'])
      expect(matchesRoomRule(c, ['npm run build:*']), c).toBe(false)
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
    expect(env).toEqual({ ...NO_PROMPTS, PATH: '/bin', KERNEL_PORT: '4300' })
  })

  it("hands a session only the picked API key account's key, and no OAuth token beside it (KERNEL-523)", () => {
    const mac = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-from-the-mac', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_OAUTH_TOKEN: 'oat-from-the-shell' }
    expect(sessionEnv(mac, { ANTHROPIC_API_KEY: 'sk-picked' })).toEqual({ ...NO_PROMPTS, PATH: '/bin', ANTHROPIC_API_KEY: 'sk-picked' })
    // A token account and the CLI's own login still get no API key.
    expect(sessionEnv(mac, { CLAUDE_CODE_OAUTH_TOKEN: 'oat-added' })).toEqual({ ...NO_PROMPTS, PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat-added' })
    expect(sessionEnv(mac, {})).toEqual({ ...NO_PROMPTS, PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat-from-the-shell' })
  })

  it('turns agent teams on or off for Kernel sessions, whatever the shell exports, and leaves it alone when not asked (KERNEL-73)', () => {
    expect(sessionEnv({ PATH: '/bin' }, {}, { agentTeams: true })).toEqual({ ...NO_PROMPTS, PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
    expect(sessionEnv({ PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, {}, { agentTeams: false })).toEqual({ ...NO_PROMPTS, PATH: '/bin' })
    expect(sessionEnv({ PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, {})).toEqual({ ...NO_PROMPTS, PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
  })

  it("leaves the window a chat compacts against to the model, or to the user's own setting (context-window-follows-model)", () => {
    expect(sessionEnv({ PATH: '/bin' }, {})).toEqual({ ...NO_PROMPTS, PATH: '/bin' })
    expect(sessionEnv({ PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, {})).toEqual({ ...NO_PROMPTS, PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' })
  })

  it("sets a chat's compact window from its role, whatever the shell exports (feat-compact-window-per-role-with-plan)", () => {
    const mac = { PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }
    expect(sessionEnv({ PATH: '/bin' }, {}, { compact: '200k' })).toEqual({ ...NO_PROMPTS, PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' })
    expect(sessionEnv(mac, {}, { compact: '200k' })).toEqual({ ...NO_PROMPTS, PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' })
    expect(sessionEnv(mac, {}, { compact: 'full' })).toEqual({ ...NO_PROMPTS, PATH: '/bin' })
    expect(sessionEnv({ PATH: '/bin' }, {}, { compact: 'full' })).toEqual({ ...NO_PROMPTS, PATH: '/bin' })
    // A helper call or a terminal names no choice, and keeps what the Mac has.
    expect(sessionEnv(mac, {}, { agentTeams: true }).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000')
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

  describe.each([
    ['Claude', {}],
    ['Codex', { provider: 'codex' as const, accountId: 'acct' }]
  ])('a %s window', (_name, who) => {
    const at = (utilization: number, resetsAt = 1000, status?: 'allowed' | 'rejected') => ({ type: 'five_hour' as const, utilization, resetsAt, ...who, ...(status ? { status } : {}) })
    const merge = (prev: ReturnType<typeof at>, patch: LimitPatch, now = 999_000) => mergeLimit({ status: 'allowed', ...prev }, patch, now)

    it('keeps its highest reading when an older snapshot lands late (KERNEL-700)', () => {
      let stored = mergeLimit(undefined, at(0.026), 999_000)
      for (const u of [0.024, 0.026]) {
        stored = mergeLimit(stored, at(u), 999_000)
        expect(stored.utilization).toBe(0.026)
      }
      expect(stored).toMatchObject(who)
    })

    it('takes a lower reading from a new window, a passed reset or a clear drop', () => {
      expect(merge(at(0.4), at(0.05, 1061)).utilization).toBe(0.05)
      expect(merge(at(0.4), at(0.39, 1061)).utilization).toBe(0.39)
      expect(merge(at(0.4), at(0.39), 1_000_000).utilization).toBe(0.39)
      expect(merge(at(0.4), at(0.05)).utilization).toBe(0.05)
      expect(merge(at(0.4), at(0.38, 1060)).utilization).toBe(0.4)
    })

    it('still lifts a rejected window on a reading under 95% (D-069)', () => {
      expect(merge(at(1, 1000, 'rejected'), at(0.9))).toMatchObject({ status: 'allowed', utilization: 0.9 })
      expect(merge(at(1, 1000, 'rejected'), at(0.97))).toMatchObject({ status: 'rejected', utilization: 1 })
    })

    it('takes a status-only patch as before', () => {
      expect(merge(at(0.5), { type: 'five_hour', status: 'rejected', ...who })).toMatchObject({ status: 'rejected', utilization: 0.5 })
    })
  })

  /** A live Claude process on `account` (undefined: the CLI's own login) whose usage call runs `usage`. */
  const claudeLive = (usage: () => Promise<void>, account?: string) => {
    const r = Object.create(ClaudeRunner.prototype) as ClaudeRunner
    Object.defineProperty(r, 'closed', { value: false })
    Object.defineProperty(r, 'usage', { value: usage })
    return { runner: r, ...(account ? { account } : {}) }
  }

  it('asks a live session on demand and falls back to event data when the call fails', async () => {
    const s = new Sessions({} as SessionDeps)
    const inner = s as unknown as { live: Map<string, unknown>; limits: Map<string, unknown>; mergeLimits: (p: LimitPatch[]) => void }
    inner.limits.set('five_hour', { type: 'five_hour', status: 'allowed_warning', utilization: 0.8 })
    expect(await s.usage([{ provider: 'claude' }])).toEqual([{ type: 'five_hour', status: 'allowed_warning', utilization: 0.8 }])

    let answer: () => Promise<SDKControlGetUsageResponse> = () => Promise.reject(new Error('not supported'))
    // The chat's runner asks its Claude Code session, as ClaudeRunner.usage does (KERNEL-406).
    const query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => answer() } as unknown as Query
    inner.live.set('chat', claudeLive(() => readUsage(query, (p) => inner.mergeLimits(p))))
    expect(await s.usage([{ provider: 'claude' }])).toEqual([{ type: 'five_hour', status: 'allowed_warning', utilization: 0.8 }])

    answer = async () => usage(85, 20)
    expect(await s.usage([{ provider: 'claude' }])).toEqual([
      { type: 'five_hour', status: 'allowed_warning', utilization: 0.85, resetsAt: 1791361200, readAt: expect.any(Number) },
      { type: 'seven_day', status: 'allowed', utilization: 0.2, readAt: expect.any(Number) }
    ])
  })

  it("reads each account it is given on that account's live process, or else its own read, and keeps the account on each window (KERNEL-567)", async () => {
    const s = new Sessions({} as SessionDeps)
    const inner = s as unknown as { live: Map<string, unknown> }
    const asked: string[] = []
    inner.live.set('a', claudeLive(async () => { asked.push('cli') }))
    inner.live.set('b', claudeLive(async () => { asked.push('side') }, 'side'))
    // A legacy token account's process, which Providers never names, so it is never asked.
    inner.live.set('c', claudeLive(async () => { asked.push('legacy') }, 'legacy'))
    const read = (utilization: number) => async (merge: (p: LimitPatch[]) => void) => merge([{ type: 'five_hour', utilization }])
    const limits = await s.usage([
      { provider: 'claude' },
      { provider: 'claude', accountId: 'side', read: read(0.9) },
      { provider: 'claude', accountId: 'idle', read: read(0.3) },
      { provider: 'claude', accountId: 'broken', read: async () => { throw new Error('no answer') } }
    ])
    expect(asked.sort()).toEqual(['cli', 'side'])
    expect(limits).toEqual([{ type: 'five_hour', status: 'allowed', utilization: 0.3, accountId: 'idle', readAt: expect.any(Number) }])
  })

  it('says when each window was last read', async () => {
    const s = new Sessions({} as SessionDeps)
    const inner = s as unknown as { mergeLimits: (p: LimitPatch[]) => void }
    const before = Date.now()
    inner.mergeLimits([{ type: 'five_hour', utilization: 0.1 }])
    expect((await s.usage())[0].readAt).toBeGreaterThanOrEqual(before)
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
  const kernel: AgentDef = { ...noor, id: 'kernel', name: 'Kernel', role: 'Lead', lead: true }
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
    const cutOff: Record<string, CutOffReason>[] = []
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

  it('starts a fresh session when the conversation an idle stop left is gone by the next message (KERNEL-286)', async () => {
    const { sessions, turn, stopped, store, sid, exits } = await setup()
    await turn()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    await sessions.configure('chat', { model: 'claude-opus-5-5', effort: 'high', plan: true })
    await sessions.send('chat', [{ type: 'text', text: 'And an index' }])
    const resumed = sdk.calls.at(-1)!
    expect(resumed.options.resume).toBe(sid)
    // What Claude Code 2.1.292 answers when the transcript was pruned or ~/.claude/projects deleted.
    resumed.feed({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, duration_ms: 0, uuid: 'gone', errors: [`No conversation found with session ID: ${sid}`] })
    await flush()
    const fresh = sdk.calls.at(-1)!
    expect(fresh).not.toBe(resumed)
    expect(stopped(resumed)).toBe(true)
    expect(fresh.options).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan' })
    expect(fresh.options.resume).toBeUndefined()
    expect(store.chat('chat')?.sessionId).toBeUndefined()
    expect(sessions.isRunning('chat')).toBe(true)
    expect(store.items('chat').at(-1)).toMatchObject({ kind: 'note', text: SESSION_GONE_NOTE })
    expect(exits).toEqual([])
    // The fresh session's own id is what the next idle stop resumes.
    fresh.feed({ type: 'system', subtype: 'init', session_id: 'session-3', apiKeySource: 'none' })
    fresh.feed({ type: 'result', subtype: 'success', uuid: 'r-fresh', duration_ms: 5 })
    await flush()
    expect(store.chat('chat')?.sessionId).toBe('session-3')
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(fresh)).toBe(true)
    await sessions.send('chat', [{ type: 'text', text: 'And a test' }])
    expect(sdk.calls.at(-1)!.options.resume).toBe('session-3')
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
    expect(cutOff.at(-1)).toEqual({ chat: 'limit' })
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
    const { sessions, turn, stopped, sid } = await setup({ agent: kernel })
    const call = await turn()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(call)).toBe(true)

    expect(sessions.post('chat', [{ type: 'text', text: 'Noor opened PR #12' }])).toBe(true)
    expect(sdk.calls.at(-1)!.options).toMatchObject({ resume: sid })
    expect(sessions.isRunning('chat')).toBe(true)
    expect(sessions.kernelTurn('chat')).toBe(true)
  })
})

describe('a card whose turn or session is gone, on Claude (KERNEL-563)', () => {
  afterEach(() => { bus.removeAllListeners('push') })

  const noor: AgentDef = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Noor.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))
  type Call = (typeof sdk.calls)[number]

  async function setup() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-cards-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const approvals = new Approvals(store)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({ store, approvals, settings: () => settings, agentFor: () => noor, mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => {} })
    const statuses: string[] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'agent.status') statuses.push(e.status) })
    /** Sends a message and starts the turn it begins. */
    const start = async (text = 'Add a pdf_url column') => {
      await sessions.send('chat', [{ type: 'text', text }])
      const call = sdk.calls.at(-1)!
      call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
      await flush()
      return call
    }
    /**
     * A question card from canUseTool. Its signal never aborts, so only Kernel can end the card, as when Claude Code
     * doesn't cancel the call.
     */
    const ask = (call: Call, question = 'Which store?') => {
      const answer = (call.options.canUseTool as CanUseTool)('AskUserQuestion', { questions: [{ question, header: 'Store', multiSelect: false, options: [{ label: 'S3', description: '' }] }] }, { signal: new AbortController().signal, toolUseID: question } as never)
      const card = store.approvals({ pendingOnly: true }).find((a) => a.title === question)!
      return { answer, card }
    }
    const status = (id: string) => store.approval(id)?.status
    const interrupted = (call: Call) => call.feed({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: `r${sdk.calls.length}`, duration_ms: 5, errors: [] })
    return { store, sessions, approvals, start, ask, status, interrupted, statuses }
  }

  it('ends a waiting card when the chat closes', async () => {
    const t = await setup()
    const { answer, card } = t.ask(await t.start())
    t.sessions.stop('chat')
    expect(t.status(card.id)).toBe('expired')
    expect(await answer).toMatchObject({ behavior: 'deny' })
  })

  it('ends a waiting card when the process exits on its own, and the agent shows offline', async () => {
    const t = await setup()
    const call = await t.start()
    const { card } = t.ask(call)
    call.end()
    await flush()
    expect(t.status(card.id)).toBe('expired')
    expect(t.statuses.at(-1)).toBe('offline')
  })

  it("ends the turn's waiting cards on Stop when Claude Code doesn't cancel the call, and keeps an answered one", async () => {
    const t = await setup()
    const call = await t.start()
    const first = t.ask(call, 'Which store?')
    t.approvals.decide(first.card.id, { behavior: 'answer', text: 'S3' })
    const second = t.ask(call, 'Which bucket?')
    await t.sessions.interrupt('chat')
    t.interrupted(call)
    await flush()
    expect([t.status(first.card.id), t.status(second.card.id)]).toEqual(['answered', 'expired'])
    expect(t.statuses.at(-1)).toBe('idle')
  })

  it('ends them on Send now too, and still sends the queued message next', async () => {
    const t = await setup()
    const call = await t.start()
    const { card } = t.ask(call)
    await t.sessions.send('chat', [{ type: 'text', text: 'Use the staging bucket' }])
    await t.sessions.sendNow('chat', t.sessions.queued('chat')[0].id)
    t.interrupted(call)
    await flush()
    expect(t.status(card.id)).toBe('expired')
    expect(t.sessions.queued('chat')).toEqual([])
    expect(t.store.items('chat').filter((i) => i.kind === 'user').at(-1)).toMatchObject({ parts: [{ type: 'text', text: 'Use the staging bucket' }] })
    expect(t.sessions.isRunning('chat')).toBe(true)
  })

  it("ends only the old session's cards when a new session replaced it", async () => {
    const t = await setup()
    const old = await t.start()
    const before = t.ask(old, 'Which store?')
    old.late = true
    t.sessions.stop('chat')
    const next = await t.start('Carry on')
    const after = t.ask(next, 'Which bucket?')
    // The stopped process ends only now, after the new session put its own card up.
    old.end()
    await flush()
    expect([t.status(before.card.id), t.status(after.card.id)]).toEqual(['expired', 'pending'])
  })

  it('leaves a waiting card to expirePending when Kernel quits', async () => {
    const t = await setup()
    const call = await t.start()
    const { card } = t.ask(call)
    const quit = t.sessions.shutdown(50)
    t.interrupted(call)
    await quit
    expect(t.status(card.id)).toBe('pending')
    expect(t.approvals.expirePending().map((a) => a.id)).toEqual([card.id])
  })
})

describe('switching accounts while a chat waits on the user, on Claude (KERNEL-618)', () => {
  afterEach(() => { bus.removeAllListeners('push') })

  const noor: AgentDef = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Noor.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))

  /** A chat on Work, a Claude account whose folder each process gets, and `switchTo`, which does what `Providers.switchTo` asks of Sessions. */
  async function setup(o: { plan?: boolean } = {}) {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-switch-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: !!o.plan, createdAt: 1 })
    const approvals = new Approvals(store)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: ['pnpm build'], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    let active = 'work'
    const failures: { failure: string; account: string | undefined }[] = []
    const sessions = new Sessions({
      store, approvals, settings: () => settings, agentFor: () => noor, mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => {},
      accountFor: () => active, claudeEnv: () => ({ CLAUDE_CONFIG_DIR: `/homes/${active}` }), switchNote: (_p, id) => `Now on ${id}`,
      onFailure: (failure, _ws, _provider, account) => failures.push({ failure, account })
    })
    const start = async (text = 'Add a pdf_url column') => {
      await sessions.send('chat', [{ type: 'text', text }])
      const call = sdk.calls.at(-1)!
      call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
      await flush()
      return call
    }
    const switchTo = (to: string) => { active = to; sessions.restartProvider('claude'); sessions.drainWaiting() }
    const finish = async (call: (typeof sdk.calls)[number]) => { call.feed({ type: 'result', subtype: 'success', uuid: `r${sdk.calls.length}`, duration_ms: 5 }); await flush() }
    const stopped = (call: { options: Options }) => !!call.options.abortController?.signal.aborted
    const pending = () => store.approvals({ pendingOnly: true })
    const notes = () => store.items('chat').flatMap((i) => (i.kind === 'note' ? [i.text] : []))
    return { store, sessions, approvals, start, switchTo, finish, stopped, pending, notes, failures }
  }

  it('finishes a turn waiting on a permission card on the account it started on, and the next turn runs on the new one', async () => {
    const t = await setup()
    const call = await t.start()
    expect(call.options.env?.CLAUDE_CONFIG_DIR).toBe('/homes/work')
    const answer = (call.options.canUseTool as CanUseTool)('Bash', { command: 'pnpm build' }, { signal: new AbortController().signal, toolUseID: 'b1' } as never)
    const [card] = t.pending()
    expect(card).toMatchObject({ kind: 'tool', toolName: 'Bash' })
    t.switchTo('personal')
    // The card still waits, in the process it came from.
    expect(t.stopped(call)).toBe(false)
    expect(t.sessions.isRunning('chat')).toBe(true)
    t.approvals.decide(card.id, { behavior: 'allow' })
    expect(await answer).toMatchObject({ behavior: 'allow' })
    await t.finish(call)
    // That process ends with its turn, and the next turn starts one on Personal.
    expect(t.stopped(call)).toBe(true)
    const next = await t.start('Run the tests')
    expect(sdk.calls.at(-1)).toBe(next)
    expect(next.options.env?.CLAUDE_CONFIG_DIR).toBe('/homes/personal')
    expect(t.notes()).toEqual(['Now on personal'])
  })

  it('finishes a turn waiting on plan approval on the account it started on, and goes on with the plan there', async () => {
    const t = await setup({ plan: true })
    const call = await t.start('Plan the column')
    const calls = sdk.calls.length
    const answer = (call.options.canUseTool as CanUseTool)('ExitPlanMode', { plan: '1. Add the column' }, { signal: new AbortController().signal, toolUseID: 'p1' } as never)
    await flush()
    const [card] = t.pending()
    expect(card).toMatchObject({ kind: 'plan', detail: '1. Add the column' })
    t.switchTo('personal')
    expect(t.stopped(call)).toBe(false)
    t.approvals.decide(card.id, { behavior: 'allow' })
    expect(await answer).toMatchObject({ behavior: 'allow' })
    // The agent carries out the plan in the same turn, on Work, and nothing new started.
    expect(t.store.chat('chat')?.plan).toBe(false)
    expect(sdk.calls).toHaveLength(calls)
    await t.finish(call)
    expect(t.stopped(call)).toBe(true)
    expect((await t.start('Next')).options.env?.CLAUDE_CONFIG_DIR).toBe('/homes/personal')
  })

  const tasks = (call: (typeof sdk.calls)[number], ids: string[]) => call.feed({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash', description: 'dev server' })) })

  it('carries a chat a limit cut off over to the new account, even with a background task still running', async () => {
    const t = await setup()
    const call = await t.start()
    tasks(call, ['t1'])
    call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 86_400 } })
    await t.finish(call)
    expect(t.stopped(call)).toBe(false)
    const calls = sdk.calls.length
    t.switchTo('personal')
    // The process on Work ends with its task, and the chat picks up on Personal, once.
    expect(t.stopped(call)).toBe(true)
    expect(sdk.calls).toHaveLength(calls + 1)
    const next = sdk.calls.at(-1)!
    expect(next.options.env?.CLAUDE_CONFIG_DIR).toBe('/homes/personal')
    expect(next.options.resume).toBe('session-1')
    expect(t.store.items('chat').filter((i) => i.kind === 'user').at(-1)).toMatchObject({ from: 'kernel', parts: [{ type: 'text', text: LIMIT_LIFTED }] })
    expect(t.notes()).toEqual(['Now on personal'])
  })

  it('blames a sign-out a turn hits after a switch on the account it started on, and runs nothing again by itself', async () => {
    const t = await setup()
    const call = await t.start()
    t.switchTo('personal')
    t.switchTo('side')
    t.switchTo('work')
    t.switchTo('personal')
    const calls = sdk.calls.length
    // The old process on Work is refused, mid-turn, after Claude moved on.
    call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] }, session_id: 'session-1' })
    call.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'r1', duration_ms: 5, is_error: true, errors: [] })
    await flush()
    expect(t.failures).toEqual([{ failure: 'auth', account: 'work' }])
    expect(sdk.calls).toHaveLength(calls)
    expect(t.stopped(call)).toBe(true)
    // The next turn runs once, on the account in use now.
    const next = await t.start('Run the tests')
    expect(next.options.env?.CLAUDE_CONFIG_DIR).toBe('/homes/personal')
    expect(sdk.calls).toHaveLength(calls + 1)
    expect(t.store.items('chat').filter((i) => i.kind === 'user')).toHaveLength(2)
  })

  it('starts the next turn on the new account when the old process stayed for a background task', async () => {
    const t = await setup()
    const call = await t.start()
    tasks(call, ['t1'])
    await t.finish(call)
    t.switchTo('personal')
    // The task keeps the process on Work until something is sent.
    expect(t.stopped(call)).toBe(false)
    const next = await t.start('Run the tests')
    expect(t.stopped(call)).toBe(true)
    expect(next).not.toBe(call)
    expect(next.options.env?.CLAUDE_CONFIG_DIR).toBe('/homes/personal')
    expect(t.notes()).toEqual(['Now on personal'])
  })
})
