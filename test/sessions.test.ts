import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, Options, Query, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, LastTurn, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { NO_PROMPTS } from '../src/main/services/exec'
import { bashVerdict, matchesRoomRule, roomRule } from '../src/main/services/bashGuard'
import { COMPACT_INSTRUCTIONS, IDLE_STOP_MS, LIMIT_LIFTED, limitsFromEvent, limitsFromUsage, mergeLimit, sessionEnv, SESSION_GONE_NOTE, Sessions, TOO_LONG_NOTE, type CutOffReason, type LimitPatch, type SessionDeps } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { ClaudeRunner, readUsage } from '../src/main/services/providers/claude'
import { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'

// The SDK is replaced by a scripted session: each query() records its options and yields whatever the test feeds it.
// An abort ends the stream with an error, as the real one does when Kernel stops the process. A `late` session keeps its
// stream open after the abort until `end()`, as a process does while it exits. `end()` is the process exiting on its own.
// `sent` is the text of each message Kernel sent the process, in order.
const sdk = vi.hoisted(() => ({ calls: [] as { options: Options; feed: (m: unknown) => void; end: () => void; late: boolean; sent: string[] }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ prompt, options }: { prompt?: unknown; options: Options }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    let ended = false
    const call = {
      options, late: false, sent: [] as string[],
      feed: (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) },
      end: () => { ended = true; for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true }) }
    }
    signal?.addEventListener('abort', () => { if (!call.late) for (const w of waiters.splice(0)) w.reject(aborted()) })
    sdk.calls.push(call)
    if (prompt && typeof prompt === 'object' && Symbol.asyncIterator in prompt) {
      void (async () => {
        for await (const m of prompt as AsyncIterable<{ message?: { content?: { type: string; text?: string }[] } }>) call.sent.push((m.message?.content ?? []).flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join('\n'))
      })().catch(() => undefined)
    }
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
    expect(env).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin', KERNEL_PORT: '4300' })
  })

  it("hands a session only the picked API key account's key, and no OAuth token beside it (KERNEL-523)", () => {
    const mac = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-from-the-mac', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_OAUTH_TOKEN: 'oat-from-the-shell' }
    expect(sessionEnv(mac, { ANTHROPIC_API_KEY: 'sk-picked' })).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin', ANTHROPIC_API_KEY: 'sk-picked' })
    // A token account and the CLI's own login still get no API key.
    expect(sessionEnv(mac, { CLAUDE_CODE_OAUTH_TOKEN: 'oat-added' })).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat-added' })
    expect(sessionEnv(mac, {})).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat-from-the-shell' })
  })

  it('turns agent teams on or off for Kernel sessions, whatever the shell exports, and leaves it alone when not asked (KERNEL-73)', () => {
    expect(sessionEnv({ PATH: '/bin' }, {}, { agentTeams: true })).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
    expect(sessionEnv({ PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, {}, { agentTeams: false })).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin' })
    expect(sessionEnv({ PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, {})).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
  })

  it("leaves the window a chat compacts against to the model, or to the user's own setting (context-window-follows-model)", () => {
    expect(sessionEnv({ PATH: '/bin' }, {})).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin' })
    expect(sessionEnv({ PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, {})).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' })
  })

  it("sets a chat's compact window from its role, whatever the shell exports (feat-compact-window-per-role-with-plan)", () => {
    const mac = { PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }
    expect(sessionEnv({ PATH: '/bin' }, {}, { compact: '200k' })).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' })
    expect(sessionEnv(mac, {}, { compact: '200k' })).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' })
    expect(sessionEnv(mac, {}, { compact: 'full' })).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin' })
    expect(sessionEnv({ PATH: '/bin' }, {}, { compact: 'full' })).toEqual({ ...NO_PROMPTS, CLAUDE_CODE_ARTIFACT: '1', PATH: '/bin' })
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

describe("the user's answer to a card is their message, never the agent's prompt (KERNEL-836)", () => {
  afterEach(() => { bus.removeAllListeners('push') })

  const noor: AgentDef = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Noor.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))
  const image = { type: 'image' as const, name: 'mock.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', path: '.kernel/attachments/mock.png' }

  async function setup() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-answers-')), 'kernel.db'))
    store.saveWorkspace({ id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const approvals = new Approvals(store)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({ store, approvals, settings: () => settings, agentFor: () => noor, mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => {} })
    /** A card in the chat, placed as its process places one, then settled the way the user settles it. */
    const card = (kind: 'plan' | 'question' | 'agent' | 'tool') => {
      const { approval } = approvals.request({ kind, source: 'sdk', roomId: 'room', workspaceId: 'ws', chatId: 'chat', title: kind })
      sessions.placeApproval('chat', approval.id)
      return approval
    }
    const users = () => store.items('chat').filter((i) => i.kind === 'user')
    return { store, sessions, approvals, card, users }
  }

  it('adds one answer row right after each plan, question and agent card, with its text and images', async () => {
    const t = await setup()
    const answer = (a: ReturnType<typeof t.approvals.decide>) => { t.sessions.placeAnswer(a!); return a! }
    const decided = [
      answer(t.approvals.decide(t.card('plan').id, { behavior: 'allow' })),
      answer(t.approvals.decide(t.card('plan').id, { behavior: 'deny', message: 'Split it' }, { notes: 'Split it', images: [image] })),
      answer(t.approvals.decide(t.card('question').id, { behavior: 'answer', text: 'S3' })),
      answer(t.approvals.decide(t.card('agent').id, { behavior: 'allow' })),
      answer(t.approvals.decide(t.card('agent').id, { behavior: 'deny', message: 'Please change the agent file.' }))
    ]
    expect(t.users().map((i) => i.kind === 'user' && i.parts)).toEqual([
      [{ type: 'text', text: 'Approved' }],
      [{ type: 'text', text: 'Split it' }, image],
      [{ type: 'text', text: 'S3' }],
      [{ type: 'text', text: 'Approve' }],
      [{ type: 'text', text: 'Not now' }]
    ])
    // Each sits under its own card, as the user's (no `from`), keyed by the approval.
    const items = t.store.items('chat')
    for (const a of decided) {
      const at = items.findIndex((i) => i.id === `approval-${a.id}`)
      expect(items[at + 1]).toMatchObject({ kind: 'user', id: `answer-${a.id}`, approvalId: a.id })
      expect(items[at + 1]).not.toHaveProperty('from')
    }
    // Settling the same card again keeps one row.
    t.sessions.placeAnswer(decided[0])
    expect(t.users()).toHaveLength(5)
  })

  it('adds nothing for a tool permission, an expired card or a closed chat', async () => {
    const t = await setup()
    t.sessions.placeAnswer(t.approvals.decide(t.card('tool').id, { behavior: 'allow' })!)
    t.sessions.placeAnswer(t.approvals.decide(t.card('tool').id, { behavior: 'deny', message: 'Denied in Kernel.' })!)
    const plan = t.card('plan')
    t.sessions.placeAnswer(t.approvals.expireIds([plan.id], 'replaced')[0])
    const question = t.card('question')
    t.store.saveChat({ ...t.store.chat('chat')!, closed: true })
    t.sessions.placeAnswer(t.approvals.decide(question.id, { behavior: 'answer', text: 'S3' })!)
    expect(t.users()).toEqual([])
  })

  it("never sends the answer to the agent: Retry on the reply after it sends the user's message", async () => {
    const t = await setup()
    await t.sessions.send('chat', [{ type: 'text', text: 'Add a pdf_url column' }])
    const call = sdk.calls.at(-1)!
    call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    await flush()
    const answer = (call.options.canUseTool as CanUseTool)('AskUserQuestion', { questions: [{ question: 'Which store?', header: 'Store', multiSelect: false, options: [{ label: 'S3', description: '' }] }] }, { signal: new AbortController().signal, toolUseID: 'q1' } as never)
    const card = t.store.approvals({ pendingOnly: true })[0]
    t.sessions.placeAnswer(t.approvals.decide(card.id, { behavior: 'answer', text: 'S3' })!)
    // The agent gets the answer in the tool's own field, as before.
    expect(await answer).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which store?': 'S3' } } })
    call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Using S3.' }] } })
    call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 5 })
    await flush()
    const reply = t.store.items('chat').find((i) => i.kind === 'text')!
    await t.sessions.retry('chat', reply.id)
    await flush()
    expect(t.users().map((i) => i.kind === 'user' && (i.parts[0] as { text: string }).text)).toEqual(['Add a pdf_url column', 'S3', 'Add a pdf_url column'])
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
      accountFor: () => active, claudeEnv: () => ({ CLAUDE_CONFIG_DIR: `/homes/${active}` }),
      moveNote: (chat, from) => `Moved from ${from} to ${chat.ranOn}${chat.lastTurn ? `, ${chat.lastTurn.cacheWrite} written` : ''}`,
      emailOf: (_p, id) => (id ? `${id}@example.com` : undefined),
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
    // The move is noted once the turn on Personal ends.
    expect(t.notes()).toEqual([])
    await t.finish(next)
    expect(t.notes()).toEqual(['Moved from work to personal'])
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
    await t.finish(next)
    expect(t.notes()).toEqual(['Moved from work to personal'])
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
    await t.finish(next)
    expect(t.notes()).toEqual(['Moved from work to personal'])
  })

  const usage = (input: number, cacheRead: number, cacheWrite: number, output = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite })
  const reply = (call: (typeof sdk.calls)[number], uuid: string, u: ReturnType<typeof usage>) =>
    call.feed({ type: 'assistant', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done' }], usage: u }, session_id: 'session-1' })

  it('saves the turn\'s cache numbers as the chat\'s last turn, and notes a move with the move turn\'s numbers (KERNEL-842)', async () => {
    const t = await setup()
    const first = await t.start()
    reply(first, 'a1', usage(4, 20_000, 1_000, 30))
    first.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 5, usage: usage(4, 20_000, 1_000, 30) })
    await flush()
    expect(t.store.chat('chat')?.lastTurn).toMatchObject({ account: 'work', email: 'work@example.com', model: 'claude-sonnet-5-5', context: 21_034, input: 4, cacheRead: 20_000, cacheWrite: 1_000, first: { input: 4, cacheRead: 20_000, cacheWrite: 1_000 } })
    t.switchTo('personal')
    const next = await t.start('Run the tests')
    // Two calls: the first writes the whole chat to Personal's cache, the second reads it back. A subagent's call doesn't count.
    reply(next, 'a2', usage(10, 0, 300_000, 50))
    next.feed({ type: 'assistant', uuid: 'a-sub', parent_tool_use_id: 'task-1', message: { content: [], usage: usage(1, 0, 900_000), model: 'claude-haiku-4-5-20251001' }, session_id: 'session-1' })
    reply(next, 'a3', usage(5, 300_050, 200, 100))
    next.feed({ type: 'result', subtype: 'success', uuid: 'r2', duration_ms: 5, usage: usage(15, 300_050, 300_200, 150) })
    await flush()
    const turn = t.store.chat('chat')?.lastTurn
    expect(turn).toMatchObject({ account: 'personal', email: 'personal@example.com', context: 300_355, input: 15, cacheRead: 300_050, cacheWrite: 300_200, first: { input: 10, cacheRead: 0, cacheWrite: 300_000 } })
    expect(turn?.estimated).toBeUndefined()
    expect(t.notes()).toEqual(['Moved from work to personal, 300200 written'])
    // The note comes after the move turn's result row.
    expect(t.store.items('chat').at(-1)).toMatchObject({ kind: 'note' })
    expect(t.store.items('chat').at(-2)).toMatchObject({ kind: 'result', id: 'r2' })
  })
})

describe('a limit cut-off and its carry-on, for the Lead (KERNEL-777)', () => {
  afterEach(() => { bus.removeAllListeners('push') })
  const flush = () => new Promise((r) => setTimeout(r, 10))

  async function setup() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-limit-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const turns: Parameters<NonNullable<SessionDeps['onTurnDone']>>[2][] = []
    const carried: [string, CutOffReason][] = []
    const sessions = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => {},
      onTurnDone: (_ws, _chat, t) => { turns.push(t) }, onCarriedOn: (id, reason) => { carried.push([id, reason]) }
    })
    /** A turn a 5-hour rejection cuts off. */
    const cutOff = async () => {
      await sessions.send('chat', [{ type: 'text', text: 'Go' }])
      const call = sdk.calls.at(-1)!
      call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
      call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } })
      call.feed({ type: 'result', subtype: 'success', uuid: 'r-limit', duration_ms: 5 })
      await flush()
      return call
    }
    return { store, sessions, turns, carried, cutOff }
  }

  it('says a turn ended cut off by a limit, and an ordinary one not', async () => {
    const { sessions, turns, cutOff } = await setup()
    await cutOff()
    expect(turns.at(-1)).toMatchObject({ ok: true, limit: true })
    sessions.resetLimit('five_hour')
    sessions.drainWaiting()
    await flush()
    const call = sdk.calls.at(-1)!
    call.feed({ type: 'result', subtype: 'success', uuid: 'r-after', duration_ms: 5 })
    await flush()
    expect(turns.at(-1)).not.toHaveProperty('limit')
  })

  it('reports the carry-on when Kernel sends its nudge once the limit lifts', async () => {
    const { store, sessions, carried, cutOff } = await setup()
    await cutOff()
    expect(carried).toEqual([])
    sessions.resetLimit('five_hour')
    sessions.drainWaiting()
    expect(carried).toEqual([['chat', 'limit']])
    expect(store.items('chat').filter((i) => i.kind === 'user').pop()).toMatchObject({ parts: [{ type: 'text', text: LIMIT_LIFTED }] })
  })

  it('reports the carry-on when what waited in the chat goes instead of the nudge', async () => {
    const { store, sessions, carried, cutOff } = await setup()
    await cutOff()
    // The limit paused the room, as Kernel does, so the message waits in the chat.
    sessions.pause('room')
    expect(await sessions.send('chat', [{ type: 'text', text: 'Also add a test' }])).toMatchObject({ queued: true })
    sessions.resetLimit('five_hour')
    sessions.drainWaiting()
    expect(carried).toEqual([])
    sessions.resume('room')
    expect(carried).toEqual([['chat', 'limit']])
    expect(store.items('chat').filter((i) => i.kind === 'user').pop()).toMatchObject({ parts: [{ type: 'text', text: 'Also add a test' }] })
  })
})

