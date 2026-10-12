import { describe, expect, it } from 'vitest'
import type { AccountProfile, RateLimit } from '@shared/types'
import { accountWindows, meterAccount, usageRows } from '../src/renderer/src/screens/settings/pages/Account'
import { planSection, planSections } from '../src/renderer/src/components/sidebar/planModel'

const account = (id: string, plan: string, active: boolean, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, provider: 'claude', label: id, plan, cli: id === 'cli', auth: 'subscription', active, signedIn: true, ...over })
const window = (type: RateLimit['type'], utilization: number, accountId?: string, over: Partial<RateLimit> = {}): RateLimit => ({ type, status: 'allowed', utilization, resetsAt: 1_900_000_000, ...(accountId ? { accountId } : {}), ...over })
const usage: RateLimit[] = [
  window('five_hour', 0.87), window('seven_day', 0.88), window('seven_day_opus', 0.4),
  window('five_hour', 0.12, 'pro'), window('seven_day', 0.2, 'pro'),
  { ...window('five_hour', 0.5), provider: 'codex' }
]

describe('the plan pill popover with two accounts reading usage (KERNEL-612)', () => {
  it('shows the active account on the CLI login', () => {
    const accounts = [account('cli', 'Claude Max', true), account('pro', 'Claude Pro', false)]
    const rows = usageRows(accountWindows(usage, meterAccount(accounts, usage)))
    expect(rows.map((r) => r.limit?.utilization)).toEqual([0.87, 0.88, 0.4])
  })
  it('shows the added account once it is the active one, not the CLI login first in the list', () => {
    const accounts = [account('cli', 'Claude Max', false), account('pro', 'Claude Pro', true)]
    const rows = usageRows(accountWindows(usage, meterAccount(accounts, usage)))
    expect(rows.map((r) => r.id)).toEqual(['session', 'week', 'model'])
    expect(rows.map((r) => r.limit?.utilization)).toEqual([0.12, 0.2, undefined])
  })
  it('leaves out the other provider and the other accounts windows', () => {
    const accounts = [account('cli', 'Claude Max', true), account('pro', 'Claude Pro', false)]
    expect(accountWindows(usage, meterAccount(accounts, usage))).toHaveLength(3)
  })
  it('shows the subscription read last while a key is in use', () => {
    const accounts = [account('cli', 'Claude Max', false), account('pro', 'Claude Pro', false), account('key', 'Key', true, { auth: 'apiKey' })]
    const read = [window('five_hour', 0.12, 'pro', { readAt: 200 }), window('five_hour', 0.87, undefined, { readAt: 100 })]
    expect(accountWindows(read, meterAccount(accounts, read)).map((l) => l.utilization)).toEqual([0.12])
  })
})

