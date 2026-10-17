import type { Provider, RateLimit } from '@shared/types'

// Usage windows as every provider reports them, merged into what Kernel already knows (KERNEL-406).

/** A window update. Status is left out when the source doesn't know it, so an earlier warning isn't cleared. */
export type LimitPatch = Omit<RateLimit, 'status'> & { status?: RateLimit['status'] }

/** Below this, a reading of a rejected window means it lifted early (a reset on claude.ai, a bigger plan). Near 100% it may be rounding, so the rejection stands. */
const LIFTED_UNDER = 0.95

/**
 * A reading lower than the stored one by more than this, in the same window, is a real drop: a reset on claude.ai, a bigger
 * plan, or the CLI's login switching account under the same key. A smaller drop is a stale snapshot and is ignored (KERNEL-700).
 */
const DROPPED_BY = 0.05

/** A rejection stands this long after it began, whatever the readings say, while its reset time is ahead: readings can be a minute old (KERNEL-1030). */
export const REJECT_HOLD_MS = 2 * 60_000

/** Whether a rejected window is inside its hold. A rejection from before `rejectedAt` existed has none. */
const holding = (prev: RateLimit, now: number) => now - (prev.rejectedAt ?? 0) < REJECT_HOLD_MS

/** Why a rejected window lifted, for the log: its reset time passed, or a reading showed clear project after the hold. */
export function liftedBy(prev: RateLimit, now: number): string {
  return prev.resetsAt !== undefined && prev.resetsAt * 1000 <= now ? 'reset time passed' : `reading under ${LIFTED_UNDER * 100}% after the hold`
}

/**
 * A rejected window stands until its reset time passes, or a reading under LIFTED_UNDER arrives once REJECT_HOLD_MS have gone
 * by since it began. A status in a patch never lifts it by itself: another chat's event can be older than the rejection
 * (KERNEL-1030, narrowing KERNEL-700). A patch without a status keeps the stored one, and a window that isn't rejected starts anew when a reset time over a minute later arrives.
 * Within one window usage only goes up, unless it drops clearly: Claude Code answers from a snapshot up to a minute old, one
 * per session, so an older reading can land after a newer one (KERNEL-700).
 */
export function mergeLimit(prev: RateLimit | undefined, patch: LimitPatch, now: number): RateLimit {
  const passed = prev?.resetsAt !== undefined && prev.resetsAt * 1000 <= now
  const standing = prev?.status === 'rejected' && !passed
  const reset = passed || (prev?.resetsAt !== undefined && prev.status !== 'rejected' && patch.resetsAt !== undefined && patch.resetsAt > prev.resetsAt + 60)
  const lifts = standing && !holding(prev!, now) && patch.utilization !== undefined && patch.utilization < LIFTED_UNDER
  const stale = !reset && prev?.utilization !== undefined && patch.utilization !== undefined && patch.utilization < prev.utilization && (prev.utilization - patch.utilization <= DROPPED_BY || (standing && !lifts))
  const status: RateLimit['status'] = !prev || reset ? patch.status ?? 'allowed'
    : standing && (!lifts || patch.status === 'rejected') ? 'rejected'
    : patch.status ?? (lifts ? 'allowed' : prev.status)
  const merged: RateLimit = { ...prev, ...defined(patch), status, ...(stale ? { utilization: prev!.utilization } : {}) }
  if (status !== 'rejected') { delete merged.rejectedAt; delete merged.provisional; return merged }
  merged.rejectedAt = standing ? prev.rejectedAt ?? now : now
  if (patch.provisional === undefined && patch.resetsAt !== undefined) delete merged.provisional
  return merged
}

/**
 * What notifications and chat notes call each window: "Notify me", a reset of an account left at its limit, and the note
 * after a switch (KERNEL-568). Claude Code calls `seven_day_overage_included` the Fable limit.
 */
export const LIMIT_NAME: Record<RateLimit['type'], string> = {
  five_hour: '5-hour limit', seven_day: 'weekly limit', seven_day_opus: 'Opus limit', seven_day_sonnet: 'Sonnet limit', seven_day_overage_included: 'Fable limit', overage: 'extra usage limit'
}

/** The object without its undefined values. */
export const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/**
 * Where Kernel keeps a usage window: by provider, account and window (KERNEL-406). A Claude window on the CLI's own login
 * keeps its type alone as the key, as every saved limit from before had.
 */
export function limitKey(l: { type: RateLimit['type']; provider?: Provider; accountId?: string }): string {
  const provider = l.provider ?? 'claude'
  return provider === 'claude' && !l.accountId ? l.type : `${provider}:${l.accountId ?? ''}:${l.type}`
}
