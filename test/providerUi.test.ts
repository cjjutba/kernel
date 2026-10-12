import { describe, expect, it } from 'vitest'
import type { AccountProfile, Chat, RateLimit, Workspace } from '@shared/types'
import { bannerFor, type BannerInput } from '../src/renderer/src/screens/workspace/banners/model'
import { accountLine, tilde } from '../src/renderer/src/screens/settings/pages/Providers'
import { fitEffort } from '../src/renderer/src/screens/workspace/composer/providerModels'
import { nextEffort } from '../src/renderer/src/screens/workspace/composer/modelPrefs'

const ws = { id: 'ws', roomId: 'room', name: 'invoice-table', status: 'ready' } as Workspace
const claudeChat = { id: 'c', workspaceId: 'ws', model: 'claude-sonnet-5-5', effort: 'high' } as Chat
const codexChat = { ...claudeChat, provider: 'codex', model: 'gpt-6-astra' } as Chat
const now = 1_000_000_000_000
const later = now / 1000 + 3600
const input = (o: Partial<BannerInput>): BannerInput => ({ ws, chat: claudeChat, agentName: 'Kai', running: false, usage: [], account: { signedIn: true }, online: true, hooks: null, now, ...o })
const accounts: AccountProfile[] = [
  { id: 'cli', provider: 'claude', label: 'cj@example.com', email: 'cj@example.com', plan: 'Claude Max', cli: true, auth: 'subscription', active: true, signedIn: true },
  { id: 'work', provider: 'claude', label: 'Work', email: 'cj@acme.dev', plan: 'Claude Team', cli: false, auth: 'subscription', active: false, signedIn: true },
  { id: 'cli', provider: 'codex', label: 'cj@example.com', cli: true, auth: 'subscription', active: true, signedIn: true }
]
const claudeLimit: RateLimit = { type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: later }

describe('the limit banner with two providers (KERNEL-406)', () => {
  it('reads as before while only Claude is in use', () => {
    expect(bannerFor(input({ usage: [claudeLimit] }))).toMatchObject({ id: 'session', title: "You've hit your 5-hour limit", actions: [{ id: 'queue' }, { id: 'notify', primary: true }] })
  })

  it('names the provider, says the other keeps working, and offers an account with room', () => {
    const v = bannerFor(input({ usage: [claudeLimit], accounts, codexInUse: true }))
    expect(v).toMatchObject({ title: "You've hit your Claude Code 5-hour limit", switchAccount: { provider: 'claude', accountId: 'work', label: 'Work' } })
    expect(v?.sub).toContain('Agents on Codex keep working.')
    expect(v?.actions).toEqual([{ id: 'notify', label: 'Notify me' }, { id: 'switchAccount', label: 'Switch to Work', primary: true }])
    // No Switch to when the other account is limited too.
    const both = bannerFor(input({ usage: [claudeLimit, { ...claudeLimit, accountId: 'work' }], accounts, codexInUse: true }))
    expect(both?.switchAccount).toBeUndefined()
  })

  it("leaves a Codex chat alone during a Claude limit, and shows Codex's own", () => {
    expect(bannerFor(input({ chat: codexChat, usage: [claudeLimit], accounts, codexInUse: true }))).toBeNull()
    const codex = bannerFor(input({ chat: codexChat, usage: [{ ...claudeLimit, provider: 'codex' }], accounts, codexInUse: true }))
    expect(codex).toMatchObject({ title: "You've hit your Codex 5-hour limit", actions: [{ id: 'queue' }] })
    expect(codex?.sub).toContain('Agents on Claude Code keep working.')
  })

  it('offers a signed-in API key account, which has no windows, and not one that is signed out (KERNEL-523)', () => {
    const key: AccountProfile = { id: 'key', provider: 'claude', label: 'Billing', cli: false, auth: 'apiKey', active: false, signedIn: true }
    const withKey = [accounts[0], key, accounts[2]]
    expect(bannerFor(input({ usage: [claudeLimit], accounts: withKey, codexInUse: true }))?.switchAccount).toEqual({ provider: 'claude', accountId: 'key', label: 'Billing' })
    expect(bannerFor(input({ usage: [claudeLimit], accounts: [accounts[0], { ...key, signedIn: false }], codexInUse: true }))?.switchAccount).toBeUndefined()
  })

  it("counts only the active account's windows", () => {
    const onWork = accounts.map((a) => (a.provider === 'claude' ? { ...a, active: a.id === 'work' } : a))
    expect(bannerFor(input({ usage: [claudeLimit], accounts: onWork, codexInUse: true }))).toBeNull()
  })

  it('says Codex is signed out only in a Codex chat', () => {
    const out = accounts.map((a) => (a.provider === 'codex' ? { ...a, signedIn: false } : a))
    expect(bannerFor(input({ chat: codexChat, accounts: out }))).toMatchObject({ id: 'signedOut', title: 'Codex is signed out', actions: [{ id: 'providers' }] })
    expect(bannerFor(input({ accounts: out }))).toBeNull()
    expect(bannerFor(input({ chat: codexChat, account: { signedIn: false }, accounts }))).toBeNull()
  })
})

