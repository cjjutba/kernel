import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, Options, Query, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, LastTurn, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { NO_PROMPTS } from '../src/main/services/exec'
import { bashVerdict, matchesProjectRule, projectRule } from '../src/main/services/bashGuard'
import { COMPACT_INSTRUCTIONS, IDLE_STOP_MS, LIMIT_LIFTED, limitsFromEvent, limitsFromUsage, mergeLimit, sessionEnv, SESSION_GONE_NOTE, Sessions, TOO_LONG_NOTE, type CutOffEntry, type CutOffReason, type LimitPatch, type SessionDeps } from '../src/main/services/sessions'
import { REJECT_HOLD_MS } from '../src/main/services/providers/limits'
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
  it('blocks Never allow, lets project rules beat Always ask, and leaves everything else to Claude Code', () => {
    expect(bashVerdict('git push origin main', lists, ['git push origin main'])).toBe('deny')
    expect(bashVerdict('pnpm drizzle-kit push', lists, [])).toBe('ask')
    expect(bashVerdict('pnpm drizzle-kit push', lists, ['pnpm drizzle-kit push'])).toBe('allow')
    expect(bashVerdict('npm test', lists, [])).toBeUndefined()
  })

  it('matches project rules the way Claude Code matches Bash rules', () => {
    expect(matchesProjectRule('git log --oneline -1', ['git log --oneline -1'])).toBe(true)
    expect(matchesProjectRule('git log --oneline -2', ['git log --oneline -1'])).toBe(false)
    expect(matchesProjectRule('git log', ['git log:*'])).toBe(true)
    expect(matchesProjectRule('git log -5', ['git log:*'])).toBe(true)
    expect(matchesProjectRule('git logs', ['git log:*'])).toBe(false)
  })

  it('never lets a prefix rule cover a chain with a command it does not cover (KERNEL-454)', () => {
    for (const c of ['npm run build && pnpm db:reset', 'npm run build; rm -rf dist', 'npm run build | sh', 'npm run build\ndrizzle-kit push', 'npm run build $(curl x)'])
      expect(matchesProjectRule(c, ['npm run build:*']), c).toBe(false)
    expect(bashVerdict('npm run build && pnpm db:reset', { neverAllow: [], alwaysAsk: ['pnpm db:reset'] }, ['npm run build:*'])).toBe('ask')
  })

  it("saves Claude Code's own suggestion when it has one, else the exact command", () => {
    expect(projectRule(' rm -rf dist ')).toBe('rm -rf dist')
    const one = [{ type: 'addRules' as const, behavior: 'allow' as const, destination: 'localSettings' as const, rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }] }]
    expect(projectRule('npm run build -- --watch', one)).toBe('npm run build:*')
    expect(projectRule('npm run build -- --watch', one, true)).toBe('npm run build -- --watch')
    const two = [{ ...one[0], rules: [{ toolName: 'Bash', ruleContent: 'cd:*' }, { toolName: 'Bash', ruleContent: 'npm run build:*' }] }]
    expect(projectRule('cd web && npm run build', two)).toBe('cd web && npm run build')
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

  it('lifts a rejection early when a reading shows clear project, and not on a reset time read back a second off', () => {
    const hit = { type: 'five_hour' as const, status: 'rejected' as const, utilization: 1, resetsAt: 1000 }
    expect(mergeLimit(hit, { type: 'five_hour', utilization: 0 }, 999_000).status).toBe('allowed')
    expect(mergeLimit(hit, { type: 'five_hour', utilization: 1, resetsAt: 1001 }, 999_000).status).toBe('rejected')
  })

  describe('a rejected window stays rejected until it lifts (KERNEL-1030)', () => {
    const hit = { type: 'five_hour' as const, status: 'rejected' as const, utilization: 1, resetsAt: 20_000, rejectedAt: 1_000_000 }
    const within = 1_000_000 + REJECT_HOLD_MS - 1
    const after = 1_000_000 + REJECT_HOLD_MS

    it("keeps it rejected on another session's allowed_warning event", () => {
      expect(mergeLimit(hit, { type: 'five_hour', status: 'allowed_warning', utilization: 0.8, resetsAt: 20_000 }, within).status).toBe('rejected')
      expect(mergeLimit(hit, { type: 'five_hour', status: 'allowed_warning', utilization: 0.97, resetsAt: 20_000 }, after).status).toBe('rejected')
    })

    it('keeps it rejected on a statusless 0.93 reading inside the hold', () => {
      expect(mergeLimit(hit, { type: 'five_hour', utilization: 0.93 }, within)).toMatchObject({ status: 'rejected', utilization: 1, rejectedAt: 1_000_000 })
    })

    it('lifts it on a 0.4 reading after the hold, with or without a status', () => {
      expect(mergeLimit(hit, { type: 'five_hour', utilization: 0.4 }, after)).toMatchObject({ status: 'allowed', utilization: 0.4 })
      expect(mergeLimit(hit, { type: 'five_hour', status: 'allowed', utilization: 0.4 }, after).status).toBe('allowed')
      expect(mergeLimit(hit, { type: 'five_hour', status: 'allowed', utilization: 0.97 }, after).status).toBe('rejected')
    })

    it('lifts it when the reset time passes, and ignores a later reset time before then', () => {
      expect(mergeLimit(hit, { type: 'five_hour', utilization: 0.99, resetsAt: 40_000 }, within).status).toBe('rejected')
      const passed = mergeLimit({ ...hit, resetsAt: 1001, rejectedAt: 1_000_000 }, { type: 'five_hour', utilization: 0.02 }, 1_001_001)
      expect(passed.status).toBe('allowed')
      expect(passed.rejectedAt).toBeUndefined()
    })

    it('stamps rejectedAt when a window becomes rejected and keeps it while it stands', () => {
      const first = mergeLimit({ type: 'five_hour', status: 'allowed', utilization: 0.9 }, { type: 'five_hour', status: 'rejected', resetsAt: 20_000 }, 500)
      expect(first.rejectedAt).toBe(500)
      expect(mergeLimit(first, { type: 'five_hour', status: 'rejected', resetsAt: 20_000 }, 900).rejectedAt).toBe(500)
    })

    it('holds a temporary window with no reset time for the same hold, then lifts it on a clear reading', () => {
      const temp = { type: 'five_hour' as const, status: 'rejected' as const, provisional: true, rejectedAt: 1_000_000 }
      expect(mergeLimit(temp, { type: 'five_hour', utilization: 0.2, resetsAt: 20_000 }, within).status).toBe('rejected')
      expect(mergeLimit(temp, { type: 'five_hour', utilization: 0.2, resetsAt: 20_000 }, after)).toMatchObject({ status: 'allowed' })
      expect(mergeLimit(temp, { type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: 20_000 }, within).provisional).toBeUndefined()
    })
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

describe('Always allow in this project', () => {
  it('saves the rule on the project once, and it survives a restart', async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n', '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    const open = () => new Kernel({ dataDir, home })
    const k = open()
    const project = await k.addProject(repo)
    const deps = (k.sessions as unknown as { d: SessionDeps }).d
    deps.allowInProject(project.id, 'git log --oneline -1')
    deps.allowInProject(project.id, 'git log --oneline -1')
    expect(deps.projectAllow(project.id)).toEqual(['git log --oneline -1'])
    await k.stop({ budgetMs: 0 })

    const again = open()
    expect(again.store.project(project.id)?.allow).toEqual(['git log --oneline -1'])
    await again.stop({ budgetMs: 0 })
  })
})

describe('idle stop (KERNEL-183)', () => {
  afterEach(() => { vi.useRealTimers(); bus.removeAllListeners('push'); bus.removeAllListeners('activity') })

  const sean: AgentDef = { id: 'sean', file: '.claude/agents/sean.md', name: 'Sean', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Sean.' } as AgentDef
  const kernel: AgentDef = { ...sean, id: 'kernel', name: 'Kernel', role: 'Lead', lead: true }
  // Lets the scripted stream reach Kernel. Fake timers move by a millisecond, which no idle clock notices.
  const flush = () => vi.advanceTimersByTimeAsync(1)

  async function setup(o: { agent?: AgentDef; agentLimit?: number } = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-idle-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', projectId: 'project', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: (o.agent ?? sean).id, port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat(chat)
    store.saveChat({ ...chat, id: 'other', title: 'Other' })
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: o.agentLimit ?? 0 } } as unknown as AppSettings
    const exits: string[] = []
    const cutOff: Record<string, CutOffEntry>[] = []
    const sessions = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: () => o.agent ?? sean, mcpFor: () => undefined,
      projectAllow: () => [], allowInProject: () => {}, onExit: (_ws, c) => { exits.push(c.id) }, onCutOff: (ids) => { cutOff.push(ids) }
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

  it('keeps the process while every project is held, offline or signed out, and stops it once the hold lifts', async () => {
    const { sessions, turn, stopped } = await setup()
    const call = await turn()
    sessions.holdAll('offline')
    await vi.advanceTimersByTimeAsync(3 * IDLE_STOP_MS)
    expect(stopped(call)).toBe(false)
    sessions.releaseAll('offline')
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(stopped(call)).toBe(true)
  })

  it('keeps the process while the project is paused, and stops it after the project resumes', async () => {
    const { sessions, turn, stopped } = await setup()
    const call = await turn()
    sessions.pause('project')
    await vi.advanceTimersByTimeAsync(3 * IDLE_STOP_MS)
    expect(stopped(call)).toBe(false)
    sessions.resume('project')
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
    expect(cutOff.at(-1)).toMatchObject({ chat: { reason: 'limit', account: 'cli' } })
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

    expect(sessions.post('chat', [{ type: 'text', text: 'Sean opened PR #12' }])).toBe(true)
    expect(sdk.calls.at(-1)!.options).toMatchObject({ resume: sid })
    expect(sessions.isRunning('chat')).toBe(true)
    expect(sessions.kernelTurn('chat')).toBe(true)
  })
})

describe('a card whose turn or session is gone, on Claude (KERNEL-563)', () => {
  afterEach(() => { bus.removeAllListeners('push') })

  const sean: AgentDef = { id: 'sean', file: '.claude/agents/sean.md', name: 'Sean', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Sean.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))
  type Call = (typeof sdk.calls)[number]

  async function setup() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-cards-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', projectId: 'project', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const approvals = new Approvals(store)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({ store, approvals, settings: () => settings, agentFor: () => sean, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {} })
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

  const sean: AgentDef = { id: 'sean', file: '.claude/agents/sean.md', name: 'Sean', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Sean.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))
  const image = { type: 'image' as const, name: 'mock.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', path: '.kernel/attachments/mock.png' }

  async function setup() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-answers-')), 'kernel.db'))
    store.saveWorkspace({ id: 'ws', projectId: 'project', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const approvals = new Approvals(store)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({ store, approvals, settings: () => settings, agentFor: () => sean, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {} })
    /** A card in the chat, placed as its process places one, then settled the way the user settles it. */
    const card = (kind: 'plan' | 'question' | 'agent' | 'tool') => {
      const { approval } = approvals.request({ kind, source: 'sdk', projectId: 'project', workspaceId: 'ws', chatId: 'chat', title: kind })
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

describe("a message keeps the id the window gave it (KERNEL-894)", () => {
  afterEach(() => { bus.removeAllListeners('push') })

  const sean: AgentDef = { id: 'sean', file: '.claude/agents/sean.md', name: 'Sean', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Sean.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))
  const text = (t: string) => [{ type: 'text' as const, text: t }]

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-ids-'))
    const store = new Store(join(dir, 'kernel.db'))
    store.saveWorkspace({ id: 'ws', projectId: 'project', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: dir, mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const approvals = new Approvals(store)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({ store, approvals, settings: () => settings, agentFor: () => sean, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {} })
    const users = () => store.items('chat').filter((i) => i.kind === 'user')
    const calls = sdk.calls.length
    /** The sessions this test started, so a turn can be ended. */
    const started = () => sdk.calls.slice(calls)
    const init = async () => { started().at(-1)!.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' }); await flush() }
    const endTurn = async () => { started().at(-1)!.feed({ type: 'result', subtype: 'success', uuid: `r${sdk.calls.length}-${users().length}`, duration_ms: 5 }); await flush() }
    return { store, sessions, users, started, init, endTurn }
  }

  it('gives a message sent without one a new id, as before, and its queued copy another', async () => {
    const t = await setup()
    const sent = await t.sessions.send('chat', text('Add a pdf_url column'))
    expect(sent.queued).toBe(false)
    expect(sent.item).toEqual(t.users()[0])
    await t.init()
    await t.sessions.send('chat', text('Then the index'))
    const [queued] = t.sessions.queued('chat')
    expect(queued).not.toHaveProperty('clientId')
    await t.endTurn()
    expect(t.users()).toHaveLength(2)
    expect(t.users()[1].id).not.toBe(queued.id)
  })

  it('saves the row under its id, with its images and skill as sent, and returns it', async () => {
    const t = await setup()
    const image = { type: 'image' as const, name: 'mock.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
    const parts = [{ type: 'skill' as const, name: 'review' }, ...text('Look at this'), image]
    const sent = await t.sessions.send('chat', parts, { clientId: 'c-1' })
    expect(sent).toMatchObject({ queued: false, item: { kind: 'user', id: 'c-1', parts } })
    // The image is saved to a file for the agent, and the row still holds the one the window drew.
    await vi.waitFor(() => expect(t.started().at(-1)!.sent.length).toBeGreaterThan(0))
    expect(t.users()).toEqual([expect.objectContaining({ id: 'c-1', parts })])
  })

  it('ignores a double send: one row, one turn, and the same row back', async () => {
    const t = await setup()
    const first = await t.sessions.send('chat', text('Add a pdf_url column'), { clientId: 'c-1' })
    const again = await t.sessions.send('chat', text('Add a pdf_url column'), { clientId: 'c-1' })
    expect(again).toEqual({ queued: false, item: first.item })
    expect(t.users()).toHaveLength(1)
    expect(t.started()).toHaveLength(1)
    expect(t.sessions.queued('chat')).toEqual([])
  })

  it('queues a message behind a running turn under its id, ignores it again, and posts it under the same id', async () => {
    const t = await setup()
    await t.sessions.send('chat', text('Add a pdf_url column'))
    await t.init()
    expect(await t.sessions.send('chat', text('Then the index'), { clientId: 'c-2' })).toEqual({ queued: true, why: 'running' })
    expect(await t.sessions.send('chat', text('Then the index'), { clientId: 'c-2' })).toEqual({ queued: true, why: 'running' })
    expect(t.sessions.queued('chat')).toEqual([expect.objectContaining({ id: 'c-2', clientId: 'c-2', parts: text('Then the index') })])
    await t.endTurn()
    expect(t.sessions.queued('chat')).toEqual([])
    expect(t.users().map((i) => i.id).at(-1)).toBe('c-2')
    expect(t.users()).toHaveLength(2)
  })

  it('holds a message for setup under its id and posts it under the same id when setup passes', async () => {
    const t = await setup()
    t.sessions.hold('chat', text('Plan it'), { clientId: 'c-3' })
    t.sessions.hold('chat', text('Plan it'), { clientId: 'c-3' })
    expect(t.sessions.queued('chat').map((q) => q.id)).toEqual(['c-3'])
    t.sessions.release('chat')
    expect(t.users()).toEqual([expect.objectContaining({ id: 'c-3', parts: text('Plan it') })])
  })

  it('sends a queued message now under the id Send now gives it', async () => {
    const t = await setup()
    await t.sessions.send('chat', text('Add a pdf_url column'))
    await t.init()
    await t.sessions.send('chat', text('Use the staging bucket'))
    const queue = await t.sessions.sendNow('chat', t.sessions.queued('chat')[0].id, { clientId: 'c-4' })
    expect(queue).toEqual([expect.objectContaining({ id: 'c-4', clientId: 'c-4' })])
    await t.endTurn()
    expect(t.users().at(-1)).toMatchObject({ id: 'c-4', parts: text('Use the staging bucket') })
  })

  it('sends Retry under its id, and Retry while a turn runs waits under it', async () => {
    const t = await setup()
    const { item } = await t.sessions.send('chat', text('Add a pdf_url column'))
    await t.init()
    await t.endTurn()
    await t.sessions.retry('chat', item!.id, 'c-5')
    expect(t.users().map((i) => i.id)).toEqual([item!.id, 'c-5'])
    await t.init()
    expect(await t.sessions.retry('chat', item!.id, 'c-6')).toMatchObject({ id: 'c-6', clientId: 'c-6' })
    // The same Retry again is a double send.
    expect(await t.sessions.retry('chat', item!.id, 'c-6')).toMatchObject({ id: 'c-6' })
    expect(t.sessions.queued('chat')).toHaveLength(1)
    await t.endTurn()
    expect(t.users().map((i) => i.id)).toEqual([item!.id, 'c-5', 'c-6'])
  })
})

describe('switching accounts while a chat waits on the user, on Claude (KERNEL-618)', () => {
  afterEach(() => { bus.removeAllListeners('push') })

  const sean: AgentDef = { id: 'sean', file: '.claude/agents/sean.md', name: 'Sean', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Sean.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))

  /** A chat on Work, a Claude account whose folder each process gets, and `switchTo`, which does what `Providers.switchTo` asks of Sessions. */
  async function setup(o: { plan?: boolean } = {}) {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-switch-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', projectId: 'project', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: !!o.plan, createdAt: 1 })
    const approvals = new Approvals(store)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: ['pnpm build'], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    let active = 'work'
    const failures: { failure: string; account: string | undefined }[] = []
    const sessions = new Sessions({
      store, approvals, settings: () => settings, agentFor: () => sean, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {},
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

  async function setup(o: { chats?: string[]; accountFor?: SessionDeps['accountFor'] } = {}) {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-limit-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', projectId: 'project', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    store.saveWorkspace(ws)
    // Each chat has a folder of its own: chats that share one take turns (one-writer-per-folder), and these are about the limit.
    for (const id of (o.chats ?? ['chat']).slice(1)) store.saveWorkspace({ ...ws, id: `ws-${id}`, path: `/tmp/ws-${id}` })
    for (const [i, id] of (o.chats ?? ['chat']).entries()) store.saveChat({ id, workspaceId: i ? `ws-${id}` : 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const turns: Parameters<NonNullable<SessionDeps['onTurnDone']>>[2][] = []
    const carried: [string, CutOffReason][] = []
    const sessions = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {},
      onTurnDone: (_ws, _chat, t) => { turns.push(t) }, onCarriedOn: (id, reason) => { carried.push([id, reason]) },
      ...(o.accountFor ? { accountFor: o.accountFor } : {})
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

  const clean = async (call: { feed: (m: unknown) => void }, uuid: string) => {
    call.feed({ type: 'result', subtype: 'success', uuid, duration_ms: 5 })
    await flush()
  }
  /** A turn the limit refuses at once: Claude Code's rejection, then a result whose reply is the limit's text. */
  const refuse = async (call: { feed: (m: unknown) => void }, uuid: string) => {
    call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } })
    call.feed({ type: 'result', subtype: 'success', uuid, duration_ms: 5 })
    await flush()
  }
  const nudges = (call: { sent: string[] }) => call.sent.filter((t) => t === LIMIT_LIFTED).length

  it('reports the carry-on when the nudge gets its first clean reply, not when it is sent', async () => {
    const { store, sessions, carried, cutOff } = await setup()
    const call = await cutOff()
    expect(carried).toEqual([])
    sessions.resetLimit('five_hour')
    sessions.drainWaiting()
    expect(carried).toEqual([])
    await clean(call, 'r-after')
    expect(carried).toEqual([['chat', 'limit']])
    expect(store.items('chat').filter((i) => i.kind === 'user').pop()).toMatchObject({ parts: [{ type: 'text', text: LIMIT_LIFTED }] })
  })

  it('reports the carry-on when what waited in the chat goes instead of the nudge', async () => {
    const { store, sessions, carried, cutOff } = await setup()
    await cutOff()
    // The limit paused the project, as Kernel does, so the message waits in the chat.
    sessions.pause('project')
    expect(await sessions.send('chat', [{ type: 'text', text: 'Also add a test' }])).toMatchObject({ queued: true })
    sessions.resetLimit('five_hour')
    sessions.drainWaiting()
    expect(carried).toEqual([])
    sessions.resume('project')
    expect(carried).toEqual([])
    await clean(sdk.calls.at(-1)!, 'r-queued')
    expect(carried).toEqual([['chat', 'limit']])
    expect(store.items('chat').filter((i) => i.kind === 'user').pop()).toMatchObject({ parts: [{ type: 'text', text: 'Also add a test' }] })
  })
  it('carries on a chat whose limited turn ended while its window looked lifted', async () => {
    const { sessions, carried, store } = await setup()
    await sessions.send('chat', [{ type: 'text', text: 'Go' }])
    const call = sdk.calls.at(-1)!
    call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    call.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } })
    await flush()
    sessions.resetLimit('five_hour')
    call.feed({ type: 'result', subtype: 'success', uuid: 'r-limit', duration_ms: 5 })
    await flush()
    expect(store.items('chat').filter((i) => i.kind === 'result')).toMatchObject([{ id: 'r-limit', limit: true }])
    sessions.drainWaiting()
    await flush()
    expect(nudges(call)).toBe(1)
    await clean(call, 'r-after')
    expect(carried).toEqual([['chat', 'limit']])
  })

  it('carries a chat on on the other account after a switch, with chats kept on their account, and ends its idle process', async () => {
    let active: string | undefined = 'a'
    const home = 'a'
    let rejected = new Set<string>()
    const { sessions, carried, cutOff } = await setup({ accountFor: () => (!rejected.has(home) ? home : active) })
    const call = await cutOff()
    const first = (sessions as unknown as { live: Map<string, { account?: string; tasks: Set<string>; runner: { closed: boolean } }> }).live.get('chat')!
    expect(first.account).toBe('a')
    first.tasks.add('background-shell')
    rejected = new Set([home])
    active = 'b'
    sessions.restartProvider('claude', { moved: true })
    sessions.drainWaiting()
    await flush()
    expect(first.runner.closed).toBe(true)
    const live = (sessions as unknown as { live: Map<string, { account?: string }> }).live.get('chat')!
    expect(live.account).toBe('b')
    const next = sdk.calls.at(-1)!
    expect(next).not.toBe(call)
    expect(nudges(next)).toBe(1)
    await clean(next, 'r-b')
    expect(carried).toEqual([['chat', 'limit']])
  })

  it('replays 15:03: three chats on one account, refused nudges, then a switch carries every chat on once, on the new account', async () => {
    let active: string | undefined = 'a'
    const ids = ['c1', 'c2', 'c3']
    let aFull = false
    const { sessions, carried, turns } = await setup({ chats: ids, accountFor: () => (aFull ? active : 'a') })
    const calls = new Map<string, { feed: (m: unknown) => void; sent: string[] }>()
    for (const id of ids) {
      await sessions.send(id, [{ type: 'text', text: 'Go' }])
      const call = sdk.calls.at(-1)!
      calls.set(id, call)
      call.feed({ type: 'system', subtype: 'init', session_id: `s-${id}`, apiKeySource: 'none' })
    }
    const reset = Math.floor(Date.now() / 1000) + 3600
    for (const id of ids) {
      calls.get(id)!.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset } })
      calls.get('c1')!.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4 } })
    }
    for (const id of ids) calls.get(id)!.feed({ type: 'result', subtype: 'success', uuid: `r-${id}`, duration_ms: 5 })
    await flush()
    expect(turns.filter((t) => t.limit)).toHaveLength(3)
    sessions.resetLimit('five_hour')
    sessions.drainWaiting()
    await flush()
    const refusedCalls = new Set<unknown>()
    for (const id of ids.filter((i) => nudges(calls.get(i)!) > 0)) { refusedCalls.add(calls.get(id)); await refuse(calls.get(id)!, `refused-${id}`) }
    expect(carried).toEqual([])
    aFull = true
    active = 'b'
    sessions.restartProvider('claude', { moved: true })
    sessions.drainWaiting()
    const answered = new Set<unknown>()
    for (let round = 0; round < 3; round++) {
      await flush()
      for (const call of sdk.calls.filter((c) => c.sent.includes(LIMIT_LIFTED) && !answered.has(c) && !refusedCalls.has(c))) { answered.add(call); await clean(call, `ok-${round}-${answered.size}`) }
      sessions.drainWaiting()
    }
    expect([...carried].sort()).toEqual(ids.map((id) => [id, 'limit']))
    for (const id of ids) expect((sessions as unknown as { live: Map<string, { account?: string }> }).live.get(id)?.account).toBe('b')
  })

  it('stops nudging after three instant refusals, tells the Lead once, and never reports a refused turn as carried on', async () => {
    const { sessions, carried, turns, store, cutOff } = await setup()
    const call = await cutOff()
    for (let i = 1; i <= 3; i++) {
      sessions.resetLimit('five_hour')
      sessions.drainWaiting()
      await flush()
      expect(nudges(call)).toBe(i)
      await refuse(call, `refused-${i}`)
    }
    expect(carried).toEqual([])
    expect(turns.filter((t) => t.limit && (!t.refused || t.stuck)).map((t) => !!t.stuck)).toEqual([false, true])
    expect(store.items('chat').filter((i) => i.kind === 'user' && i.parts.some((p) => p.type === 'text' && p.text === LIMIT_LIFTED))).toHaveLength(1)
    expect(store.items('chat').filter((i) => i.kind === 'result' && i.limit)).toHaveLength(2)
    ;(sessions as unknown as { limits: Map<string, unknown> }).limits.clear()
    sessions.drainWaiting()
    await flush()
    expect(nudges(call)).toBe(3)
    ;(sessions as unknown as { mergeLimits: (p: object[]) => void }).mergeLimits([{ type: 'five_hour', status: 'rejected', provider: 'claude', resetsAt: Math.floor(Date.now() / 1000) + 3600 }])
    sessions.resetLimit('five_hour')
    sessions.drainWaiting()
    await flush()
    expect(nudges(call)).toBe(4)
    await clean(call, 'r-fine')
    expect(carried).toEqual([['chat', 'limit']])
  })

  it('still reads the old saved forms of the carry-on list', async () => {
    const { sessions, carried } = await setup({ chats: ['chat', 'old'] })
    sessions.restore([], { chat: 'limit', old: { reason: 'limit', account: 'cli', at: 1 } })
    await flush()
    expect(sdk.calls.slice(-2).map((c) => nudges(c))).toEqual([1, 1])
    expect(carried).toEqual([])
  })

})

