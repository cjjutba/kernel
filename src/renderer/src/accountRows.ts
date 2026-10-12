import { useEffect } from 'react'
import type { AccountProfile, Provider, RateLimit } from '@shared/types'
import { limitProvider } from '@shared/providers'
import { clock, resetPhrase } from '@shared/usage'
import { call } from './api'
import { actions } from './store'

export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }

const when = (ms: number, now: number) => (new Date(ms).toDateString() === new Date(now).toDateString() ? `at ${clock(ms)}` : `on ${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)

const windowsOf = (a: AccountProfile, usage: RateLimit[]) => usage.filter((u) => limitProvider(u) === a.provider && (u.accountId ?? 'cli') === a.id && !u.model)

export function usageLines(a: AccountProfile, usage: RateLimit[], now = Date.now()): string[] {
  const mine = windowsOf(a, usage)
  return ([['five_hour', '5-hour'], ['seven_day', 'Weekly']] as const).flatMap(([type, name]) => {
    const w = mine.find((l) => l.type === type)
    if (w?.utilization === undefined || (w.resetsAt !== undefined && w.resetsAt * 1000 <= now)) return []
    return [`${name} ${Math.round(w.utilization * 100)}% used${w.resetsAt !== undefined ? ` · resets ${resetPhrase(w.resetsAt, now)}` : ''}`]
  })
}

const lastRead = (a: AccountProfile, usage: RateLimit[], now: number): string | undefined => {
  const read = Math.max(0, ...windowsOf(a, usage).filter((l) => l.type === 'five_hour' || l.type === 'seven_day').map((l) => l.readAt ?? 0))
  return read ? `As of its last turn ${when(read, now)}` : undefined
}

const ownLogin = (a: AccountProfile) => (a.cli ? `${PROVIDER_NAME[a.provider]}’s own login` : undefined)
const joined = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ')

export function accountDetail(a: AccountProfile, usage: RateLimit[], now = Date.now()): string[] {
  if (!a.signedIn) return [joined('Signed out', ownLogin(a))]
  if (a.auth === 'apiKey') return ['API key · billed per token']
  const first = a.legacyToken ? 'Sign in again to show email and plan' : joined(a.email && a.email !== a.label ? a.email : undefined, a.plan, ownLogin(a))
  const windows = usageLines(a, usage, now)
  const read = a.usageFromTurns && windows.length ? lastRead(a, usage, now) : undefined
  return [first, ...(windows.length ? windows : a.usageFromTurns ? ['Usage shows after its first turn'] : []), ...(read ? [read] : [])].filter(Boolean)
}

export function accountMenuLines(a: AccountProfile, usage: RateLimit[], now = Date.now()): string[] {
  if (!a.signedIn) return ['Signed out']
  if (a.auth === 'apiKey') return ['API key · billed per token']
  const windows = usageLines(a, usage, now)
  return a.legacyToken ? ['Sign in again to show email and plan', ...windows] : windows
}

export function useFreshUsage(active: boolean) {
  useEffect(() => {
    if (active) void call('usage.get', undefined).then(actions.usage.set).catch(() => undefined)
  }, [active])
}
