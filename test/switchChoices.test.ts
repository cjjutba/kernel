import { describe, expect, it } from 'vitest'
import type { AccountProfile, RateLimit } from '@shared/types'
import { switchChoices } from '@shared/usage'

// Where a provider can go at a limit, as Kernel's own switch and the limit banner see it (KERNEL-618).

const NOW = 1_800_000_000_000
const HOUR = 3600
const at = (s: number) => Math.round(NOW / 1000) + s

const account = (id: string, o: Partial<AccountProfile> = {}): AccountProfile => ({ id, provider: 'claude', label: id, cli: id === 'cli', auth: 'subscription', active: false, signedIn: true, ...o })
const window = (accountId: string | undefined, utilization: number, o: Partial<RateLimit> = {}): RateLimit => ({ type: 'five_hour', status: utilization >= 1 ? 'rejected' : 'allowed', utilization, resetsAt: at(HOUR), ...(accountId ? { accountId } : {}), ...o })
const ids = (r: { headroom: AccountProfile[]; signedOut?: AccountProfile }) => ({ headroom: r.headroom.map((a) => a.id), signedOut: r.signedOut?.id })

describe('switchChoices', () => {
  it('lists the other signed-in accounts with headroom, the most 5-hour headroom first, one never read last, and API keys after', () => {
    const accounts = [account('cli', { active: true }), account('side'), account('personal'), account('fresh'), account('key', { auth: 'apiKey' }), account('limited')]
    const usage = [window(undefined, 1), window('side', 0.6), window('personal', 0.2), window('limited', 1), window('limited', 0.4, { type: 'seven_day', status: 'allowed' })]
    expect(ids(switchChoices('claude', accounts, usage, NOW))).toEqual({ headroom: ['personal', 'side', 'fresh', 'key'], signedOut: undefined })
    // A window past its reset has all of its headroom.
    expect(switchChoices('claude', accounts, [...usage.filter((l) => l.accountId !== 'side'), window('side', 0.9, { resetsAt: at(-60) })], NOW).headroom[0].id).toBe('side')
    // Another provider's accounts and windows count for nothing.
    expect(switchChoices('codex', accounts, usage, NOW).headroom).toEqual([])
  })

  it('counts an account in the same organization as the one in use only when its own windows say it has headroom', () => {
    const accounts = [account('cli', { active: true, sameOrg: ['seat'] }), account('seat', { sameOrg: ['cli'] }), account('other')]
    expect(ids(switchChoices('claude', accounts, [window(undefined, 1)], NOW)).headroom).toEqual(['other'])
    expect(ids(switchChoices('claude', accounts, [window(undefined, 1), window('seat', 0.1)], NOW)).headroom).toEqual(['seat', 'other'])
    expect(ids(switchChoices('claude', accounts, [window(undefined, 1), window('seat', 1)], NOW)).headroom).toEqual(['other'])
    // Two seats sharing an organization with each other, not with the one in use, count as any account does.
    const apart = [account('cli', { active: true }), account('a', { sameOrg: ['b'] }), account('b', { sameOrg: ['a'] })]
    expect(ids(switchChoices('claude', apart, [], NOW)).headroom).toEqual(['a', 'b'])
  })

  it('leaves out an account waiting for Keychain access', () => {
    const accounts = [account('cli', { active: true }), account('side', { keychainWait: true })]
    expect(ids(switchChoices('claude', accounts, [window(undefined, 1)], NOW))).toEqual({ headroom: [], signedOut: undefined })
  })

  it('names the signed-out account that would have headroom when none signed in does, for "Personal is signed out. Sign in to switch to it."', () => {
    const accounts = [account('cli', { active: true }), account('personal', { signedIn: false }), account('key', { auth: 'apiKey', signedIn: false })]
    expect(ids(switchChoices('claude', accounts, [window(undefined, 1)], NOW))).toEqual({ headroom: [], signedOut: 'personal' })
    // Not when it was at its limit when last read, or when a signed-in account has headroom.
    expect(switchChoices('claude', accounts, [window(undefined, 1), window('personal', 1)], NOW).signedOut).toBeUndefined()
    expect(ids(switchChoices('claude', [...accounts, account('side')], [window(undefined, 1)], NOW))).toEqual({ headroom: ['side'], signedOut: undefined })
    // A signed-in API key account is somewhere to go, so the banner offers it instead.
    expect(ids(switchChoices('claude', [...accounts, account('key2', { auth: 'apiKey' })], [window(undefined, 1)], NOW))).toEqual({ headroom: ['key2'], signedOut: undefined })
  })
})
