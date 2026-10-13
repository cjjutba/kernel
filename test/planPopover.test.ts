import { describe, expect, it } from 'vitest'
import type { AccountProfile, RateLimit } from '@shared/types'
import { planAccounts, planSection, planSections } from '../src/renderer/src/components/footer/planModel'

const account = (id: string, plan: string, active: boolean, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, provider: 'claude', label: id, plan, cli: id === 'cli', auth: 'subscription', active, signedIn: true, ...over })
const window = (type: RateLimit['type'], utilization: number, accountId?: string, over: Partial<RateLimit> = {}): RateLimit => ({ type, status: 'allowed', utilization, resetsAt: 1_900_000_000, ...(accountId ? { accountId } : {}), ...over })
const usage: RateLimit[] = [
  window('five_hour', 0.87), window('seven_day', 0.88), window('seven_day_opus', 0.4),
  window('five_hour', 0.12, 'pro'), window('seven_day', 0.2, 'pro'),
  { ...window('five_hour', 0.5), provider: 'codex' }
]

describe('Settings, Account and usage, every account with its own windows (KERNEL-665)', () => {
  const now = 1_800_000_000_000
  const codex = (id: string, plan: string, active: boolean, over: Partial<AccountProfile> = {}): AccountProfile => ({ ...account(id, plan, active, over), provider: 'codex' })

  it('lists every signed-in account, the one agents are on first, each with its own windows', () => {
    const accounts = [account('cli', 'Claude Max', false), account('pro', 'Claude Pro', true), account('out', 'Claude Pro', false, { signedIn: false })]
    const { accounts: shown } = planAccounts('claude', accounts, usage, now)
    expect(shown.map((a) => a.account.id)).toEqual(['pro', 'cli'])
    expect(shown.map((a) => a.windows.map((w) => w.value))).toEqual([[0.12, 0.2], [0.87, 0.88, 0.4]])
  })
  it('leaves the other provider and the other accounts windows out', () => {
    const [claude] = planAccounts('claude', [account('cli', 'Claude Max', true), account('pro', 'Claude Pro', false)], usage, now).accounts
    expect(claude.windows.map((w) => w.value)).toEqual([0.87, 0.88, 0.4])
  })
  it('says billed per token for a key and keeps the subscriptions meters, as the popover does', () => {
    const accounts = [account('cli', 'Claude Max', false), account('key', '', true, { auth: 'apiKey', plan: undefined })]
    const shown = planAccounts('claude', accounts, usage, now).accounts
    expect(shown.map((a) => [a.account.id, a.billed, a.plan])).toEqual([['key', true, 'API key'], ['cli', false, 'Claude Max']])
    expect(shown[0].windows).toEqual([])
    expect(shown[1].windows.length).toBe(3)
  })
  it('is one sign-in line for a provider with no account signed in, and none otherwise', () => {
    const out = codex('cli', 'ChatGPT Plus', true, { signedIn: false })
    expect(planAccounts('codex', [out], usage, now)).toMatchObject({ accounts: [], signedOut: { id: 'cli' } })
    expect(planAccounts('codex', [codex('cli', 'ChatGPT Plus', true)], usage, now).signedOut).toBeUndefined()
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

  it('lists the other signed-in accounts with their 5-hour use, and leaves out the one in use, signed-out ones and one waiting for Keychain access', () => {
    const section = planSection('claude', [...accounts, account('out', 'Claude Pro', false, { signedIn: false }), account('wait', 'Claude Pro', false, { keychainWait: true })], limits, now)
    expect(section.others.map(({ nums: _, ...o }) => o)).toEqual([{ id: 'pro', label: 'pro', plan: 'Claude Pro', use: '5-hour 12% used' }])
    expect(planSection('codex', accounts, limits, now).others.map(({ nums: _, ...o }) => o)).toEqual([{ id: 'team', label: 'team', plan: 'ChatGPT Pro', use: '5-hour 3% used' }])
  })

  it('gives each other account its reported 5-hour, weekly and Fable numbers, and none to a key', () => {
    const fable = (accountId?: string) => window('seven_day_overage_included', 0.31, accountId)
    const mixed = [account('cli', 'Claude Max', true), account('pro', 'Claude Pro', false), account('key', '', false, { auth: 'apiKey' })]
    const others = planSection('claude', mixed, [...limits, window('seven_day', 0.2, 'pro'), fable('pro')], now).others
    expect(others.find((o) => o.id === 'pro')?.nums).toEqual([{ short: '5h', value: 0.12 }, { short: 'wk', value: 0.2 }, { short: 'Fable', value: 0.31 }])
    expect(others.find((o) => o.id === 'key')).toMatchObject({ use: 'Billed per token', nums: [] })
  })

  it('words a window\'s reset for its one-line row', () => {
    const w = planSection('claude', [account('cli', 'Claude Max', true)], [window('five_hour', 0.5, undefined, { resetsAt: (now + 3600_000) / 1000 })], now).windows[0]
    expect(w.reset).toMatch(/^resets \S/)
    expect(w.reset).not.toContain(' at ')
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