describe('the Usage popover sections, one per provider (KERNEL-619)', () => {
  const now = 1_800_000_000_000
  const codex = (id: string, plan: string, active: boolean, over: Partial<AccountProfile> = {}): AccountProfile => ({ ...account(id, plan, active, over), provider: 'codex' })
  const codexWindow = (type: RateLimit['type'], utilization: number, accountId?: string): RateLimit => ({ ...window(type, utilization, accountId), provider: 'codex' })
  const accounts = [account('cli', 'Claude Max', true), account('pro', 'Claude Pro', false), codex('cli', 'ChatGPT Plus', true), codex('team', 'ChatGPT Pro', false)]
  const limits: RateLimit[] = [
    window('five_hour', 0.87), window('seven_day', 0.88), window('five_hour', 0.12, 'pro'),
    codexWindow('five_hour', 0.5), codexWindow('seven_day', 0.2), codexWindow('five_hour', 0.03, 'team')
  ]

  it('draws each provider from its own windows, though both have a login with the same id', () => {
    const [claude, other] = planSections(accounts, limits, now)
    expect([claude.provider, other.provider]).toEqual(['claude', 'codex'])
    expect(claude.windows.map((w) => w.value)).toEqual([0.87, 0.88])
    expect(other.windows.map((w) => w.value)).toEqual([0.5, 0.2])
  })

  it('moves to the new account of one provider after a switch and leaves the other provider alone', () => {
    const switched = accounts.map((a) => (a.provider === 'claude' ? { ...a, active: a.id === 'pro' } : a))
    const [claude, other] = planSections(switched, limits, now)
    expect(claude.account?.id).toBe('pro')
    expect(claude.windows.map((w) => w.value)).toEqual([0.12, 0])
    expect(claude.others.map((o) => o.id)).toEqual(['cli'])
    expect(other.account?.id).toBe('cli')
    expect(other.windows.map((w) => w.value)).toEqual([0.5, 0.2])
  })

  it('lists the other signed-in accounts with their 5-hour use, and leaves out the one in use and signed-out ones', () => {
    const section = planSection('claude', [...accounts, account('out', 'Claude Pro', false, { signedIn: false })], limits, now)
    expect(section.others).toEqual([{ id: 'pro', label: 'pro', plan: 'Claude Pro', use: '5-hour 12% used' }])
    expect(planSection('codex', accounts, limits, now).others).toEqual([{ id: 'team', label: 'team', plan: 'ChatGPT Pro', use: '5-hour 3% used' }])
  })

  it('says Billed per token for a key in use, with no windows, and lists the subscriptions', () => {
    const withKey = [account('cli', 'Claude Max', false), account('pro', 'Claude Pro', false), account('key', '', true, { auth: 'apiKey', plan: undefined })]
    const section = planSection('claude', withKey, limits, now)
    expect(section).toMatchObject({ billed: true, plan: 'API key', windows: [] })
    expect(section.others.map((o) => [o.id, o.use])).toEqual([['cli', '5-hour 87% used'], ['pro', '5-hour 12% used']])
    expect(planSection('claude', [account('cli', 'Claude Max', false), account('key', '', false, { auth: 'apiKey' }), account('pro', 'Claude Pro', true)], limits, now).others.find((o) => o.id === 'key')?.use).toBe('Billed per token')
  })

  it('is one line for a provider that is signed out, and keeps the other provider drawn', () => {
    const out = accounts.map((a) => (a.provider === 'codex' && a.id === 'cli' ? { ...a, signedIn: false } : a))
    const [claude, other] = planSections(out, limits, now)
    expect(other.account).toBeUndefined()
    expect(other).toMatchObject({ signedOut: { id: 'cli' }, windows: [], others: [] })
    expect(claude.account?.id).toBe('cli')
  })

  it('shows the email only when the nickname is not the email, and the windows of a model beside the first two', () => {
    const named = account('cli', 'Claude Max', true, { label: 'Work', email: 'cj@example.com' })
    const fable = window('seven_day_opus', 0.9, undefined, { model: 'claude-fable-5-1' })
    const section = planSection('claude', [named], [...limits, fable], now)
    expect(section.email).toBe('cj@example.com')
    expect(section.windows.map((w) => w.title)).toEqual(['5-hour', 'Weekly', 'Weekly, Fable 5.1'])
    expect(planSection('claude', [{ ...named, label: 'cj@example.com' }], limits, now).email).toBeUndefined()
  })

  it('says nothing for a window that has reset since it was read', () => {
    const stale = [window('five_hour', 0.9, undefined, { resetsAt: now / 1000 - 60 })]
    expect(planSection('claude', [account('cli', 'Claude Max', true)], stale, now).windows[0]).toMatchObject({ value: 0, note: 'No usage reported yet' })
  })

  it('leaves out a provider whose accounts have not loaded', () => {
    expect(planSections([account('cli', 'Claude Max', true)], limits, now).map((s) => s.provider)).toEqual(['claude'])
    expect(planSections([], limits, now)).toEqual([])
  })
})
