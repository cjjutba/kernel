import { describe, expect, it } from 'vitest'
import type { AccountProfile, RateLimit } from '@shared/types'
import { accountWindows, meterAccount, usageRows } from '../src/renderer/src/screens/settings/pages/Account'

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
