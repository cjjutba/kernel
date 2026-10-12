import { describe, expect, it } from 'vitest'
import type { AccountProfile, Chat, RateLimit, Workspace } from '@shared/types'
import { bannerFor, limitBannerExpired, limitBannerKey, type BannerInput } from '../src/renderer/src/screens/workspace/banners/model'
import { tilde } from '../src/renderer/src/screens/settings/pages/Providers'
import { accountDetail } from '../src/renderer/src/accountRows'
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

describe('the account the banners offer (KERNEL-569)', () => {
  const sub = (id: string, label: string, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, provider: 'claude', label, cli: false, auth: 'subscription', active: false, signedIn: true, ...over })
  const work = sub('cli', 'Work', { cli: true, active: true })
  const personal = sub('personal', 'Personal')
  const spare = sub('spare', 'Spare')
  const key: AccountProfile = { ...sub('key', 'Billing'), auth: 'apiKey' }
  const five = (accountId: string | undefined, utilization: number, over: Partial<RateLimit> = {}): RateLimit => ({ type: 'five_hour', status: 'allowed', utilization, resetsAt: later, ...(accountId ? { accountId } : {}), ...over })
  const week = (accountId: string | undefined, utilization: number): RateLimit => ({ ...five(accountId, utilization), type: 'seven_day' })

  describe('the limit banner', () => {
    const hit = [claudeLimit]

    it('offers the subscription account with the most 5-hour room, not the first in the list', () => {
      const usage = [...hit, five('personal', 0.6), five('spare', 0.1)]
      expect(bannerFor(input({ usage, accounts: [work, personal, spare] }))?.switchAccount).toEqual({ provider: 'claude', accountId: 'spare', label: 'Spare' })
      expect(bannerFor(input({ usage, accounts: [work, spare, personal] }))?.actions.at(-1)).toEqual({ id: 'switchAccount', label: 'Switch to Spare', primary: true })
    })

    it('puts an account never read after one that was, and keeps the list order between equals', () => {
      expect(bannerFor(input({ usage: [...hit, five('spare', 0.95)], accounts: [work, personal, spare] }))?.switchAccount?.accountId).toBe('spare')
      expect(bannerFor(input({ usage: hit, accounts: [work, personal, spare] }))?.switchAccount?.accountId).toBe('personal')
    })

    it('counts a 5-hour window that has reset as unused, and one read on a model alone as nothing', () => {
      const reset = five('personal', 0.99, { resetsAt: now / 1000 - 60 })
      expect(bannerFor(input({ usage: [...hit, reset, five('spare', 0.3)], accounts: [work, spare, personal] }))?.switchAccount?.accountId).toBe('personal')
      expect(bannerFor(input({ usage: [...hit, five('personal', 0.9, { model: 'claude-fable-5-1' }), five('spare', 0.5)], accounts: [work, personal, spare] }))?.switchAccount?.accountId).toBe('spare')
    })

    it('skips an account with a rejected window, and one signed out', () => {
      const usage = [...hit, five('personal', 0.05, { status: 'rejected' }), week('spare', 0.2)]
      expect(bannerFor(input({ usage, accounts: [work, personal, spare] }))?.switchAccount?.accountId).toBe('spare')
      expect(bannerFor(input({ usage, accounts: [work, personal, { ...spare, signedIn: false }] }))?.switchAccount).toBeUndefined()
    })

    it('offers an API key only when no subscription account has room, whatever its place in the list', () => {
      expect(bannerFor(input({ usage: [...hit, five('personal', 0.99)], accounts: [work, key, personal] }))?.switchAccount?.accountId).toBe('personal')
      expect(bannerFor(input({ usage: [...hit, five('personal', 0.5, { status: 'rejected' })], accounts: [work, personal, key] }))?.switchAccount?.accountId).toBe('key')
    })
  })

  describe('the near-limit offer', () => {
    const accounts = [work, personal]
    const usage = [five(undefined, 0.9), five('personal', 0.08)]
    const offer = (o: Partial<BannerInput> = {}) => bannerFor(input({ accounts, usage, ...o }))
    const offered = (o: Partial<BannerInput> = {}) => offer(o)?.id === 'accountNearLimit'

    it('says how full the active account is and that another has room, with a one-click switch', () => {
      expect(offer()).toMatchObject({
        id: 'accountNearLimit', kind: 'limit', title: 'Work is at 90% of its 5-hour limit', sub: 'Personal has room.', blocks: false,
        actions: [{ id: 'switchAccount', label: 'Switch to Personal', primary: true }], switchAccount: { provider: 'claude', accountId: 'personal', label: 'Personal' }
      })
    })

    it('starts at 90% of the 5-hour window and 95% of the weekly one', () => {
      expect(offered({ usage: [five(undefined, 0.89)] })).toBe(false)
      expect(offered({ usage: [week(undefined, 0.94)] })).toBe(false)
      expect(offer({ usage: [week(undefined, 0.95)] })).toMatchObject({ id: 'accountNearLimit', title: 'Work is at 95% of its weekly limit' })
      expect(offer({ usage: [five(undefined, 0.97), { ...week(undefined, 0.96), resetsAt: later + 86_400 }] })?.title).toBe('Work is at 96% of its weekly limit')
    })

    it('reads a warning with no number as close, and a window past its reset as nothing', () => {
      expect(offer({ usage: [{ type: 'five_hour', status: 'allowed_warning', resetsAt: later }] })?.title).toBe('Work is close to its 5-hour limit')
      expect(offered({ usage: [five(undefined, 0.99, { resetsAt: now / 1000 - 1 })] })).toBe(false)
    })

    it('offers the account with the most 5-hour room, and never an API key', () => {
      expect(offer({ accounts: [work, personal, spare], usage: [...usage, five('spare', 0.02)] })?.switchAccount?.accountId).toBe('spare')
      expect(offered({ accounts: [work, key] })).toBe(false)
      expect(offer({ accounts: [work, key, personal] })?.switchAccount?.accountId).toBe('personal')
    })

    it('needs a signed-in account with room: not one signed out, rejected, or itself close to its limit', () => {
      expect(offered({ accounts: [work, { ...personal, signedIn: false }] })).toBe(false)
      expect(offered({ usage: [...usage, five('personal', 0.5, { status: 'rejected' })] })).toBe(false)
      expect(offered({ usage: [five(undefined, 0.9), five('personal', 0.92)] })).toBe(false)
      expect(offered({ usage: [five(undefined, 0.9), week('personal', 0.96)] })).toBe(false)
      expect(offered({ accounts: [work] })).toBe(false)
      expect(offered({ accounts: undefined })).toBe(false)
    })

    it('counts an account never read as having room', () => {
      expect(offer({ usage: [five(undefined, 0.9)] })?.switchAccount?.accountId).toBe('personal')
    })

    it('does not show with switching at a limit on, and does with it off', () => {
      expect(offer({ switchAtLimit: true })?.id).toBe('nearLimit')
      expect(offered({ switchAtLimit: false })).toBe(true)
    })

    it("speaks of the chat's own provider, on the account that provider runs on", () => {
      const codex = [sub('cli', 'cj@example.com', { provider: 'codex', cli: true, active: true }), sub('personal', 'Personal', { provider: 'codex' })]
      const both = [...accounts, ...codex]
      expect(bannerFor(input({ chat: codexChat, accounts: both, usage: [five(undefined, 0.96)], codexInUse: true }))).toBeNull()
      expect(bannerFor(input({ chat: codexChat, accounts: both, usage: [{ ...five(undefined, 0.96), provider: 'codex' }], codexInUse: true }))).toMatchObject({ title: 'cj@example.com is at 96% of its Codex 5-hour limit', sub: 'Personal has room.', switchAccount: { provider: 'codex', accountId: 'personal' } })
      expect(offered({ accounts: accounts.map((a) => ({ ...a, active: a.id === 'personal' })), usage: [five(undefined, 0.95)] })).toBe(false)
    })

    it('is the stronger line only against the hold, and gives way to a limit that was hit and to the blocking banners', () => {
      expect(offer({ usage: [...usage, five('personal', 0.1)], isLead: true })?.id).toBe('accountNearLimit')
      expect(offer({ usage: [five(undefined, 1, { status: 'rejected' }), five('personal', 0.1)] })?.id).toBe('session')
      expect(offer({ online: false })?.id).toBe('offline')
      expect(offered({ accounts: [work] })).toBe(false)
    })

    describe('closing it', () => {
      const key = (scope: string, at: number) => limitBannerKey('accountNearLimit', at, scope)

      it('keys it by account and window, so it comes once per window', () => {
        const b = offer()
        expect(b?.dismissKey).toBe(`accountNearLimit:claude:cli:${later}`)
        expect(b?.dismissKey).toBe(key('claude:cli', later))
        expect(limitBannerExpired(b!.dismissKey!, now)).toBe(false)
        expect(limitBannerExpired(b!.dismissKey!, later * 1000)).toBe(true)
      })

      it('stays closed in its window and comes back in the next, and the hold shows meanwhile', () => {
        expect(offer({ dismissed: new Set([key('claude:cli', later)]) })?.id).toBe('nearLimit')
        const nextWindow = later + 5 * 3600
        expect(offer({ usage: [five(undefined, 0.9, { resetsAt: nextWindow }), five('personal', 0.08)], dismissed: new Set([key('claude:cli', later)]) })?.id).toBe('accountNearLimit')
      })

      it("doesn't take another account's or provider's window with it", () => {
        expect(offer({ dismissed: new Set([key('claude:personal', later), key('codex:cli', later)]) })?.id).toBe('accountNearLimit')
      })
    })
  })
})