describe("what an agent started, on Stop, Close chat and archive (KERNEL-810)", () => {
  const noor: AgentDef = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Noor.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const gone = async (pid: number) => { const t = Date.now(); while (alive(pid) && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 50)); return !alive(pid) }
  /** The pid a shell prints first: the `sleep` it left in the background, in the shell's process group. */
  const printed = (p: ChildProcess) => new Promise<number>((r) => p.stdout!.once('data', (d: Buffer) => r(Number(String(d).trim()))))
  const left: number[] = []
  afterEach(() => { for (const pid of left.splice(0)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })

  async function setup() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-tree-')), 'kernel.db'))
    store.saveWorkspace({ id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({ store, approvals: new Approvals(store), settings: () => settings, agentFor: () => noor, mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => {} })
    /** Runs a turn whose process is a real shell, started through Kernel's spawn, that leaves a `sleep` running. */
    const turn = async () => {
      await sessions.send('chat', [{ type: 'text', text: 'Start the dev server' }])
      const call = sdk.calls.at(-1)!
      // Started with the SDK's abort signal, so closing the session ends the shell, as it ends Claude Code.
      const proc = call.options.spawnClaudeCodeProcess!({ command: '/bin/sh', args: ['-c', 'sleep 300 & echo $!; wait'], env: process.env, signal: call.options.abortController!.signal }) as unknown as ChildProcess
      proc.on('error', () => undefined)
      const sleep = await printed(proc)
      left.push(sleep)
      call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
      call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 5 })
      await flush()
      return sleep
    }
    return { store, sessions, turn }
  }

  it('leaves it running when a turn ends or the chat stops without the tree, and ends it on a stop with the tree', async () => {
    const t = await setup()
    const sleep = await t.turn()
    expect(t.sessions.isRunning('chat')).toBe(false)
    expect(alive(sleep)).toBe(true)
    t.sessions.stop('chat', { tree: true })
    expect(await gone(sleep)).toBe(true)

    // An idle stop or a restart ends only the process, and a dev server it started keeps running.
    const next = await t.turn()
    t.sessions.stop('chat')
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(next)).toBe(true)
  })

  it('ends the process group of a process a crash left behind', async () => {
    const t = await setup()
    // A stand-in for the claude binary the test can name: sh, through a link (macOS kills a copied system binary).
    const claude = join(await mkdtemp(join(tmpdir(), 'kernel-pids-')), 'claude')
    await symlink('/bin/sh', claude)
    const leader = spawn(claude, ['-c', 'sleep 300 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    onTestFinished(() => { try { process.kill(-leader.pid!, 'SIGKILL') } catch { /* gone */ } })
    const sleep = await printed(leader)
    left.push(sleep)
    t.store.saveMeta('claudePids', [{ pid: leader.pid, command: claude, arg: '-c' }])
    expect(await t.sessions.endLeftovers()).toEqual([leader.pid])
    expect(await gone(sleep)).toBe(true)
  })

})

