import type { Provider, RateLimit } from '@shared/types'

// Usage windows as every provider reports them, merged into what Kernel already knows (KERNEL-406).

/** A window update. Status is left out when the source doesn't know it, so an earlier warning isn't cleared. */
export type LimitPatch = Omit<RateLimit, 'status'> & { status?: RateLimit['status'] }

/** Below this, a reading of a rejected window means it lifted early (a reset on claude.ai, a bigger plan). Near 100% it may be rounding, so the rejection stands. */
const LIFTED_UNDER = 0.95

/**
 * A patch without a status keeps the stored one, unless that window has since reset or the reading shows clear room again.
 * A new window resets at least a minute later: reset times read back from ISO strings can be a second off.
 */
export function mergeLimit(prev: RateLimit | undefined, patch: LimitPatch, now: number): RateLimit {
  const reset = prev?.resetsAt !== undefined && (prev.resetsAt * 1000 <= now || (patch.resetsAt !== undefined && patch.resetsAt > prev.resetsAt + 60))
  const room = prev?.status === 'rejected' && patch.status === undefined && patch.utilization !== undefined && patch.utilization < Math.min(prev.utilization ?? 1, LIFTED_UNDER)
  return { ...prev, status: reset || room || !prev ? 'allowed' : prev.status, ...defined(patch) }
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
