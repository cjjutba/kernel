import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import { bashVerdict, limitsFromEvent, limitsFromUsage, matchesRoomRule, mergeLimit, roomRule, sessionEnv, Sessions, type SessionDeps } from '../src/main/services/sessions'
import { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'

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
