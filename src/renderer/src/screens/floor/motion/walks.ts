import { type Waypoint, path } from './waypoints'

/** Where someone is: at their desk (sitting), or standing at a waypoint. */
export type Spot = Waypoint | 'seat'

/** One place the briefing sequence sends someone. `key` names the event behind it, so one event never sends them twice. */
export interface Leg {
  key: string
  to: Spot
}

/** One person's walk. Moves queue up, so a burst of events walks every leg in turn instead of teleporting. */
export interface Track {
  /** Where they are drawn now. */
  at: Spot
  /** Steps still to walk, one per tick. */
  queue: Spot[]
  /** Where the queue ends. */
  dest: Spot
  /** Keys of the legs already queued. */
  seen: string[]
}

/** The canvas moves one waypoint per 950 ms (CSS transitions of 0.9s), and the first step 60 ms after the event. */
export const STEP_MS = 950
export const FIRST_STEP_MS = 60

/** Steps from one spot to another. Leaving the desk starts at the spot beside it, and arriving at the desk ends by sitting down. */
export function route(from: Spot, to: Spot, desk: Waypoint): Spot[] {
  if (from === to) return []
  const steps: Spot[] = from === 'seat' ? [desk] : []
  steps.push(...path(from === 'seat' ? desk : from, to === 'seat' ? desk : to))
  if (to === 'seat') steps.push('seat')
  return steps
}

/** Someone with nothing to walk. `seen` marks legs that already put them here. */
export const track = (at: Spot, seen: string[] = []): Track => ({ at, queue: [], dest: at, seen })

/** Where a person first shows up: wherever their legs end, without walking there. */
export const start = (legs: Leg[]): Track => track(legs[legs.length - 1]?.to ?? 'seat', legs.map((l) => l.key))

/** Queue every leg not walked yet, in order, then make sure the walk ends where the last leg says. */
export function plan(t: Track, legs: Leg[], desk: Waypoint): Track {
  let { queue, dest } = t
  const seen = [...t.seen]
  const go = (to: Spot) => {
    if (to === dest) return
    queue = [...queue, ...route(dest, to, desk)]
    dest = to
  }
  for (const leg of legs) {
    if (seen.includes(leg.key)) continue
    seen.push(leg.key)
    go(leg.to)
  }
  const last = legs[legs.length - 1]
  if (last) go(last.to)
  return { at: t.at, queue, dest, seen: seen.slice(-100) }
}

/** Walk one step. */
export function step(t: Track): Track {
  if (!t.queue.length) return t
  const [at, ...queue] = t.queue
  return { ...t, at, queue }
}

/** Jump to where the walk ends: reduced motion, walking turned off, or catching up after the window was away. */
export const settle = (t: Track): Track => (t.queue.length ? { ...t, at: t.dest, queue: [] } : t)
