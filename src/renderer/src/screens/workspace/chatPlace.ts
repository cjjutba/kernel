import { createContext, useCallback, useState } from 'react'
import { getState, subscribe } from '../../store'
import { dropSpot, getSpot, setSpot, spotKey } from '../../ui/keptScroll'

/** A row the reader was looking at, and how far into it their view sat. */
export interface Anchor { id: string; offset: number }

/** Where a chat was left. `anchors` are the row the view started in and up to two rows above it, for when that row is gone. `heights` is each row's height by id, so a reopened chat draws its rows at the size they had (KERNEL-912). */
export interface Place { pinned: boolean; anchors: Anchor[]; scrollTop: number; lastUserId?: string; heights?: Record<string, number> }

export interface RowBox { id: string; top: number; height: number }

const ANCHORS = 3

/** A chat was left at its end only within this many pixels of it (KERNEL-918). Following the end (`PIN_PX` in Transcript) is wider, but a reader 40px up left that spot, and it reopens there. */
export const END_PX = 2

export const leftAtEnd = (distFromEnd: number) => distFromEnd <= END_PX

/** A chat's spot lives in `ui/keptScroll` under `chat:<chatId>` and survives a restart (KERNEL-922). Row heights stay here in memory, since they are only worth drawing a chat in the same session. */
const heights = new Map<string, Record<string, number>>()
const opened = new Map<string, Map<string, boolean>>()

export const savePlace = (chatId: string, place: Place) => {
  if (place.heights) heights.set(chatId, place.heights)
  setSpot(spotKey.chat(chatId), { anchors: place.anchors, pos: place.scrollTop, end: place.pinned, data: { lastUserId: place.lastUserId } })
}

export const takePlace = (chatId: string): Place | undefined => {
  const spot = getSpot(spotKey.chat(chatId))
  if (!spot) return undefined
  const last = (spot.data as { lastUserId?: unknown } | undefined)?.lastUserId
  return { pinned: spot.end, anchors: spot.anchors, scrollTop: spot.pos, lastUserId: typeof last === 'string' ? last : undefined, heights: heights.get(chatId) }
}

/** Forgets the chat's spot, with the row heights it holds, and the rows it had open, for a chat that is closed or archived. */
export function dropPlace(chatId: string) {
  dropSpot(spotKey.chat(chatId))
  heights.delete(chatId)
  opened.delete(chatId)
}

/** The messages that arrived while the reader was higher up: items counted as messages that were not in the thread when they left the end. Steps and tool rows never count. */
export function countNew<T extends { id: string }>(items: T[], before: ReadonlySet<string> | null, isMessage: (item: T) => boolean): number {
  if (!before) return 0
  let n = 0
  for (const i of items) if (!before.has(i.id) && isMessage(i)) n++
  return n
}

/** Saves the open chat's spot a moment after the reader stops scrolling, so a quit keeps it (KERNEL-922). `soon` restarts the wait, `stop` cancels it. */
export function keepOpen(save: () => void, ms: number, timers: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void } = { set: (fn, t) => setTimeout(fn, t), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) }) {
  let id: unknown
  return {
    soon: () => { if (id !== undefined) timers.clear(id); id = timers.set(() => { id = undefined; save() }, ms) },
    stop: () => { if (id !== undefined) timers.clear(id); id = undefined }
  }
}

/**
 * Where a restore stands (KERNEL-918). Each frame reports the scrollTop it put the view at: after 4 frames at the same spot the restore has settled, and a later
 * frame that lands elsewhere (late layout) unsettles it. A reader leaving while it is correcting keeps the spot from before, since the view is half restored.
 */
export function restoreState() {
  let last = NaN
  let still = 0
  let settled = false
  let live = true
  return {
    /** Whether the view had to move since the last report. */
    see(at: number): boolean {
      const moved = !(Math.abs(at - last) < 0.5)
      last = at
      if (moved) { still = 0; settled = false } else if (++still >= 4) settled = true
      return moved
    },
    get settled() { return settled },
    /** The reader took over, so the view is theirs. */
    stop() { live = false },
    get live() { return live },
    /** Whether leaving now would save a half restored view. */
    get correcting() { return live && !settled }
  }
}

export interface HoldOptions {
  /** Puts the view at its target and returns the scrollTop it set. */
  put: () => number
  /** A chat opening at its end: it also stops after `capMs`, or once the chat is no longer following. A spot keeps correcting until the reader scrolls. */
  ends: boolean
  /** The reader's own scrolling, which ends the hold. */
  over: () => boolean
  following: () => boolean
  now: () => number
  raf: (step: () => void) => number
  caf: (id: number) => void
  capMs: number
  /** Called whenever the frames stop, and when they start again for a spot. */
  frames: (running: boolean) => void
}

