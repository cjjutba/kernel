import { useLayoutEffect, useRef, type RefObject } from 'react'
import { getState, subscribe, type State } from '../store'
import { readSaved, writeSaved } from '../remember'

/**
 * Kept scroll (KERNEL-919): a view opens where it was left, and that survives a restart. The contract is in docs/decisions/KERNEL-919.md.
 * A spot is the item at the top of the view with the offset into it, two items above it as fallbacks, and the raw position as a last resort.
 */

/** An item the view started in, and how far into it the view sat. */
export interface Anchor { id: string; offset: number }

/** Where a view was left. `pos` is scrollTop, or scrollLeft on the x axis. `data` is room for a caller's own payload, such as a chat's heights. */
export interface Spot { anchors: Anchor[]; pos: number; end: boolean; data?: unknown }

/** An item with where it starts along the scroll axis, and its size. */
export interface Box { id: string; start: number; size: number }

const ANCHORS = 3
/** Within this many pixels of the end counts as the end. */
export const END_PX = 2
export const MAX_SPOTS = 300
export const STORAGE_KEY = 'kernel.keptScroll.v1'
const VERSION = 1
const WRITE_MS = 400

/** The key for each kind of view, so callers don't spell them by hand. */
export const spotKey = {
  prs: (filter: string) => `prs:${filter}`,
  issues: (projectId: string) => `issues:${projectId}`,
  inbox: (part: 'list' | 'pane', id?: string) => (id ? `inbox:${part}:${id}` : `inbox:${part}`),
  settings: (scope: 'project' | 'app', page: string, projectId?: string) => (scope === 'project' ? `settings:project:${projectId}:${page}` : `settings:app:${page}`),
  panel: (workspaceId: string, tab: string) => `panel:${workspaceId}:${tab}`,
  chat: (chatId: string) => `chat:${chatId}`
}

const clampTo = (range: number, n: number) => Math.max(0, Math.min(Math.max(0, range), n))

/** The item the view starts in is the first whose far edge is past `pos`. The items above it are the fallbacks, each with its own offset. */
export function readSpot(items: Box[], pos: number, range: number, data?: unknown): Spot {
  let at = items.findIndex((r) => r.start + r.size > pos)
  if (at < 0) at = items.length - 1
  const anchors: Anchor[] = []
  for (let i = at; i >= 0 && anchors.length < ANCHORS; i--) anchors.push({ id: items[i].id, offset: pos - items[i].start })
  const spot: Spot = { anchors, pos, end: range - pos <= END_PX }
  if (data !== undefined) spot.data = data
  return spot
}

/** Where the spot asks the view to be, before the range limits it: the first anchor still there, else the old position. */
export function spotWants(spot: Spot, startOf: (id: string) => number | undefined): number {
  for (const a of spot.anchors) {
    const start = startOf(a.id)
    if (start !== undefined) return start + a.offset
  }
  return spot.pos
}

/** Where the spot puts the view: the new end for a view left at its end, else where it wants to be. Clamped to the scroll range. */
export const spotTop = (spot: Spot, startOf: (id: string) => number | undefined, range: number): number =>
  clampTo(range, spot.end ? range : spotWants(spot, startOf))

const valid = (s: unknown): s is Spot => {
  const v = s as Spot | null
  return !!v && typeof v.pos === 'number' && typeof v.end === 'boolean' && Array.isArray(v.anchors) && v.anchors.every((a) => a && typeof a.id === 'string' && typeof a.offset === 'number')
}

/** The spots, least recently used first. A Map keeps insertion order, so touching a key moves it last. */
const spots = new Map<string, Spot>()
let loaded = false
let writer: ReturnType<typeof setTimeout> | undefined

