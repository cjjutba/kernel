import { useEffect } from 'react'
import type { AccountProfile, Provider, RateLimit } from '@shared/types'
import { limitProvider } from '@shared/providers'
import { clock, resetPhrase } from '@shared/usage'
import { call } from './api'
import { actions } from './store'

export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }

/** "at 3:40 PM" today, else "on Oct 9". */
const when = (ms: number, now: number) => (new Date(ms).toDateString() === new Date(now).toDateString() ? `at ${clock(ms)}` : `on ${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)

/** The account's own windows, as the engine last read them (`accountId` absent is the CLI's own login). */
const windowsOf = (a: AccountProfile, usage: RateLimit[]) => usage.filter((u) => limitProvider(u) === a.provider && (u.accountId ?? 'cli') === a.id && !u.model)

/**
 * The 5-hour and weekly windows of an account, one line each: "5-hour 62% used · resets at 3:40 PM". A window that has
 * reset since it was read says nothing, since the engine reads it again when the menu or Settings opens.
 */
export function usageLines(a: AccountProfile, usage: RateLimit[], now = Date.now()): string[] {
  const mine = windowsOf(a, usage)
  return ([['five_hour', '5-hour'], ['seven_day', 'Weekly']] as const).flatMap(([type, name]) => {
    const w = mine.find((l) => l.type === type)
    if (w?.utilization === undefined || (w.resetsAt !== undefined && w.resetsAt * 1000 <= now)) return []
    return [`${name} ${Math.round(w.utilization * 100)}% used${w.resetsAt !== undefined ? ` · resets ${resetPhrase(w.resetsAt, now)}` : ''}`]
  })
}

/** When a token account's last turn read its windows, for "As of its last turn at 2:10 PM". */
const lastRead = (a: AccountProfile, usage: RateLimit[], now: number): string | undefined => {
  const read = Math.max(0, ...windowsOf(a, usage).filter((l) => l.type === 'five_hour' || l.type === 'seven_day').map((l) => l.readAt ?? 0))
  return read ? `As of its last turn ${when(read, now)}` : undefined
}

const ownLogin = (a: AccountProfile) => (a.cli ? `${PROVIDER_NAME[a.provider]}’s own login` : undefined)
const joined = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ')

/**
 * What an account row in Settings, Providers says under its name, a line each: the email when the nickname isn't it, the plan
 * and the CLI login, then the two windows. A key says how it is billed, a signed-out account says so, and a legacy token
 * account asks for a new sign-in and shows the windows its last turn read.
 */
export function accountDetail(a: AccountProfile, usage: RateLimit[], now = Date.now()): string[] {
  if (!a.signedIn) return [joined('Signed out', ownLogin(a))]
  if (a.auth === 'apiKey') return ['API key · billed per token']
  const first = a.legacyToken ? 'Sign in again to show email and plan' : joined(a.email && a.email !== a.label ? a.email : undefined, a.plan, ownLogin(a))
  const windows = usageLines(a, usage, now)
  const read = a.usageFromTurns && windows.length ? lastRead(a, usage, now) : undefined
  return [first, ...(windows.length ? windows : a.usageFromTurns ? ['Usage shows after its first turn'] : []), ...(read ? [read] : [])].filter(Boolean)
}

/** The same for the account menu, where the plan sits beside the name, so it isn't in the lines. */
export function accountMenuLines(a: AccountProfile, usage: RateLimit[], now = Date.now()): string[] {
  if (!a.signedIn) return ['Signed out']
  if (a.auth === 'apiKey') return ['API key · billed per token']
  const windows = usageLines(a, usage, now)
  return a.legacyToken ? ['Sign in again to show email and plan', ...windows] : windows
}

/** Asks the engine for fresh usage while `active`: the account menu, or Settings, Providers, is open. What it reads arrives as pushes. */
export function useFreshUsage(active: boolean) {
  useEffect(() => {
    if (active) void call('usage.get', undefined).then(actions.usage.set).catch(() => undefined)
  }, [active])
}