describe('long chats that move accounts, on Claude (KERNEL-844)', () => {
  afterEach(() => { bus.removeAllListeners('push'); sdk.calls = [] })
  const flush = () => new Promise((r) => setTimeout(r, 20))
  const MIN = 60_000
  const COMPACT = `/compact ${COMPACT_INSTRUCTIONS}`
  const KEY = 'sk-ant-api03-' + 'Ky3_'.repeat(20)
  const cipher = { encrypt: (t: string) => `enc:${[...t].reverse().join('')}`, decrypt: (d: string) => [...d.slice(4)].reverse().join('') }

  async function until<T>(check: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
    const end = Date.now() + ms
    for (;;) {
      const v = await check()
      if (v) return v as NonNullable<T>
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /**
   * A Kernel whose Claude has Work and Side, two subscription logins, and Key, an API key account, with Work in use, and the
   * chats `ids` in one workspace. Each process says which account it started on. `run` sends a message and answers every
   * message Kernel sends any process until nothing runs, with a result `answer` picks, and returns what each process was
   * sent, as `account: text`. `long` gives a chat a last turn on Work of `context` tokens, `ago` before now.
   */
  async function setUp(ids = ['a']) {
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    const bin = join(await mkdtemp(join(tmpdir(), 'kernel-bin-')), 'claude')
    await writeFile(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.292 (Claude Code)";; auth) echo '{"loggedIn":true,"email":"cj@example.com","subscriptionType":"max"}';; esac\n`)
    await chmod(bin, 0o755)
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home, cipher, fetch: (async () => new Response('{}')) as typeof fetch })
    await k.start()
    k.accountReader = async () => ({ signedIn: true, name: 'CJ', email: 'cj@example.com', subscriptionType: 'max' })
    await k.providers.setPath('claude', { path: bin })
    const p = k.providers as unknown as { load: () => { claude: { accounts: object[] } }; save: () => Promise<void> }
    for (const [id, label] of [['work', 'Work'], ['side', 'Side']]) p.load().claude.accounts.push({ id, label, home: k.providers.claudeHome(id), signedIn: true, createdAt: 1 })
    await p.save()
    const h = k.handlers()
    const key = (await h['accounts.addKey']({ provider: 'claude', label: 'Key', key: KEY })).id
    vi.spyOn(k.providers, 'claudeEnv').mockImplementation((id): Record<string, string> => (id === key ? { ANTHROPIC_API_KEY: KEY, ACCOUNT: 'key' } : { ACCOUNT: id ?? 'cli' }))
    await h['accounts.switch']({ provider: 'claude', accountId: 'work' })
    const repo = await tempRepo()
    const room = await k.addRoom(repo)
    k.store.saveWorkspace({ id: 'ws', roomId: room.id, name: 'w', branch: 'b', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    for (const id of ids) k.store.saveChat({ id, workspaceId: 'ws', title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } satisfies Chat)
    const answered = new Map<(typeof sdk.calls)[number], number>()
    const sent: string[] = []
    type Answer = (text: string, n: number) => Record<string, unknown> | undefined
    const ok: Answer = () => ({ subtype: 'success', usage: { input_tokens: 3_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } })
    /** Answers every message sent so far, then again, until nothing runs. An answer of undefined leaves the message unanswered. */
    const settle = async (answer: Answer = ok) => {
      for (let quiet = 0; quiet < 3;) {
        await flush()
        let fed = false
        for (const call of sdk.calls) {
          const done = answered.get(call) ?? 0
          if (call.sent.length <= done || call.options.abortController?.signal.aborted) continue
          if (!done) call.feed({ type: 'system', subtype: 'init', session_id: `session-${sdk.calls.indexOf(call)}`, apiKeySource: call.options.env?.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none' })
          const text = call.sent[done]
          sent.push(`${call.options.env?.ACCOUNT}: ${text === COMPACT ? '/compact' : text}`)
          answered.set(call, done + 1)
          const r = answer(text, done)
          if (r) call.feed({ type: 'result', uuid: `r-${sdk.calls.indexOf(call)}-${done}`, duration_ms: 5, ...r })
          fed = true
        }
        quiet = fed ? 0 : quiet + 1
      }
    }
    const run = async (chatId: string, text: string, answer?: Answer) => {
      sent.length = 0
      const r = await k.sessions.send(chatId, [{ type: 'text', text }])
      await settle(answer)
      return { ...r, sent: [...sent] }
    }
    const long = (chatId: string, context: number, ago = 0) => {
      const chat = k.store.chat(chatId)!
      const lastTurn: LastTurn = { at: Date.now() - ago, account: chat.ranOn ?? 'work', model: chat.model, context, input: 0, cacheRead: context, cacheWrite: 0 }
      k.store.saveChat({ ...chat, lastTurn })
    }
    const notes = (chatId: string) => k.store.items(chatId).flatMap((i) => (i.kind === 'note' ? [i.text] : []))
    const moveAll = (to: string) => h['accounts.switch']({ provider: 'claude', accountId: to, move: 'all' })
    return { k, h, key, room, run, settle, sent, long, notes, moveAll }
  }

  it('summarizes a long chat on the account it leaves while its cache there is warm, then moves it', async () => {
    const { k, run, long, notes, moveAll } = await setUp()
    await run('a', 'Start')
    long('a', 120_000)
    await moveAll('side')
    expect((await run('a', 'Next')).sent).toEqual(['work: /compact', 'side: Next'])
    expect(k.store.chat('a')?.ranOn).toBe('side')
    expect(notes('a')).toEqual(['Kernel is summarizing this chat on Work before it moves to Side, so the move reads the summary rather than the whole chat.', 'Moved to Side and re-read 3k tokens'])
    await k.stop({ budgetMs: 0 })
  })

  it('summarizes on the new account when the cache on the old one has gone cold, and continues or asks as Settings, Account says', async () => {
    const { k, h, room, run, long, notes, moveAll } = await setUp(['a', 'b', 'c'])
    for (const id of ['a', 'b', 'c']) { await run(id, 'Start'); long(id, 120_000, 2 * 60 * MIN) }
    await moveAll('side')
    expect((await run('a', 'Next')).sent).toEqual(['side: /compact', 'side: Next'])
    expect(notes('a')[0]).toBe('Kernel is summarizing this chat as it moves to Side, so later turns there read the summary rather than the whole chat.')

    await k.config.setSettings({ accounts: { longChatMove: { claude: 'continue' } } })
    expect((await run('b', 'Next')).sent).toEqual(['side: Next'])

    await k.config.setSettings({ accounts: { longChatMove: { claude: 'ask' } } })
    expect(await run('c', 'Next')).toMatchObject({ queued: false, sent: [] })
    expect(k.sessions.queueReason('c')).toBe('move')
    // What the user sends meanwhile waits behind it.
    expect(await k.sessions.send('c', [{ type: 'text', text: 'And this' }])).toEqual({ queued: true, why: 'move' })
    expect(k.sessions.queued('c').map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Next' }], [{ type: 'text', text: 'And this' }]])
    expect(k.store.notification(`n-move-ask-${room.id}`)).toMatchObject({ title: 'c waits to move to another account', needsYou: true, roomId: room.id })
    await h['chats.moveChoice']({ chatId: 'c', choice: 'summarize' })
    // `run` with no message: what the choice released.
    expect((await run('c', 'Last')).sent).toEqual(['side: /compact', 'side: Next', 'side: And this', 'side: Last'])
    expect(k.store.notification(`n-move-ask-${room.id}`)).toMatchObject({ needsYou: false })
    expect(k.store.chat('c')?.moveChoice).toBeUndefined()
    await k.stop({ budgetMs: 0 })
  })

  it('keeps a chat the user chose to keep on its account while that account can run it', async () => {
    const { k, h, run, long, moveAll } = await setUp()
    await k.config.setSettings({ accounts: { longChatMove: { claude: 'ask' } } })
    await run('a', 'Start')
    long('a', 120_000)
    await moveAll('side')
    await run('a', 'Next')
    expect(k.sessions.queueReason('a')).toBe('move')
    await h['chats.moveChoice']({ chatId: 'a', choice: 'keep' })
    expect((await run('a', 'Again')).sent).toEqual(['work: Next', 'work: Again'])
    // Work at its limit can't run it, so it moves after all, and asks again.
    long('a', 120_000)
    ;(k.sessions as unknown as { mergeLimits: (l: object[]) => void }).mergeLimits([{ type: 'five_hour', status: 'rejected', utilization: 1, accountId: 'work', resetsAt: Math.round(Date.now() / 1000) + 3600 }])
    await run('a', 'Later')
    expect(k.sessions.queueReason('a')).toBe('move')
    await k.stop({ budgetMs: 0 })
  })

  it("always asks before a long chat moves onto an API key, and always summarizes one that doesn't fit the new window", async () => {
    const { k, key, run, long, moveAll } = await setUp(['a', 'b'])
    for (const id of ['a', 'b']) await run(id, 'Start')
    long('a', 120_000)
    await moveAll(key)
    await run('a', 'Next')
    expect(k.sessions.queueReason('a')).toBe('move')
    k.sessions.stop('a')
    // Haiku's window is 200k, so a 250k chat is summarized whatever Settings, Account says.
    await k.config.setSettings({ accounts: { longChatMove: { claude: 'continue' } } })
    await moveAll('side')
    long('b', 250_000)
    k.store.saveChat({ ...k.store.chat('b')!, model: 'claude-haiku-4-5-20251001' })
    // The last turn ran on Sonnet, so nothing on Work is cached for Haiku: the summary runs on Side.
    expect((await run('b', 'Next')).sent).toEqual(['side: /compact', 'side: Next'])
    await k.stop({ budgetMs: 0 })
  })

  it('moves a chat switched twice before its next turn once, to where it goes last', async () => {
    const { k, key, run, long, notes, moveAll } = await setUp()
    await run('a', 'Start')
    long('a', 120_000)
    await moveAll('side')
    await moveAll(key)
    await moveAll('side')
    expect((await run('a', 'Next')).sent).toEqual(['work: /compact', 'side: Next'])
    expect(notes('a').filter((n) => n.startsWith('Moved'))).toEqual(['Moved to Side and re-read 3k tokens'])
    await k.stop({ budgetMs: 0 })
  })

  it('finishes a summary a switch lands in, and moves the chat to where it goes now without a second one', async () => {
    const { k, key, run, settle, sent, long, moveAll } = await setUp()
    await run('a', 'Start')
    long('a', 120_000)
    await moveAll('side')
    // The summary on Work runs, unanswered, while the provider moves on to Key.
    await run('a', 'Next', (text) => (text === COMPACT ? undefined : { subtype: 'success' }))
    expect(k.sessions.isRunning('a')).toBe(true)
    await moveAll(key)
    const compacting = sdk.calls.find((c) => c.sent.includes(COMPACT))!
    expect(compacting.options.abortController?.signal.aborted).toBe(false)
    compacting.feed({ type: 'result', subtype: 'success', uuid: 'r-compact', duration_ms: 5, usage: { input_tokens: 3_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } })
    sent.length = 0
    await settle()
    // Summarized, the chat is short, so the move to Key needs no answer and no second summary.
    expect(sent).toEqual(['key: Next'])
    expect(sdk.calls.filter((c) => c.sent.includes(COMPACT))).toHaveLength(1)
    await k.stop({ budgetMs: 0 })
  })

  it('summarizes a chat too long for its model and sends the message again, once', async () => {
    const { k, run, notes } = await setUp()
    await run('a', 'Start')
    const tooLong = { subtype: 'success', is_error: true, terminal_reason: 'prompt_too_long', result: 'Prompt is too long' }
    expect((await run('a', 'Next', (text, n) => (text === 'Next' && n === 1 ? tooLong : { subtype: 'success' }))).sent).toEqual(['work: Next', 'work: /compact', 'work: Next'])
    expect(notes('a')).toContain(TOO_LONG_NOTE)
    expect(k.store.items('a').filter((i) => i.kind === 'user').map((i) => i.kind === 'user' && i.parts)).toEqual([[{ type: 'text', text: 'Start' }], [{ type: 'text', text: 'Next' }]])
    // Too long again after the summary: the turn ends as it came.
    expect((await run('a', 'More', (text) => (text === 'More' ? tooLong : { subtype: 'success' }))).sent).toEqual(['work: More', 'work: /compact', 'work: More'])
    expect(k.sessions.isRunning('a')).toBe(false)
    await k.stop({ budgetMs: 0 })
  })
})

describe('cold re-reads start two at a time (KERNEL-844)', () => {
  afterEach(() => { sdk.calls = [] })
  const flush = () => new Promise((r) => setTimeout(r, 10))
  const noor: AgentDef = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Noor.' } as AgentDef
  const lead: AgentDef = { ...noor, id: 'lead', name: 'Lead', lead: true }

  it('holds the third cold chat, starts the smallest waiting one first, and never holds the Lead', async () => {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-cold-')), 'kernel.db'))
    const sizes: Record<string, number> = { big: 300_000, mid: 200_000, small: 50_000, tiny: 40_000, lead: 500_000 }
    for (const id of Object.keys(sizes)) {
      store.saveWorkspace({ id, roomId: 'room', name: id, branch: id, baseRef: 'main', path: `/tmp/${id}`, mode: 'worktree', agentId: id === 'lead' ? 'lead' : 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
      store.saveChat({ id, workspaceId: id, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, ranOn: 'work', createdAt: 1 })
    }
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: (ws) => (ws.agentId === 'lead' ? lead : noor), mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => {},
      accountFor: () => 'side', coldSize: (chat) => sizes[chat.id]
    })
    const started = () => sdk.calls.map((c) => c.options.cwd)
    const end = async (id: string) => { sdk.calls.find((c) => c.options.cwd === `/tmp/${id}`)!.feed({ type: 'result', subtype: 'success', uuid: `r-${id}`, duration_ms: 5 }); await flush() }
    for (const id of ['big', 'mid', 'small', 'tiny']) await sessions.send(id, [{ type: 'text', text: 'Go on' }])
    expect(await sessions.send('lead', [{ type: 'text', text: 'Go on' }])).toEqual({ queued: false })
    await flush()
    expect(started()).toEqual(['/tmp/big', '/tmp/mid', '/tmp/lead'])
    expect([sessions.queueReason('small'), sessions.queueReason('tiny')]).toEqual(['capacity', 'capacity'])
    await end('big')
    expect(started().at(-1)).toBe('/tmp/tiny')
    await end('lead')
    expect(started()).toHaveLength(4)
    await end('mid')
    expect(started().at(-1)).toBe('/tmp/small')
  })
})
