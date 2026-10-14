import { describe, expect, it } from 'vitest'
import type { AccountProfile, RateLimit } from '@shared/types'
import { rowCells } from '../src/renderer/src/screens/settings/pages/providerRows'

const now = Date.UTC(2026, 0, 10, 12)
const sec = (ms: number) => Math.round(ms / 1000)
const acct = (over: Partial<AccountProfile> = {}): AccountProfile => ({ id: 'cli', provider: 'claude', label: 'A', cli: true, auth: 'subscription', active: false, signedIn: true, ...over })
const five = (resetsAt: number, utilization = 0.5): RateLimit => ({ type: 'five_hour', status: 'allowed', utilization, resetsAt: sec(resetsAt) })
const week: RateLimit = { type: 'seven_day', status: 'allowed', utilization: 0.2, resetsAt: sec(now + 86_400_000) }

describe('rowCells', () => {
  it('shows a window that has reset as 0% with no reset time', () => {
    const [c] = rowCells(acct(), [five(now - 1000, 1)], now).cells
    expect(c).toEqual({ title: '5-hour', pct: 0 })
  })

  it('says Not in plan when the group has the Fable column and the account has no Fable window', () => {
    const { cells } = rowCells(acct(), [five(now + 3600_000), week], now, 'Fable 5.1')
    expect(cells[2]).toMatchObject({ absent: true })
    expect(rowCells(acct(), [five(now + 3600_000), week], now).cells[2]).toBeUndefined()
  })

  it('leaves an account with no readings blank', () => {
    expect(rowCells(acct(), [], now, 'Fable 5.1').cells).toEqual([undefined, undefined, undefined])
  })

  it('leaves an API key account blank', () => {
    expect(rowCells(acct({ auth: 'apiKey' }), [five(now + 3600_000)], now, 'Fable 5.1').cells).toEqual([undefined, undefined, undefined])
  })
})