function load() {
  if (loaded) return
  loaded = true
  try {
    const raw = readSaved(STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as { v?: number; spots?: unknown }
    if (saved.v !== VERSION || !Array.isArray(saved.spots)) return
    for (const row of saved.spots) {
      if (Array.isArray(row) && typeof row[0] === 'string' && valid(row[1])) spots.set(row[0], row[1])
    }
    while (spots.size > MAX_SPOTS) spots.delete(spots.keys().next().value as string)
  } catch { /* blocked or corrupt storage starts empty */ }
}

/** Writes the spots now. Called after a short delay, and when the window goes away. */
export function flushSpots() {
  clearTimeout(writer)
  writer = undefined
  writeSaved(STORAGE_KEY, JSON.stringify({ v: VERSION, spots: [...spots] }))
}

const later = () => { clearTimeout(writer); writer = setTimeout(flushSpots, WRITE_MS) }

/** The spot, marked as used just now. */
export function getSpot(key: string): Spot | undefined {
  load()
  const s = spots.get(key)
  if (s) { spots.delete(key); spots.set(key, s) }
  return s
}

/** Stores a spot. A caller that finds its own anchors (a chat's transcript, KERNEL-922) saves through this under `spotKey.chat`. */
export function setSpot(key: string, spot: Spot) {
  load()
  spots.delete(key)
  spots.set(key, spot)
  while (spots.size > MAX_SPOTS) spots.delete(spots.keys().next().value as string)
  later()
}

export function dropSpot(key: string) {
  load()
  if (spots.delete(key)) later()
}

export const spotKeys = () => { load(); return [...spots.keys()] }

/** Forgets every spot and starts over. For tests. */
export function resetSpots() {
  spots.clear()
  loaded = false
  clearTimeout(writer)
  writer = undefined
}

// Pruning. A key names a workspace, chat or project that can be archived or deleted, and its spot goes with it.

/** The part of the store that decides whether a key is still alive. `null` is not loaded yet, which keeps everything. */
export interface Alive {
  projects: ReadonlySet<string> | null
  workspaces: ReadonlySet<string> | null
  /** Open chats by id, once every workspace's chats are in. */
  chats: ReadonlySet<string> | null
}

export function aliveOf(s: Pick<State, 'projects' | 'workspaces' | 'chats'>): Alive {
  const live = s.workspaces.filter((w) => w.status !== 'archived')
  const chats = new Set(Object.values(s.chats).flatMap((list) => list.filter((c) => !c.closed).map((c) => c.id)))
  const owners = new Set(live.map((w) => w.id))
  // Chats load per workspace. Judging before every live workspace has its list in would drop chats that are just not here yet.
  const all = live.length > 0 && live.every((w) => w.id in s.chats)
  // A chat of an archived workspace has no tab to reopen on.
  for (const [ws, list] of Object.entries(s.chats)) if (!owners.has(ws)) list.forEach((c) => chats.delete(c.id))
  return {
    projects: s.projects.length ? new Set(s.projects.filter((p) => !p.archived).map((p) => p.id)) : null,
    workspaces: s.workspaces.length ? owners : null,
    chats: all ? chats : null
  }
}

/** Keys whose project, workspace or chat is gone. A kind that isn't loaded yet judges nothing. */
export function deadKeys(keys: string[], alive: Alive): string[] {
  return keys.filter((k) => {
    const [kind, a, b] = k.split(':')
    if (kind === 'issues') return !!alive.projects && !alive.projects.has(a)
    if (kind === 'settings' && a === 'project') return !!alive.projects && !alive.projects.has(b)
    if (kind === 'panel') return !!alive.workspaces && !alive.workspaces.has(a)
    if (kind === 'chat') return !!alive.chats && !alive.chats.has(a)
    return false
  })
}

export function pruneSpots(alive: Alive) {
  load()
  const dead = deadKeys([...spots.keys()], alive)
  dead.forEach((k) => spots.delete(k))
  if (dead.length) later()
  return dead
}

/** Prunes at startup, once the store has what it needs, and whenever projects, workspaces or chats change. Needs nothing from `store.ts` beyond reading it. */
function watchStore() {
  let seen: unknown[] = []
  const check = () => {
    const s = getState()
    const now = [s.projects, s.workspaces, s.chats]
    if (now.every((v, i) => v === seen[i])) return
    seen = now
    pruneSpots(aliveOf(s))
  }
  subscribe(check)
  check()
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flushSpots)
}
watchStore()

// The hook.

