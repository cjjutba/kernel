import { describe, expect, it } from 'vitest'
import type { AccountProfile, RateLimit } from '@shared/types'
import { chipLabel, footerGroups } from '../src/renderer/src/components/footer/usageModel'

const now = 1_800_000_000_000
const account = (id: string, active: boolean, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, provider: 'claude', label: id, plan: 'Claude Pro', cli: id === 'cli', auth: 'subscription', active, signedIn: true, ...over })
const window = (type: RateLimit['type'], utilization: number, accountId?: string, over: Partial<RateLimit> = {}): RateLimit => ({ type, status: 'allowed', utilization, resetsAt: 1_900_000_000, ...(accountId ? { accountId } : {}), ...over })

describe('the footer chips (KERNEL-674)', () => {
  const accounts = [account('cli', true), account('side', false)]
  const usage = [window('five_hour', 0.06), window('seven_day', 1), window('seven_day_overage_included', 0), window('five_hour', 0.2, 'side')]

  it('carries the Fable number on an account that reports a Fable window, and leaves it off one that does not', () => {
    const [claude] = footerGroups(accounts, usage, now)
    expect(claude.chips.map((c) => [c.id, c.five, c.week, c.fable])).toEqual([['cli', 0.06, 1, 0], ['side', 0.2, undefined, undefined]])
  })

  it('reads a Fable window tagged with the model, and not one that has reset since', () => {
    const tagged = [window('seven_day_opus', 0.4, undefined, { model: 'claude-fable-5-1' })]
    expect(footerGroups(accounts, tagged, now)[0].chips[0].fable).toBe(0.4)
    expect(footerGroups(accounts, [window('seven_day_overage_included', 0.4, undefined, { resetsAt: 1_000_000_000 })], now)[0].chips[0].fable).toBeUndefined()
  })

  it('says the Fable number in the active chip label only when there is one', () => {
    const [claude] = footerGroups(accounts, usage, now)
    expect(chipLabel(claude, claude.chips[0], false)).toBe('Claude Code, cli, active: 5-hour 6%, weekly 100%, Fable 5.1 weekly 0%. Opens usage')
    expect(chipLabel(claude, { ...claude.chips[0], fable: undefined }, false)).toBe('Claude Code, cli, active: 5-hour 6%, weekly 100%. Opens usage')
  })
})