describe('Settings, Providers text (KERNEL-406, KERNEL-561)', () => {
  it('says what each account is and how much of its windows it used', () => {
    const usage: RateLimit[] = [{ type: 'five_hour', status: 'allowed', utilization: 0.62 }, { type: 'five_hour', status: 'allowed', utilization: 0.12, accountId: 'work' }, { type: 'five_hour', status: 'allowed', utilization: 0.07, provider: 'codex' }]
    expect(accountDetail(accounts[0], usage)).toEqual(['Claude Max · Claude Code’s own login', '5-hour 62% used'])
    expect(accountDetail(accounts[1], usage)).toEqual(['cj@acme.dev · Claude Team', '5-hour 12% used'])
    expect(accountDetail({ ...accounts[2], plan: 'ChatGPT Plus' }, usage)).toEqual(['ChatGPT Plus · Codex’s own login', '5-hour 7% used'])
    expect(accountDetail({ ...accounts[1], signedIn: false }, usage)).toEqual(['Signed out'])
    expect(tilde('/Users/cj/.codex/config.toml')).toBe('~/.codex/config.toml')
  })

  it('gives each window its reset time, and leaves out one that has already reset', () => {
    const at = new Date(2026, 9, 11, 14, 10).getTime()
    const usage: RateLimit[] = [
      { type: 'five_hour', status: 'allowed', utilization: 0.12, resetsAt: (at + 3600_000) / 1000, accountId: 'work' },
      { type: 'seven_day', status: 'allowed', utilization: 0.3, resetsAt: (at - 60_000) / 1000, accountId: 'work' }
    ]
    expect(accountDetail(accounts[1], usage, at)).toEqual(['cj@acme.dev · Claude Team', '5-hour 12% used · resets at 3:10 PM'])
  })

  it('asks a legacy token account to sign in again, and gives its meters as of its last turn', () => {
    const token: AccountProfile = { id: 'side', provider: 'claude', label: 'Side', cli: false, auth: 'subscription', active: true, signedIn: true, usageFromTurns: true, legacyToken: true }
    const at = new Date(2026, 9, 11, 14, 10).getTime()
    const usage: RateLimit[] = [
      { type: 'five_hour', status: 'allowed', utilization: 0.12, accountId: 'side', readAt: at },
      { type: 'seven_day', status: 'allowed', utilization: 0.3, accountId: 'side', readAt: at - 60_000 }
    ]
    expect(accountDetail(token, usage, at + 3600_000)).toEqual(['Sign in again to show email and plan', '5-hour 12% used', 'Weekly 30% used', 'As of its last turn at 2:10 PM'])
    expect(accountDetail(token, usage, at + 2 * 86400_000).at(-1)).toBe('As of its last turn on Oct 11')
    expect(accountDetail(token, [], at)).toEqual(['Sign in again to show email and plan', 'Usage shows after its first turn'])
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
