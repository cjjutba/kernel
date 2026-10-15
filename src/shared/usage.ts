import type { AccountProfile, Provider, RateLimit } from './types'
import { limitProvider } from './providers'

/**
 * How full a usage window is when Settings, Account's "Pause new work when close to the limit" holds teammates (KERNEL-220).
 * 0 to 1, as `RateLimit.utilization`. Main's hold and the workspace banner both read this, so they agree on when it starts.
 */
export const NEAR_LIMIT = { five_hour: 0.9, seven_day: 0.95 } as const

/** How full the weekly window is when "Warn me before the weekly limit" warns, and when the workspace banner shows it. */
export const WEEKLY_WARN = 0.8

/**
 * The window that holds teammates now, or undefined. A 5-hour or weekly window holds from its threshold up, until its reset
 * time passes. A window whose utilization is unknown holds when Claude Code flagged it `allowed_warning`, since there is no
 * number to read. One with a number is judged by it, because a warning can come well below the threshold (a 5-hour event
 * at 81%). With two windows near, the one that lifts last wins. `now` is in milliseconds, `resetsAt` in seconds.
 */
export function nearLimit(usage: RateLimit[], now = Date.now()): RateLimit | undefined {
  const holding = usage.filter((l) => {
    if (l.type !== 'five_hour' && l.type !== 'seven_day') return false
    if (l.resetsAt === undefined || l.resetsAt * 1000 <= now) return false
    return l.utilization === undefined ? l.status === 'allowed_warning' : l.utilization >= NEAR_LIMIT[l.type]
  })
  return holding.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0]
}

const DAY = 24 * 3600_000

/** "3:40 PM": the time a limit resets, as banners, the footer and Settings say it. */
export const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/** Calendar days from `now`'s local date to `ms`'s. Rounded, so a day that daylight saving makes 23 or 25 hours still counts as one. */
const daysAhead = (ms: number, now: number) => Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY)

/**
 * When a limit resets, by calendar day in local time: "at 4:00 PM" later today, "tomorrow at 4:00 AM", "Friday at 9:00 AM"
 * 2 to 6 days out, "Oct 21 at 9:00 AM" from 7 days. Only the today form starts with "at ", so "waits until" can drop it.
 * `notice` is for Mac notifications, which can be read a day later in Notification Center: it never says today or tomorrow,
 * and names the weekday instead. `resetsAt` is in epoch seconds, `now` in milliseconds.
 */
export function resetPhrase(resetsAt: number, now: number, { notice = false } = {}): string {
  const ms = resetsAt * 1000
  const days = daysAhead(ms, now)
  const at = clock(ms)
  if (days >= 7) return `${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${at}`
  if (!notice && days <= 0) return `at ${at}`
  if (!notice && days === 1) return `tomorrow at ${at}`
  return `${new Date(ms).toLocaleDateString('en-US', { weekday: 'long' })} at ${at}`
}

/** What `switchChoices` reads of an account. */
export type SwitchAccount = Pick<AccountProfile, 'id' | 'provider' | 'active' | 'signedIn' | 'auth' | 'sameOrg' | 'keychainWait'>

/**
 * Where a provider can go when the account in use hits its 5-hour or weekly limit, as Kernel's own switch and the limit
 * banner see it (KERNEL-568, KERNEL-569, KERNEL-618). `project` holds the provider's other signed-in accounts with no rejected
 * 5-hour or weekly window, and none waiting for Keychain access: subscriptions first, the most 5-hour project first (a window past its reset has all of it, and one
 * never read goes last), then API key accounts, which Kernel never moves to on its own. Seats in one claude.ai organization
 * can share limits, so an account in the same organization as the one in use counts only when its own windows say so: a
 * 5-hour or weekly window read on it, and none rejected. When none has headroom, `signedOut` is the signed-out subscription
 * account that would have project by the same rules, for "Personal is signed out. Sign in to switch to it." `now` is in ms.
 */
export function switchChoices<A extends SwitchAccount>(provider: Provider, accounts: A[], usage: RateLimit[], now = Date.now()): { project: A[]; signedOut?: A } {
  const mine = accounts.filter((a) => a.provider === provider)
  const active = mine.find((a) => a.active)?.id ?? 'cli'
  const windows = (id: string) => usage.filter((l) => limitProvider(l) === provider && (l.accountId ?? 'cli') === id && (l.type === 'five_hour' || l.type === 'seven_day'))
  const rejected = (l: RateLimit) => l.status === 'rejected' && (l.resetsAt === undefined || l.resetsAt * 1000 > now)
  const hasProject = (a: A) => {
    const own = windows(a.id)
    return !own.some(rejected) && (!a.sameOrg?.includes(active) || own.length > 0)
  }
  const fiveHourUse = (a: A) => {
    const w = windows(a.id).find((l) => l.type === 'five_hour' && !l.model)
    if (w?.utilization === undefined) return Infinity
    return w.resetsAt !== undefined && w.resetsAt * 1000 <= now ? 0 : w.utilization
  }
  const byProject = (list: A[]) => [...list].sort((a, b) => {
    const x = fiveHourUse(a)
    const y = fiveHourUse(b)
    return x === y ? 0 : x < y ? -1 : 1
  })
  const others = mine.filter((a) => !a.active && !a.keychainWait && hasProject(a))
  const plans = (signedIn: boolean) => byProject(others.filter((a) => a.auth !== 'apiKey' && a.signedIn === signedIn))
  const project = [...plans(true), ...others.filter((a) => a.auth === 'apiKey' && a.signedIn)]
  const signedOut = project.length ? undefined : plans(false)[0]
  return { project, ...(signedOut ? { signedOut } : {}) }
}
