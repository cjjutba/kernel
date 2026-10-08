import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { Waypoint } from './waypoints'
import { FIRST_STEP_MS, STEP_MS, type Leg, type Spot, type Track, plan, settle, start, step, track } from './walks'

export interface Walk {
  id: string
  /** The waypoint beside their desk, where they stand up and sit down. */
  desk: Waypoint
  legs: Leg[]
  /** Where they first show up, when it is not where their legs end: a new hire arrives at the door and walks in. */
  from?: Spot
}

export interface Pose {
  at: Spot
  /** Steps are still queued: stride. */
  moving: boolean
  /** Which way they look while they talk to someone: 1 right, -1 left. */
  facing?: 1 | -1
}

/** After the window has been away this long, coming back jumps every walk to its end instead of finishing it on screen. */
const CATCH_UP_MS = 1000

/** True while the system asks for reduced motion. */
export function useReducedMotion(): boolean {
  const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  const [reduced, setReduced] = useState(!!query?.matches)
  useEffect(() => {
    if (!query) return
    const on = () => setReduced(query.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [query?.media])
  return reduced
}

/**
 * Runs each person's walk: new legs queue behind the ones still walking, one waypoint per step.
 * `instant` (reduced motion, or walking turned off) jumps straight to each destination instead.
 * A person seen for the first time starts where their legs end, so a fixture or a reload never replays old walks.
 */
export function useWalks(walks: Walk[], instant: boolean): { poses: Record<string, Pose>; jumping: boolean } {
  const tracks = useRef<Map<string, Track> | null>(null)
  if (!tracks.current) tracks.current = new Map(walks.map((w) => [w.id, w.from ? track(w.from) : start(w.legs)]))
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [, render] = useReducer((n: number) => n + 1, 0)
  // True for the frames of a catch-up, so the stage drops its 0.9s glides and people jump instead of sliding through furniture.
  const [jumping, setJumping] = useState(false)

  const stop = (id: string) => {
    const t = timers.current.get(id)
    if (t) clearTimeout(t)
    timers.current.delete(id)
  }
  const schedule = (id: string, ms: number) => {
    if (timers.current.has(id)) return
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id)
      const t = tracks.current!.get(id)
      if (!t) return
      const next = step(t)
      tracks.current!.set(id, next)
      render()
      if (next.queue.length) schedule(id, STEP_MS)
    }, ms))
  }
  const catchUp = () => {
    if (![...tracks.current!.values()].some((t) => t.queue.length)) return
    for (const [id, t] of tracks.current!) { stop(id); tracks.current!.set(id, settle(t)) }
    setJumping(true)
    render()
    requestAnimationFrame(() => requestAnimationFrame(() => setJumping(false)))
  }

  const key = JSON.stringify(walks)
  useLayoutEffect(() => {
    const map = tracks.current!
    let changed = false
    for (const w of walks) {
      const before = map.get(w.id)
      let next = before ? plan(before, w.legs, w.desk) : w.from ? plan(track(w.from), w.legs, w.desk) : start(w.legs)
      if (instant) { stop(w.id); next = settle(next) }
      if (!before || next.at !== before.at || next.queue.length !== before.queue.length || next.dest !== before.dest) changed = true
      map.set(w.id, next)
      // A walk already under way keeps its own timer; a new one takes its first step right away.
      if (next.queue.length) schedule(w.id, FIRST_STEP_MS)
    }
    for (const id of [...map.keys()]) if (!walks.some((w) => w.id === id)) { stop(id); map.delete(id); changed = true }
    if (changed) render()
  }, [key, instant])

  useEffect(() => {
    let awayAt = document.hasFocus() ? 0 : Date.now()
    const blur = () => { awayAt = Date.now() }
    const focus = () => { if (awayAt && Date.now() - awayAt >= CATCH_UP_MS) catchUp(); awayAt = 0 }
    const visible = () => { if (document.visibilityState === 'visible') catchUp(); else awayAt = Date.now() }
    window.addEventListener('blur', blur)
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('blur', blur)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visible)
      for (const id of [...timers.current.keys()]) stop(id)
    }
  }, [])

  const out: Record<string, Pose> = {}
  for (const [id, t] of tracks.current) out[id] = { at: t.at, moving: t.queue.length > 0 }
  return { poses: out, jumping }
}
