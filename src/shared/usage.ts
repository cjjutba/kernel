import type { RateLimit } from './types'

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

/** "at 3:40 PM" within a day, else "Monday at 9:00 AM". `resetsAt` is in epoch seconds, `now` in milliseconds. */
export function resetPhrase(resetsAt: number, now: number): string {
  const ms = resetsAt * 1000
  return ms - now < DAY ? `at ${clock(ms)}` : `${new Date(ms).toLocaleDateString('en-US', { weekday: 'long' })} at ${clock(ms)}`
}