describe("what an agent started, on Stop, Close chat and archive (KERNEL-810)", () => {
  const sean: AgentDef = { id: 'sean', file: '.claude/agents/sean.md', name: 'Sean', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Sean.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const gone = async (pid: number) => { const t = Date.now(); while (alive(pid) && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 50)); return !alive(pid) }
  /** The pid a shell prints first: the `sleep` it left in the background, in the shell's process group. */
  const printed = (p: ChildProcess) => new Promise<number>((r) => p.stdout!.once('data', (d: Buffer) => r(Number(String(d).trim()))))
  const left: number[] = []
  afterEach(() => { for (const pid of left.splice(0)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })

  async function setup() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-tree-')), 'kernel.db'))
    store.saveWorkspace({ id: 'ws', projectId: 'project', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({ store, approvals: new Approvals(store), settings: () => settings, agentFor: () => sean, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {} })
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
    k.accountReader = async () => ({ signedIn: true, name: 'Sam', email: 'cj@example.com', subscriptionType: 'max' })
    await k.providers.setPath('claude', { path: bin })
    const p = k.providers as unknown as { load: () => { claude: { accounts: object[] } }; save: () => Promise<void> }
    for (const [id, label] of [['work', 'Work'], ['side', 'Side']]) p.load().claude.accounts.push({ id, label, home: k.providers.claudeHome(id), signedIn: true, createdAt: 1 })
    await p.save()
    const h = k.handlers()
    const key = (await h['accounts.addKey']({ provider: 'claude', label: 'Key', key: KEY })).id
    vi.spyOn(k.providers, 'claudeEnv').mockImplementation((id): Record<string, string> => (id === key ? { ANTHROPIC_API_KEY: KEY, ACCOUNT: 'key' } : { ACCOUNT: id ?? 'cli' }))
    await h['accounts.switch']({ provider: 'claude', accountId: 'work' })
    const repo = await tempRepo()
    const project = await k.addProject(repo)
    k.store.saveWorkspace({ id: 'ws', projectId: project.id, name: 'w', branch: 'b', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
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
          if (text === COMPACT) call.feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 139_000, post_tokens: 8_000 }, uuid: `c-${sdk.calls.indexOf(call)}-${done}`, session_id: 's' })
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
    return { k, h, key, project, run, settle, sent, long, notes, moveAll }
  }

  it('summarizes a long chat on the account it leaves while its cache there is warm, then moves it', async () => {
    const { k, run, long, notes, moveAll } = await setUp()
    await run('a', 'Start')
    long('a', 120_000)
    await moveAll('side')
    expect((await run('a', 'Next')).sent).toEqual(['work: /compact', 'side: Next'])
    expect(k.store.chat('a')?.ranOn).toBe('side')
    // One note: the summarizing one, replaced in place by the move's, with the compaction folded in.
    expect(notes('a')).toEqual(['Moved to Side, summarized from 139k to 8k tokens'])
    await k.stop({ budgetMs: 0 })
  })

  it('summarizes on the new account when the cache on the old one has gone cold, and continues or asks as Settings, Account says', async () => {
    const { k, h, project, run, long, notes, moveAll } = await setUp(['a', 'b', 'c'])
    for (const id of ['a', 'b', 'c']) { await run(id, 'Start'); long(id, 120_000, 2 * 60 * MIN) }
    await moveAll('side')
    expect((await run('a', 'Next')).sent).toEqual(['side: /compact', 'side: Next'])
    expect(notes('a')).toEqual(['Moved to Side, summarized from 139k to 8k tokens'])

    await k.config.setSettings({ accounts: { longChatMove: { claude: 'continue' } } })
    expect((await run('b', 'Next')).sent).toEqual(['side: Next'])
    expect(notes('b')).toEqual(['Moved to Side and re-read 3k tokens'])

    await k.config.setSettings({ accounts: { longChatMove: { claude: 'ask' } } })
    expect(await run('c', 'Next')).toMatchObject({ queued: false, sent: [] })
    expect(k.sessions.queueReason('c')).toBe('move')
    // What the user sends meanwhile waits behind it.
    expect(await k.sessions.send('c', [{ type: 'text', text: 'And this' }])).toEqual({ queued: true, why: 'move' })
    expect(k.sessions.queued('c').map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Next' }], [{ type: 'text', text: 'And this' }]])
    expect(k.store.notification(`n-move-ask-${project.id}`)).toMatchObject({ title: 'c waits to move to another account', needsYou: true, projectId: project.id })
    await h['chats.moveChoice']({ chatId: 'c', choice: 'summarize' })
    // `run` with no message: what the choice released.
    expect((await run('c', 'Last')).sent).toEqual(['side: /compact', 'side: Next', 'side: And this', 'side: Last'])
    expect(k.store.notification(`n-move-ask-${project.id}`)).toMatchObject({ needsYou: false })
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
    // The fake CLI signs every account in as one email, so they would share a window; this test has Side free.
    vi.spyOn(k.providers, 'sameLoginAccounts').mockReturnValue([])
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
    expect(notes('a').filter((n) => n.startsWith('Moved'))).toEqual(['Moved to Side, summarized from 139k to 8k tokens'])
    await k.stop({ budgetMs: 0 })
  })

  it("keeps a compaction outside a move as its own note, and a stale summary doesn't swallow it", async () => {
    const { k, run, settle, notes } = await setUp()
    await run('a', 'Start')
    const done = k.sessions.compactIdle('a', 'work')
    await settle()
    expect(await done).toBe(true)
    expect(notes('a')).toEqual(['Compacted the conversation, 139k to 8k tokens.'])
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
  const sean: AgentDef = { id: 'sean', file: '.claude/agents/sean.md', name: 'Sean', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Sean.' } as AgentDef
  const lead: AgentDef = { ...sean, id: 'lead', name: 'Lead', lead: true }

  it('holds the third cold chat, starts the smallest waiting one first, and never holds the Lead', async () => {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-cold-')), 'kernel.db'))
    const sizes: Record<string, number> = { big: 300_000, mid: 200_000, small: 50_000, tiny: 40_000, lead: 500_000 }
    for (const id of Object.keys(sizes)) {
      store.saveWorkspace({ id, projectId: 'project', name: id, branch: id, baseRef: 'main', path: `/tmp/${id}`, mode: 'worktree', agentId: id === 'lead' ? 'lead' : 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
      store.saveChat({ id, workspaceId: id, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, ranOn: 'work', createdAt: 1 })
    }
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: (ws) => (ws.agentId === 'lead' ? lead : sean), mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {},
      accountFor: () => 'side', coldSize: (chat) => sizes[chat.id]
    })
    const started = () => sdk.calls.map((c) => c.options.cwd)
    const end = async (id: string) => { sdk.calls.find((c) => c.options.cwd === `/tmp/${id}`)!.feed({ type: 'result', subtype: 'success', uuid: `r-${id}`, duration_ms: 5 }); await flush() }
    for (const id of ['big', 'mid', 'small', 'tiny']) await sessions.send(id, [{ type: 'text', text: 'Go on' }], { from: 'kernel' })
    expect(await sessions.send('lead', [{ type: 'text', text: 'Go on' }])).toMatchObject({ queued: false })
    await flush()
    expect(started()).toEqual(['/tmp/big', '/tmp/mid', '/tmp/lead'])
    expect([sessions.queueReason('small'), sessions.queueReason('tiny')]).toEqual(['moving', 'moving'])
    await end('big')
    expect(started().at(-1)).toBe('/tmp/tiny')
    await end('lead')
    expect(started()).toHaveLength(4)
    await end('mid')
    expect(started().at(-1)).toBe('/tmp/small')
  })

  async function cold(agentLimit = 0) {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-cold-')), 'kernel.db'))
    for (const id of ['a', 'b', 'c']) {
      store.saveWorkspace({ id, projectId: 'project', name: id, branch: id, baseRef: 'main', path: `/tmp/${id}`, mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
      store.saveChat({ id, workspaceId: id, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, ranOn: 'work', createdAt: 1 })
    }
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit } } as unknown as AppSettings
    const sessions = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: () => sean, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {},
      accountFor: () => 'side', coldSize: () => 100_000
    })
    const text = (t: string) => [{ type: 'text' as const, text: t }]
    return { sessions, text, started: () => sdk.calls.map((c) => c.options.cwd) }
  }

  it('sends the user\'s message at once while two others re-read', async () => {
    const { sessions, text, started } = await cold()
    await sessions.send('a', text('Go on'))
    await sessions.send('b', text('Go on'))
    expect(await sessions.send('c', text('From the user'))).toMatchObject({ queued: false })
    await flush()
    expect(started()).toEqual(['/tmp/a', '/tmp/b', '/tmp/c'])
  })

  it('sends the Lead\'s message at once while two others re-read', async () => {
    const { sessions, text, started } = await cold()
    await sessions.send('a', text('Go on'))
    await sessions.send('b', text('Go on'))
    expect(await sessions.send('c', text('From the Lead'), { from: 'lead' })).toMatchObject({ queued: false })
    await flush()
    expect(started()).toEqual(['/tmp/a', '/tmp/b', '/tmp/c'])
  })

  it('holds Kernel\'s carry-on as moving, and sends it with Send now', async () => {
    const { sessions, text, started } = await cold()
    await sessions.send('a', text('Go on'))
    await sessions.send('b', text('Go on'))
    expect(sessions.postHold('c')).toBe('moving')
    expect(await sessions.send('c', text('Carry on'), { from: 'kernel' })).toMatchObject({ queued: true, why: 'moving' })
    expect(sessions.queueReason('c')).toBe('moving')
    expect(started()).toEqual(['/tmp/a', '/tmp/b'])
    await sessions.sendNow('c', sessions.queued('c')[0].id)
    await flush()
    expect(started()).toEqual(['/tmp/a', '/tmp/b', '/tmp/c'])
  })

  it('still says capacity when the agent limit is reached', async () => {
    const { sessions, text } = await cold(2)
    await sessions.send('a', text('Go on'))
    await sessions.send('b', text('Go on'))
    expect(sessions.postHold('c')).toBe('capacity')
    expect(await sessions.send('c', text('Carry on'), { from: 'kernel' })).toMatchObject({ queued: true, why: 'capacity' })
  })
})

describe('one writer per folder (one-writer-per-folder)', () => {
  afterEach(() => { sdk.calls = [] })
  const flush = () => new Promise((r) => setTimeout(r, 10))
  const sean: AgentDef = { id: 'sean', file: '.claude/agents/sean.md', name: 'Sean', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Sean.' } as AgentDef
  const text = (t: string) => [{ type: 'text' as const, text: t }]

  /**
   * Chats `a`, `b` and `c` are tabs of workspace `w1`, whose folder is real. `linked` is a chat of `w2`, another record whose
   * path is a symlink to the same folder, and `d` is a chat of `w3`, a folder of its own.
   */
  async function setup(agentLimit = 0) {
    const root = await mkdtemp(join(tmpdir(), 'kernel-folder-'))
    const dir = join(root, 'shared')
    const other = join(root, 'other')
    await Promise.all([mkdir(dir), mkdir(other)])
    await symlink(dir, join(root, 'link'))
    const store = new Store(join(root, 'kernel.db'))
    const ws = (id: string, path: string) => store.saveWorkspace({ id, projectId: 'project', name: id, branch: id, baseRef: 'main', path, mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    ws('w1', dir)
    ws('w2', join(root, 'link'))
    ws('w3', other)
    const chat = (id: string, workspaceId: string, extra: Partial<Chat> = {}) => store.saveChat({ id, workspaceId, title: `Chat ${id}`, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, ranOn: 'work', createdAt: 1, ...extra })
    chat('a', 'w1'); chat('b', 'w1'); chat('c', 'w1'); chat('linked', 'w2'); chat('d', 'w3')
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit } } as unknown as AppSettings
    const state = { freed: 0 }
    const make = () => new Sessions({ store, approvals: new Approvals(store), settings: () => settings, agentFor: () => sean, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {}, onFreed: () => { state.freed++ } })
    const sessions = make()
    const started = () => sdk.calls.length
    /** Ends the turn of the nth process that started. */
    const finish = async (n: number) => { sdk.calls[n].feed({ type: 'result', subtype: 'success', uuid: `r-${n}`, duration_ms: 5 }); await flush() }
    return { store, sessions, make, chat, state, started, finish }
  }

  it('holds a second tab in the folder until the first turn ends, then sends it', async () => {
    const t = await setup()
    expect(await t.sessions.send('a', text('First'))).toMatchObject({ queued: false })
    expect(await t.sessions.send('b', text('Second'))).toEqual({ queued: true, why: 'folder' })
    expect(t.sessions.queueReason('b')).toBe('folder')
    expect(t.sessions.folderBlocker('b')).toBe('a')
    await flush()
    expect(t.started()).toBe(1)
    await t.finish(0)
    expect(t.started()).toBe(2)
    expect(t.sessions.queued('b')).toEqual([])
    expect(t.sessions.isRunning('b')).toBe(true)
  })

  it('counts a symlinked path as the same folder, and a folder of its own as free', async () => {
    const t = await setup()
    await t.sessions.send('a', text('First'))
    expect(await t.sessions.send('linked', text('Same folder'))).toMatchObject({ queued: true, why: 'folder' })
    expect(await t.sessions.send('d', text('Elsewhere'))).toMatchObject({ queued: false })
    await flush()
    expect(t.sessions.isRunning('d')).toBe(true)
  })

  it('serves the chats that waited in the order they waited', async () => {
    const t = await setup()
    await t.sessions.send('a', text('First'))
    await t.sessions.send('b', text('Second'))
    await t.sessions.send('c', text('Third'))
    await t.finish(0)
    expect([t.sessions.isRunning('b'), t.sessions.isRunning('c'), t.sessions.queueReason('c')]).toEqual([true, false, 'folder'])
    await t.finish(1)
    expect(t.sessions.isRunning('c')).toBe(true)
  })

  it('does not hold a chat for itself: its own turn is a running queue, not a folder hold', async () => {
    const t = await setup()
    await t.sessions.send('a', text('First'))
    expect(await t.sessions.send('a', text('Again'))).toEqual({ queued: true, why: 'running' })
    expect(t.sessions.folderBlocker('a')).toBeUndefined()
    await t.finish(0)
    expect(t.sessions.queued('a')).toEqual([])
  })

  it('lets a plan mode chat run beside a writer, and never lets one hold a writer up', async () => {
    const t = await setup()
    t.chat('plan', 'w1', { plan: true })
    await t.sessions.send('plan', text('Think'))
    expect(await t.sessions.send('a', text('Write'))).toMatchObject({ queued: false })
    await t.sessions.send('c', text('Think more'))
    t.chat('plan2', 'w1', { plan: true })
    expect(await t.sessions.send('plan2', text('Think too'))).toMatchObject({ queued: false })
    await flush()
    expect(['plan', 'a', 'plan2'].map((id) => t.sessions.isRunning(id))).toEqual([true, true, true])
    expect(t.sessions.queueReason('c')).toBe('folder')
  })

  it('lets read-only review chats run side by side in their folder', async () => {
    const t = await setup()
    t.chat('code', 'w1', { lens: { kind: 'code' } } as Partial<Chat>)
    t.chat('ux', 'w1', { lens: { kind: 'ux' } } as Partial<Chat>)
    await t.sessions.send('code', text('Review'))
    expect(await t.sessions.send('ux', text('Review'))).toMatchObject({ queued: false })
    expect(await t.sessions.send('a', text('Write'))).toMatchObject({ queued: false })
  })

  it('does not hold a terminal, which is no agent turn', async () => {
    const t = await setup()
    t.chat('term', 'w1', { kind: 'terminal' })
    expect(t.sessions.folderBlocker('term')).toBeUndefined()
    await t.sessions.send('a', text('First'))
    expect(t.sessions.folderBlocker('term')).toBeUndefined()
  })

  it('frees the folder when the running turn is stopped or its process dies', async () => {
    const t = await setup()
    await t.sessions.send('a', text('First'))
    await t.sessions.send('b', text('Second'))
    t.sessions.stop('a')
    await flush()
    expect(t.sessions.isRunning('b')).toBe(true)
    await t.sessions.send('c', text('Third'))
    expect(t.sessions.queueReason('c')).toBe('folder')
    sdk.calls[sdk.calls.length - 1].end()
    await flush()
    expect(t.sessions.isRunning('c')).toBe(true)
    expect(t.sessions.queued('c')).toEqual([])
  })

  it('does not wait on a held chat that is closed, removed or stopped', async () => {
    const t = await setup()
    await t.sessions.send('a', text('First'))
    await t.sessions.send('b', text('Second'))
    await t.sessions.send('c', text('Third'))
    // b waited first. Closing it moves c to the front, and c does not wait for b's message.
    t.sessions.stop('b', { tree: true })
    expect(t.sessions.queued('b')).toEqual([])
    expect(t.sessions.folderBlocker('c')).toBe('a')
    await t.finish(0)
    expect(t.sessions.isRunning('c')).toBe(true)
    // Taking the message out of a held chat's tray does the same.
    await t.sessions.send('b', text('Fourth'))
    expect(t.sessions.queueReason('b')).toBe('folder')
    await t.sessions.send('a', text('Fifth'))
    expect(t.sessions.folderBlocker('a')).toBe('c')
    t.sessions.unqueue('b', t.sessions.queued('b')[0].id)
    expect(t.sessions.folderBlocker('a')).toBe('c')
    await t.finish(1)
    expect(t.sessions.isRunning('a')).toBe(true)
  })

  it('holds Kernel\'s own message the same way and tells onFreed when the folder frees', async () => {
    const t = await setup()
    await t.sessions.send('a', text('First'))
    expect(t.sessions.postHold('b')).toBe('folder')
    expect(t.sessions.post('b', text('An update'))).toBe(false)
    expect(await t.sessions.send('b', text('Carry on'), { from: 'kernel' })).toMatchObject({ queued: true, why: 'folder' })
    const before = t.state.freed
    await t.finish(0)
    expect(t.state.freed).toBeGreaterThan(before)
    expect(t.sessions.isRunning('b')).toBe(true)
  })

  it('does not let Send now write beside another chat in the folder', async () => {
    const t = await setup()
    await t.sessions.send('a', text('First'))
    await t.sessions.send('b', text('Second'))
    await t.sessions.sendNow('b', t.sessions.queued('b')[0].id)
    await flush()
    expect(t.started()).toBe(1)
    expect(t.sessions.queueReason('b')).toBe('folder')
  })

  it('steers into the running turn without waiting for the folder', async () => {
    const t = await setup()
    await t.sessions.send('a', text('First'))
    const r = await t.sessions.steer('a', { parts: text('Also this') })
    expect(r.queued).toBe(false)
    expect(r.why).toBeUndefined()
  })

  it('sends a held message after a restart once nothing holds the folder', async () => {
    const t = await setup()
    await t.sessions.send('a', text('First'))
    await t.sessions.send('b', text('Second'))
    expect(t.sessions.queueReason('b')).toBe('folder')
    // A crash: nothing was shut down, so the store has the queue and the journal of running chats.
    const gone = sdk.calls.length
    const again = t.make()
    again.restore([], {})
    await flush()
    // b's message was held first, so it goes, and a's carry-on after the crash waits for the folder as any message would.
    expect(again.isRunning('b')).toBe(true)
    expect(again.queued('b')).toEqual([])
    expect(again.isRunning('a')).toBe(false)
    expect(again.folderBlocker('a')).toBe('b')
    await t.finish(gone)
    expect(again.isRunning('a')).toBe(true)
    expect(again.isRunning('b')).toBe(false)
  })

  it('keeps the agent limit and the folder rule apart', async () => {
    const t = await setup(2)
    await t.sessions.send('a', text('First'))
    await t.sessions.send('d', text('Elsewhere'))
    // At the limit, a chat that would also wait for the folder says capacity, and goes only when both are free.
    expect(await t.sessions.send('b', text('Second'))).toMatchObject({ queued: true, why: 'capacity' })
    await t.sessions.sendNow('b', t.sessions.queued('b')[0].id)
    await flush()
    expect(t.sessions.isRunning('b')).toBe(false)
    await t.finish(1)
    // A slot is free, but a still holds the folder.
    expect(t.sessions.queueReason('b')).toBe('folder')
    expect(t.sessions.isRunning('b')).toBe(false)
    await t.finish(0)
    expect(t.sessions.isRunning('b')).toBe(true)
  })

  it('takes no slot for a chat that waits for its folder', async () => {
    const t = await setup(2)
    await t.sessions.send('a', text('First'))
    await t.sessions.send('b', text('Second'))
    expect(t.sessions.queueReason('b')).toBe('folder')
    expect(await t.sessions.send('d', text('Elsewhere'))).toMatchObject({ queued: false })
  })
})

describe('a change made during a turn reaches the chat\'s next message (KERNEL-994)', () => {
  afterEach(() => { bus.removeAllListeners('push') })

  type Call = (typeof sdk.calls)[number]
  const kernel: AgentDef = { id: 'kernel', file: '.claude/agents/kernel.md', name: 'Kernel', role: 'Lead', description: 'Lead', lead: true, prompt: 'You are Kernel.' } as AgentDef
  const flush = () => new Promise((r) => setTimeout(r, 10))

  /** A Lead chat whose agent rule is `RULE one`. `edit` changes the rule as an edit of its agent file does, and the chat restarts its idle process. */
  async function setup() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-stale-')), 'kernel.db'))
    store.saveWorkspace({ id: 'ws', projectId: 'project', name: 'Chat', branch: 'main', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kernel', port: 4300, status: 'ready', prState: 'none', createdAt: 1 } as Workspace)
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Chat', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const approvals = new Approvals(store)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    let active = 'work'
    let rule = 'one'
    const sessions = new Sessions({ store, approvals, settings: () => settings, agentFor: () => kernel, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {}, accountFor: () => active, claudeEnv: () => ({ CLAUDE_CONFIG_DIR: `/homes/${active}` }), rulesFor: () => `RULE ${rule}` })
    const send = async (text: string) => sessions.send('chat', [{ type: 'text', text }])
    const start = async (text = 'Plan the column') => {
      await send(text)
      const call = sdk.calls.at(-1)!
      call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
      await flush()
      return call
    }
    const finish = async (call: Call) => { call.feed({ type: 'result', subtype: 'success', uuid: `r${sdk.calls.length}`, duration_ms: 5 }); await flush() }
    const interrupted = async (call: Call) => { call.feed({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: `r${sdk.calls.length}`, duration_ms: 5, errors: [] }); await flush() }
    const edit = (to: string) => { rule = to; sessions.restartIdle(['ws']) }
    const stopped = (call: Call) => !!call.options.abortController?.signal.aborted
    const ruleOf = (call: Call) => JSON.stringify(call.options.systemPrompt)
    const notes = () => store.items('chat').flatMap((i) => (i.kind === 'note' ? [i.text] : []))
    const tasks = (call: Call, ids: string[]) => call.feed({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash', description: 'dev server' })) })
    return { store, sessions, send, start, finish, interrupted, edit, stopped, rule: ruleOf, notes, tasks, switchAccount: (to: string) => { active = to; sessions.restartProvider('claude') } }
  }

  it('runs a message queued during the turn in a new process with the changed agent', async () => {
    const t = await setup()
    const call = await t.start()
    expect(t.rule(call)).toContain('RULE one')
    await t.send('And an index')
    expect(t.sessions.queued('chat')).toHaveLength(1)
    t.edit('two')
    await t.finish(call)
    const next = sdk.calls.at(-1)!
    expect(next).not.toBe(call)
    expect(t.stopped(call)).toBe(true)
    expect(t.rule(next)).toContain('RULE two')
    expect(t.sessions.queued('chat')).toEqual([])
    expect(next.options.resume).toBe('session-1')
  })

  it('does the same after Stop and a message, and after Send now', async () => {
    const t = await setup()
    const call = await t.start()
    await t.sessions.interrupt('chat')
    t.edit('two')
    await t.interrupted(call)
    // The message arrives once the turn has stopped, at the process the edit left stale.
    await t.send('i guess you will just build it directly')
    const next = sdk.calls.at(-1)!
    expect(next).not.toBe(call)
    expect(t.rule(next)).toContain('RULE two')
    expect(next.sent.join('\n')).toContain('build it directly')
    expect(t.stopped(call)).toBe(true)

    const u = await setup()
    const old = await u.start()
    await u.send('Use the staging bucket')
    await u.sessions.sendNow('chat', u.sessions.queued('chat')[0].id)
    u.edit('two')
    await u.interrupted(old)
    const fresh = sdk.calls.at(-1)!
    expect(fresh).not.toBe(old)
    expect(u.rule(fresh)).toContain('RULE two')
    expect(u.stopped(old)).toBe(true)
  })

  it('runs a queued message with Bypass turned on during the turn, and on the account and agent changed during it', async () => {
    const t = await setup()
    const call = await t.start()
    expect(call.options.permissionMode).not.toBe('bypassPermissions')
    await t.send('And an index')
    await t.sessions.configure('chat', { mode: 'bypassPermissions' })
    await t.finish(call)
    const next = sdk.calls.at(-1)!
    expect(next).not.toBe(call)
    expect(next.options.permissionMode).toBe('bypassPermissions')

    const a = await setup()
    const first = await a.start()
    await a.send('Next')
    a.switchAccount('personal')
    await a.finish(first)
    expect(sdk.calls.at(-1)!.options.env?.CLAUDE_CONFIG_DIR).toBe('/homes/personal')

    const b = await setup()
    const old = await b.start()
    await b.send('Next')
    b.edit('two')
    await b.finish(old)
    expect(sdk.calls.at(-1)).not.toBe(old)
    expect(b.stopped(old)).toBe(true)
  })

  it('ends a stale process a background task held on the next message, and says the tasks stopped', async () => {
    const t = await setup()
    const call = await t.start()
    t.tasks(call, ['t1'])
    await t.finish(call)
    t.edit('two')
    expect(t.stopped(call)).toBe(false)
    const next = await t.start('Build it')
    expect(t.stopped(call)).toBe(true)
    expect(t.rule(next)).toContain('RULE two')
    expect(t.notes()).toEqual(['Restarted. Background tasks started before the change stopped.'])

    // A process with no task says nothing.
    const v = await setup()
    const plain = await v.start()
    await v.finish(plain)
    v.edit('two')
    await v.start('Build it')
    expect(v.notes()).toEqual([])
  })

  it('approves a plan without a new process', async () => {
    const t = await setup()
    const call = await t.start()
    const calls = sdk.calls.length
    const answer = (call.options.canUseTool as CanUseTool)('ExitPlanMode', { plan: '1. Add the column' }, { signal: new AbortController().signal, toolUseID: 'p1' } as never)
    await flush()
    const [card] = t.store.approvals({ pendingOnly: true })
    t.sessions['d'].approvals.decide(card.id, { behavior: 'allow' })
    expect(await answer).toMatchObject({ behavior: 'allow' })
    expect(sdk.calls).toHaveLength(calls)
    expect(t.stopped(call)).toBe(false)
  })
})
