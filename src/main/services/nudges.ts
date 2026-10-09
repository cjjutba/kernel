import type { Store } from '../db'

/** How many automatic tries one workspace gets before the Lead has to ask the user (KERNEL-125). */
export const NUDGE_LIMIT = 3

const SAVED = 'leadNudges'

interface Saved { v: 1; counts: Record<string, number>; turns: Record<string, string> }

/**
 * The loop guard. Counts the Lead turns Kernel started that sent a workspace `message_agent`, so checks that keep failing
 * can't bounce between the Lead and a teammate for ever. Several messages in one turn are one try. The counts are saved
 * under the meta key `leadNudges`.
 */
export class Nudges {
  private counts: Record<string, number> = {}
  /** The turn each workspace was last counted in, keyed by the message that started it. */
  private turns: Record<string, string> = {}

  constructor(private store: Store) {
    const saved = store.meta<Saved>(SAVED)
    if (saved?.v !== 1) return
    for (const [id, n] of Object.entries(saved.counts ?? {})) if (Number.isFinite(n) && n > 0) this.counts[id] = n
    for (const [id, t] of Object.entries(saved.turns ?? {})) if (typeof t === 'string') this.turns[id] = t
  }

  count(workspaceId: string): number { return this.counts[workspaceId] ?? 0 }

  /** The workspace had its tries: a new one goes to the user instead. More messages in the turn that made the last try go through. */
  spent(workspaceId: string, turn?: string): boolean {
    return this.count(workspaceId) >= NUDGE_LIMIT && !(turn && this.turns[workspaceId] === turn)
  }

  /** One more try, unless this turn already counted for the workspace. A turn with no key counts every message. */
  add(workspaceId: string, turn?: string) {
    if (turn && this.turns[workspaceId] === turn) return
    this.counts[workspaceId] = this.count(workspaceId) + 1
    if (turn) this.turns[workspaceId] = turn
    this.save()
  }

  /** The user stepped in, or the work moved on (its PR became ready or merged). */
  reset(...workspaceIds: string[]) {
    let changed = false
    for (const id of workspaceIds) if (id in this.counts || id in this.turns) { delete this.counts[id]; delete this.turns[id]; changed = true }
    if (changed) this.save()
  }

  private save() { this.store.saveMeta<Saved>(SAVED, { v: 1, counts: this.counts, turns: this.turns }) }
}
