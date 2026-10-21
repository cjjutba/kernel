import { describe, expect, it } from 'vitest'
import type { AccountProfile, RateLimit } from '@shared/types'
import { pctLabel } from '@shared/usage'
import { footerGroups, footerTone, groupLabel } from '../src/renderer/src/components/footer/usageModel'

const now = 1_800_000_000_000
const account = (id: string, active: boolean, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, provider: 'claude', label: id, plan: 'Claude Pro', cli: id === 'cli', auth: 'subscription', active, signedIn: true, ...over })
const window = (type: RateLimit['type'], utilization: number, accountId?: string, over: Partial<RateLimit> = {}): RateLimit => ({ type, status: 'allowed', utilization, resetsAt: 1_900_000_000, ...(accountId ? { accountId } : {}), ...over })

describe('the footer chip (KERNEL-674)', () => {
  const accounts = [account('cli', true), account('side', false)]
  const usage = [window('five_hour', 0.06), window('seven_day', 1), window('seven_day_overage_included', 0), window('five_hour', 0.2, 'side')]

  it('carries the Fable number on an account that reports a Fable window, and leaves it off one that does not', () => {
    expect(footerGroups(accounts, usage, now)[0].chip).toEqual({ id: 'cli', name: 'cli', billed: false, five: 0.06, week: 1, fable: 0 })
    expect(footerGroups([account('cli', true)], [window('five_hour', 0.2)], now)[0].chip?.fable).toBeUndefined()
  })

  it('reads a Fable window tagged with the model, and not one that has reset since', () => {
    const tagged = [window('seven_day_opus', 0.4, undefined, { model: 'claude-fable-5-1' })]
    expect(footerGroups(accounts, tagged, now)[0].chip?.fable).toBe(0.4)
    expect(footerGroups(accounts, [window('seven_day_overage_included', 0.4, undefined, { resetsAt: 1_000_000_000 })], now)[0].chip?.fable).toBeUndefined()
  })

  it('says the Fable number in the button label only when there is one', () => {
    const [claude] = footerGroups(accounts, usage, now)
    expect(groupLabel(claude)).toBe('Claude Code, cli: 5-hour 6%, weekly 100%, Fable 5.1 weekly 0%')
    expect(groupLabel({ ...claude, chip: { ...claude.chip!, fable: undefined } })).toBe('Claude Code, cli: 5-hour 6%, weekly 100%')
  })
})

describe('the footer reports and never switches (KERNEL-949)', () => {
  it('shows only the account each provider runs on, however many there are', () => {
    const many = [account('cli', true), ...['a', 'b', 'c'].map((id) => account(id, false)), account('cx', true, { provider: 'codex' })]
    const groups = footerGroups(many, [window('five_hour', 0.1, 'a')], now)
    expect(groups.map((g) => [g.provider, g.chip?.id])).toEqual([['claude', 'cli'], ['codex', 'cx']])
  })

  it('is Sign in for a provider whose account in use is signed out, and billed per token for a key', () => {
    expect(footerGroups([account('cli', true, { signedIn: false })], [], now)[0]).toEqual({ provider: 'claude', name: 'Claude Code', signedOut: true })
    const [key] = footerGroups([account('key', true, { auth: 'apiKey' })], [window('five_hour', 0.5, 'key')], now)
    expect(key.chip).toEqual({ id: 'key', name: 'key', billed: true })
    expect(groupLabel(key)).toBe('Claude Code, key: billed per token')
  })

  it('names the account being switched to, with no numbers, until the switch is done (KERNEL-986)', () => {
    const accounts = [account('cli', true), account('side', false)]
    const usage = [window('five_hour', 0.06), window('five_hour', 0.2, 'side')]
    const [claude] = footerGroups(accounts, usage, now, { provider: 'claude', accountId: 'side' })
    expect(claude.chip).toEqual({ id: 'side', name: 'side', billed: false, switching: true })
    expect(groupLabel(claude)).toBe('Claude Code, switching to side')
    expect(footerGroups(accounts, usage, now, { provider: 'codex', accountId: 'side' })[0].chip?.name).toBe('cli')
  })
})

describe('usage past the limit (KERNEL-1027)', () => {
  it('never reads over 100% or under 0%', () => {
    expect([1.01, 1, 0.504, 0, -0.1].map(pctLabel)).toEqual(['100%', '100%', '50%', '0%', '0%'])
  })

  it('says 100% in the button label for a 5-hour window at 101%', () => {
    const [claude] = footerGroups([account('cli', true)], [window('five_hour', 1.01)], now)
    expect(groupLabel(claude)).toContain('5-hour 100%')
  })

  it('turns the footer icon amber from 75% and red from 90%, over either provider and either window (KERNEL-1101)', () => {
    const two = [account('cli', true), account('cx', true, { provider: 'codex' })]
    const tone = (u: RateLimit[]) => footerTone(footerGroups(two, u, now))
    expect(tone([window('five_hour', 0.11), window('seven_day', 0.5)])).toBeUndefined()
    expect(tone([window('five_hour', 0.11), window('seven_day', 0.8)])).toBe('near')
    expect(tone([window('five_hour', 0.11), window('seven_day', 0.31, 'cx', { provider: 'codex' }), window('five_hour', 1, 'cx', { provider: 'codex' })])).toBe('full')
    expect(footerTone(footerGroups([account('key', true, { auth: 'apiKey' })], [window('five_hour', 1, 'key')], now))).toBeUndefined()
  })
})
