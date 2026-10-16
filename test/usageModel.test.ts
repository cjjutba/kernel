import { describe, expect, it } from 'vitest'
import type { AccountProfile, RateLimit } from '@shared/types'
import { chipLabel, footerGroups } from '../src/renderer/src/components/footer/usageModel'

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

  it('says the Fable number in the chip label only when there is one', () => {
    const [claude] = footerGroups(accounts, usage, now)
    expect(chipLabel(claude, claude.chip!, false)).toBe('Claude Code, cli, active: 5-hour 6%, weekly 100%, Fable 5.1 weekly 0%. Opens usage')
    expect(chipLabel(claude, { ...claude.chip!, fable: undefined }, false)).toBe('Claude Code, cli, active: 5-hour 6%, weekly 100%. Opens usage')
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
    expect(chipLabel(key, key.chip!, false)).toBe('Claude Code, key, active: billed per token. Opens usage')
  })
})