describe('Settings, Providers text (KERNEL-406)', () => {
  it("says what each account is, and how much of its 5-hour window it used", () => {
    const usage: RateLimit[] = [{ type: 'five_hour', status: 'allowed', utilization: 0.62 }, { type: 'five_hour', status: 'allowed', utilization: 0.12, accountId: 'work' }, { type: 'five_hour', status: 'allowed', utilization: 0.07, provider: 'codex' }]
    expect(accountLine(accounts[0], usage)).toBe('Claude Max · Claude Code’s own login · 62% of the 5-hour limit used')
    expect(accountLine(accounts[1], usage)).toBe('cj@acme.dev · Claude Team · 12% of the 5-hour limit used')
    expect(accountLine({ ...accounts[2], plan: 'ChatGPT Plus' }, usage)).toBe('ChatGPT Plus · Codex’s own login · 7% of the 5-hour limit used')
    expect(accountLine({ ...accounts[1], signedIn: false }, usage)).toBe('Not signed in')
    expect(tilde('/Users/cj/.codex/config.toml')).toBe('~/.codex/config.toml')
  })

  it("gives a token account's meters as of its last turn, with when that was", () => {
    const token: AccountProfile = { id: 'side', provider: 'claude', label: 'Side', plan: 'Claude Pro', cli: false, auth: 'subscription', active: true, signedIn: true, usageFromTurns: true }
    const at = new Date(2026, 9, 11, 14, 10).getTime()
    const usage: RateLimit[] = [
      { type: 'five_hour', status: 'allowed', utilization: 0.12, accountId: 'side', readAt: at },
      { type: 'seven_day', status: 'allowed', utilization: 0.3, accountId: 'side', readAt: at - 60_000 }
    ]
    expect(accountLine(token, usage, at + 3600_000)).toBe('Claude Pro · 12% of the 5-hour limit and 30% of the weekly limit used, as of its last turn at 2:10 PM')
    expect(accountLine(token, usage, at + 2 * 86400_000)).toBe('Claude Pro · 12% of the 5-hour limit and 30% of the weekly limit used, as of its last turn on Oct 11')
    expect(accountLine(token, [], at)).toBe('Claude Pro · Usage shows after its first turn')
  })

  it("keeps an effort the new model takes, and cycles through the model's own levels", () => {
    const models = [{ provider: 'codex' as const, id: 'gpt-5.6-luna', label: 'Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const, defaultEffort: 'medium' as const }].map((m) => ({ ...m, efforts: [...m.efforts] }))
    expect(fitEffort('high', 'gpt-5.6-luna', models)).toBe('high')
    expect(fitEffort('ultra', 'gpt-5.6-luna', models)).toBe('medium')
    expect(fitEffort('max', 'claude-opus-5-5', [])).toBe('xhigh')
    expect(nextEffort('xhigh')).toBe('low')
    expect(nextEffort('xhigh', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max')
  })
})
