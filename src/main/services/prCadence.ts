import type { GitHubStatus } from '@shared/types'
import type { RateLimit } from './github'

/**
 * How often Kernel reads its PRs from GitHub, and when it holds off (KERNEL-388). A PR that is moving, its checks running or
 * GitHub still checking it for conflicts, is read every `fastMs`; when every PR waits on someone, every `calmMs`. Kernel's
 * reads share the token's GraphQL points with every agent's `gh`, so below a fifth of them left it reads every `lowMs`, and
 * below a twentieth it reads nothing until the limit resets. GitHub's "slow down" limit backs off from `backoffMs`, doubling.
 */
export interface Cadence {
  fastMs: number
  calmMs: number
  lowMs: number
  /** How soon a poll Kernel asks for, on window focus, a wake or a merge, runs. */
  soonMs: number
  /** The least time between two polls Kernel asks for, so focus going back and forth doesn't read GitHub each time. */
  minGapMs: number
  /** How often the poll also flushes held Lead updates and retries waits, and how long after launch it first does. */
  choresMs: number
  backoffMs: number
  backoffMaxMs: number
  /** The longest a rate limit pauses the poll, whatever reset time GitHub gives. */
  pauseMaxMs: number
}

export const CADENCE: Cadence = {
  fastMs: 10_000, calmMs: 30_000, lowMs: 60_000, soonMs: 1_000, minGapMs: 5_000, choresMs: 45_000,
  backoffMs: 60_000, backoffMaxMs: 15 * 60_000, pauseMaxMs: 60 * 60_000
}

/** The share of the rate limit below which the poll slows down, and below which it stops until the reset. */
const LOW = 0.2
const FLOOR = 0.05

export class PrCadence {
  c: Cadence = { ...CADENCE }
  private startedAt = 0
  private choresAt = 0
  private pausedUntil = 0
  private low = false
  private backoff = 0
  /** The reset the last batch read reported. `gh api rate_limit` can report another one, so a pause takes the later. */
  private resetAt = 0
  /** The pause is GitHub's "slow down" limit, not its rate limit running out. Set by whichever pause set `pausedUntil` (KERNEL-401). */
  private slowDown = false

  constructor(private now: () => number = Date.now) {}

  started() {
    this.startedAt = this.choresAt = this.now()
    this.pausedUntil = 0
    this.low = false
    this.backoff = 0
    this.slowDown = false
  }

  /** What a read said is left of the rate limit. */
  rated(r: RateLimit) {
    this.resetAt = r.resetAt
    const left = r.limit > 0 ? r.remaining / r.limit : 1
    this.low = left < LOW
    if (left < FLOOR) this.pauseUntil(r.resetAt, false)
  }

  /**
   * A read GitHub refused for a rate limit. The primary limit pauses until `resetAt` when it is known; the "slow down" limit,
   * or a reset nobody knows, backs off from `backoffMs`, doubling up to `backoffMaxMs`.
   */
  limited(o: { secondary?: boolean; resetAt?: number }) {
    const resetAt = Math.max(o.resetAt ?? 0, this.resetAt)
    if (!o.secondary && resetAt > this.now()) { this.low = true; this.pauseUntil(resetAt, false); return }
    this.backoff = this.backoff ? Math.min(this.backoff * 2, this.c.backoffMaxMs) : this.c.backoffMs
    // A primary limit with no known reset backs off the same way, and is still the rate limit.
    this.pauseUntil(this.now() + this.backoff, !!o.secondary)
  }

  /** A read went through, so the next "slow down" starts its backoff over. */
  ok() { this.backoff = 0 }

  /** Whether the poll holds off for a rate limit. Reads the user starts still run. */
  paused() { return this.now() < this.pausedUntil }

  /** When the pause ends, for a message that says when Kernel reads again. */
  resumesAt() { return this.paused() ? this.pausedUntil : undefined }

  /** The pause as the footer shows it: nothing while Kernel reads, else until when and which limit (KERNEL-401). */
  status(): GitHubStatus {
    return this.paused() ? { pausedUntil: this.pausedUntil, ...(this.slowDown ? { slowDown: true } : {}) } : {}
  }

  /** How long until the next poll: the rest of a pause, else by how low the rate limit is and whether a PR is moving. */
  delay(moving: boolean): number {
    const wait = this.pausedUntil - this.now()
    if (wait > 0) return wait
    return this.low ? this.c.lowMs : moving ? this.c.fastMs : this.c.calmMs
  }

  /** Whether this poll also flushes Lead updates and retries waits: never at launch, then every `choresMs`. */
  choresDue() { return this.now() - this.choresAt >= this.c.choresMs && this.now() - this.startedAt >= this.c.choresMs }
  choresRan() { this.choresAt = this.now() }

  /** Pauses until `at`, at most `pauseMaxMs` away. A pause already running longer stays, with its own reason. */
  private pauseUntil(at: number, slowDown: boolean) {
    const until = Math.min(at, this.now() + this.c.pauseMaxMs)
    if (until <= this.pausedUntil) return
    this.pausedUntil = until
    this.slowDown = slowDown
  }
}
