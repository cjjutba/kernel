import { describe, expect, it } from 'vitest'
import type { AccountProfile, RateLimit } from '@shared/types'
import { chipLabel, footerGroups, moreLabel, switchTip } from '../src/renderer/src/components/footer/usageModel'

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

describe('the footer row with many accounts (KERNEL-697)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  const many = [account('cli', true), ...ids.map((id) => account(id, false))]
  const room = ids.map((id, i) => window('five_hour', 0.1 * (i + 1), id))

  it('shows two others inline, most room first, and counts the rest as overflow', () => {
    const [claude] = footerGroups(many, room, now)
    expect(claude.chips.map((c) => c.id)).toEqual(['cli', 'a', 'b'])
    expect(claude.overflow.map((c) => c.id)).toEqual(['c', 'd', 'e'])
    expect(claude.others).toBe(5)
  })

  it('has no overflow at two others, and none at all with one account', () => {
    const two = footerGroups(many.slice(0, 3), room, now)[0]
    expect([two.chips.length, two.overflow.length, two.others]).toEqual([3, 0, 2])
    const one = footerGroups([account('cli', true)], room, now)[0]
    expect([one.chips.length, one.overflow.length, one.others]).toEqual([1, 0, 0])
  })

  it('leaves keys, signed-out logins and Keychain waits out of the count', () => {
    const mixed = [account('cli', true), account('a', false), account('key', false, { auth: 'apiKey' }), account('out', false, { signedIn: false }), account('kc', false, { keychainWait: true }), account('b', false), account('c', false)]
    const [claude] = footerGroups(mixed, [], now)
    expect(claude.others).toBe(3)
    expect(claude.overflow).toHaveLength(1)
  })

  it('says what switching does, the limit, the missing models and the shared limits', () => {
    const accounts = [account('cli', true), account('a', false, { label: 'Main account', sameOrg: ['cli'], missingModels: [{ model: 'm', label: 'Opus 5.5', agents: [] }] })]
    const usage = [{ ...window('five_hour', 1, 'a'), status: 'rejected' as const }]
    const [claude] = footerGroups(accounts, usage, now)
    const tip = switchTip(claude, claude.chips[1], now)
    expect(tip).toContain('Switch Claude Code to Main account. Every Claude agent uses it from its next turn.')
    expect(tip).toContain('At its limit until')
    expect(tip).toContain("Doesn't offer Opus 5.5.")
    expect(tip).toContain('Shares limits with cli.')
    expect(chipLabel(claude, claude.chips[1], false)).toBe('Switch Claude Code to Main account, 5-hour 100%')
    expect(moreLabel(claude, 3)).toBe('3 more Claude Code accounts')
  })
})