/**
 * Puts the view back every frame until it holds still, for a chat that opens (KERNEL-918). Both paths end their `restoreState` when the frames stop, however they
 * stop (settled, time up, the reader scrolled, no longer following), except a spot that settled: that one stays live, and `resume` corrects it when the thread changes size.
 */
export function holdView(o: HoldOptions) {
  const st = restoreState()
  const from = o.now()
  let id = 0
  const stopFrames = () => { o.caf(id); id = 0; o.frames(false) }
  const step = () => {
    id = 0
    if (!st.live || o.over() || (o.ends && !o.following())) { st.stop(); return stopFrames() }
    st.see(o.put())
    if (!st.settled && !(o.ends && o.now() - from >= o.capMs)) { id = o.raf(step); return }
    if (o.ends) st.stop()
    stopFrames()
  }
  st.see(o.put())
  id = o.raf(step)
  return {
    state: st,
    /** The thread changed size: a spot is put back again, and the frames run until it holds still. */
    resume() {
      if (o.ends || !st.live || o.over()) return
      if (st.see(o.put()) && !id) { o.frames(true); id = o.raf(step) }
    },
    stop() { st.stop(); stopFrames() }
  }
}

/** Forgets the spots of the chats in every archived workspace, which nobody comes back to (KERNEL-918). `chats` is the store's chats by workspace id. */
export function dropArchived(workspaces: { id: string; status: string }[], chats: Record<string, { id: string }[] | undefined>) {
  for (const w of workspaces) if (w.status === 'archived') for (const c of chats[w.id] ?? []) dropPlace(c.id)
}

// Archiving a workspace is not a chat closing, so its chats' spots are dropped here when the workspace list changes, and the store stays as it is.
let watched = getState().workspaces
subscribe(() => {
  const list = getState().workspaces
  if (list === watched) return
  watched = list
  dropArchived(list, getState().chats)
})

/** The row the view starts in is the first whose bottom is below the top of the view. The rows above it are the fallbacks, each with its own offset. */
export function readPlace(rows: RowBox[], scrollTop: number, pinned: boolean, lastUserId?: string): Place {
  let at = rows.findIndex((r) => r.top + r.height > scrollTop)
  if (at < 0) at = rows.length - 1
  const anchors: Anchor[] = []
  for (let i = at; i >= 0 && anchors.length < ANCHORS; i--) anchors.push({ id: rows[i].id, offset: scrollTop - rows[i].top })
  return { pinned, anchors, scrollTop, lastUserId, heights: Object.fromEntries(rows.map((r) => [r.id, r.height])) }
}

/** The scrollTop that puts the view back where it was: the first anchor whose row is still there, else the old scrollTop. Clamped to the scroll range. */
export function placeTop(place: Place, rowTop: (id: string) => number | undefined, range: number): number {
  const clamp = (n: number) => Math.max(0, Math.min(Math.max(0, range), n))
  for (const a of place.anchors) {
    const top = rowTop(a.id)
    if (top !== undefined) return clamp(top + a.offset)
  }
  return clamp(place.scrollTop)
}

/** A chat opens at its end when it has no spot, when it was left at the end, or when the reader sent a message since. `lastSentId` is the latest message the reader sent. */
export const opensAtEnd = (place: Place | undefined, lastSentId: string | undefined) =>
  !place || (lastSentId !== undefined && lastSentId !== place.lastUserId) || place.pinned

/** The chat a transcript shows, so a row can keep its open state without every prop passing it down. */
export const TranscriptChat = createContext<string | null>(null)

/**
 * Open state for a row inside a chat that outlives the row being drawn. Without a chat id it is plain local state. `touched` is whether the reader
 * has set it by hand, which a row that opens or closes itself (a fold at the end of a turn) must never override.
 */
export function useRowOpen(chatId: string | null, rowId: string, initial: boolean): [boolean, (open: boolean) => void, boolean] {
  const kept = chatId ? opened.get(chatId)?.get(rowId) : undefined
  const [open, set] = useState(() => kept ?? initial)
  const [touched, touch] = useState(() => kept !== undefined)
  const setOpen = useCallback((next: boolean) => {
    set(next)
    touch(true)
    if (!chatId) return
    let rows = opened.get(chatId)
    if (!rows) opened.set(chatId, (rows = new Map()))
    rows.set(rowId, next)
  }, [chatId, rowId])
  return [open, setOpen, touched]
}