export interface KeptScrollOptions {
  /** Which spot this view keeps. Build it with `spotKey`. A new key is a new view: it restores that key's spot, or starts at the start. */
  key: string
  /** The view's data has loaded. Nothing restores or saves before it, so a loading state can't overwrite a good spot. */
  ready: boolean
  /** The rows that carry `data-keep-id`. */
  itemSelector?: string
  axis?: 'y' | 'x'
  /** The view is going somewhere on purpose (a notification, a search result, a j or k): the saved spot is not applied. */
  target?: boolean
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '])
const OPEN_MS = 600
const STILL_FRAMES = 4

/** Reads an element's items as boxes along its axis. */
export function boxesOf(el: HTMLElement, selector: string, axis: 'y' | 'x'): Box[] {
  const x = axis === 'x'
  const base = el.getBoundingClientRect()[x ? 'left' : 'top'] - (x ? el.scrollLeft : el.scrollTop)
  const out: Box[] = []
  for (const node of el.querySelectorAll<HTMLElement>(selector)) {
    const id = node.getAttribute('data-keep-id')
    const r = node.getBoundingClientRect()
    const size = x ? r.width : r.height
    if (id && size > 0) out.push({ id, start: (x ? r.left : r.top) - base, size })
  }
  return out
}

/**
 * Keeps a scroller's spot. Restores in a layout effect before paint with no animation, once `ready`, and keeps putting the view back until its size holds still.
 * The reader's own input stops a restore at once. A view that never restored never saves, and one still restoring doesn't save.
 * Returns `stop`, which ends a restore in progress, for a view that scrolls somewhere on purpose.
 */
export function useKeptScroll(ref: RefObject<HTMLElement | null>, { key, ready, itemSelector = '[data-keep-id]', axis = 'y', target = false }: KeptScrollOptions) {
  const stopper = useRef<() => void>(() => undefined)
  const aim = useRef(target)
  aim.current = target
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !ready) return
    const x = axis === 'x'
    const pos = () => (x ? el.scrollLeft : el.scrollTop)
    const range = () => (x ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight)
    const set = (n: number) => { if (x) el.scrollLeft = n; else el.scrollTop = n }
    const st = { restored: false, restoring: false, touched: false, keep: false }
    let again = 0

    const finish = () => { cancelAnimationFrame(again); st.restoring = false; st.restored = true }
    const take = () => { st.touched = true; st.keep = false; if (st.restoring) finish() }
    const press = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key) && !(e.target as Element).closest('input, textarea, select, [contenteditable="true"]')) take()
    }
    const pointer = (e: PointerEvent) => { if (e.target === el) take() }
    const onScroll = () => {
      if (!st.restored || st.restoring) return
      // A restore the view was too short for keeps the spot it was given until the reader moves.
      if (st.keep && !st.touched) return
      setSpot(key, readSpot(boxesOf(el, itemSelector, axis), pos(), range()))
    }
    el.addEventListener('wheel', take, { passive: true })
    el.addEventListener('touchstart', take, { passive: true })
    el.addEventListener('pointerdown', pointer)
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', press)
    stopper.current = () => { if (st.restoring) take() }

    const spot = aim.current ? undefined : getSpot(key)
    if (!spot) {
      // Nothing to go back to, or somewhere else to go: a view with no spot starts at the start.
      if (!aim.current) set(0)
      st.restored = true
    } else {
      const put = () => {
        const starts = new Map(boxesOf(el, itemSelector, axis).map((b) => [b.id, b.start]))
        const at = (id: string) => starts.get(id)
        // A view too short for the spot goes to its end and keeps the spot it was given until the reader moves.
        st.keep = !spot.end && spotWants(spot, at) > range() + END_PX
        set(spotTop(spot, at, range()))
      }
      st.restoring = true
      put()
      let size = el.scrollHeight + el.scrollWidth
      let still = 0
      const from = performance.now()
      const step = () => {
        if (!st.restoring) return
        put()
        const now = el.scrollHeight + el.scrollWidth
        still = now === size ? still + 1 : 0
        size = now
        if (still < STILL_FRAMES && performance.now() - from < OPEN_MS) again = requestAnimationFrame(step)
        else finish()
      }
      again = requestAnimationFrame(step)
    }
    return () => {
      cancelAnimationFrame(again)
      el.removeEventListener('wheel', take)
      el.removeEventListener('touchstart', take)
      el.removeEventListener('pointerdown', pointer)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('keydown', press)
      stopper.current = () => undefined
    }
  }, [key, ready, itemSelector, axis])
  return { stop: () => stopper.current() }
}
