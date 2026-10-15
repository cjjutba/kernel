import { createContext, useCallback, useState } from 'react'

/** A row the reader was looking at, and how far into it their view sat. */
export interface Anchor { id: string; offset: number }

/** Where a chat was left. `anchors` are the row the view started in and up to two rows above it, for when that row is gone. `anchoredId` is the chat's last sent message while the space under it still stands, and `anchoredTop` where it sat from the top of the view (KERNEL-837). */
export interface Place { pinned: boolean; anchors: Anchor[]; scrollTop: number; lastUserId?: string; anchoredId?: string; anchoredTop?: number }

export interface RowBox { id: string; top: number; height: number }

const ANCHORS = 3

/** Spots last until Kernel restarts (KERNEL-765). They live here and not in the store, so nothing is persisted. */
const places = new Map<string, Place>()
const opened = new Map<string, Map<string, boolean>>()

export const savePlace = (chatId: string, place: Place) => { places.set(chatId, place) }

export const takePlace = (chatId: string): Place | undefined => places.get(chatId)

const justSent = new Map<string, number>()

/** How long a send's mark waits for the transcript that anchors it. A chat reopened after this is just a chat. */
export const JUST_SENT_MS = 15_000

/**
 * The chat was just created by a send, so the transcript that opens it anchors that message like any send (KERNEL-825). The mark stays until the anchor has
 * settled (`takeJustSent`), since the transcript can mount more than once while the chat opens and each mount must anchor (KERNEL-837).
 */
export const markJustSent = (chatId: string, now = Date.now()) => { justSent.set(chatId, now) }

/** Whether the chat's mark is still there, without using it up. A mark past JUST_SENT_MS is dropped. */
export function peekJustSent(chatId: string, now = Date.now()): boolean {
  const at = justSent.get(chatId)
  if (at === undefined) return false
  if (now - at > JUST_SENT_MS) { justSent.delete(chatId); return false }
  return true
}

export const takeJustSent = (chatId: string) => justSent.delete(chatId)

/** Forgets the chat's spot and the rows it had open, for a chat that is closed or archived. */
export function dropPlace(chatId: string) {
  places.delete(chatId)
  opened.delete(chatId)
}

/** The row the view starts in is the first whose bottom is below the top of the view. The rows above it are the fallbacks, each with its own offset. */
export function readPlace(rows: RowBox[], scrollTop: number, pinned: boolean, lastUserId?: string, anchoredId?: string): Place {
  let at = rows.findIndex((r) => r.top + r.height > scrollTop)
  if (at < 0) at = rows.length - 1
  const anchors: Anchor[] = []
  for (let i = at; i >= 0 && anchors.length < ANCHORS; i--) anchors.push({ id: rows[i].id, offset: scrollTop - rows[i].top })
  const mark = anchoredId ? rows.find((r) => r.id === anchoredId) : undefined
  return { pinned, anchors, scrollTop, lastUserId, ...(anchoredId ? { anchoredId, ...(mark ? { anchoredTop: mark.top - scrollTop } : {}) } : {}) }
}

/** The anchored message a chat gets back: the one it left with, while it is still the chat's last sent message, running or not. Anything sent since starts afresh. */
export const keptAnchor = (place: Place | undefined, lastSentId: string | undefined): string | undefined =>
  place?.anchoredId && place.anchoredId === lastSentId ? place.anchoredId : undefined

/** The scrollTop that puts the view back where it was: the first anchor whose row is still there, else the old scrollTop. Clamped to the scroll range. */
export function placeTop(place: Place, rowTop: (id: string) => number | undefined, range: number): number {
  const clamp = (n: number) => Math.max(0, Math.min(Math.max(0, range), n))
  // The anchored message is a row of its own, so it puts the view back exactly, whatever was above it or below it when the chat was left.
  const marked = place.anchoredId !== undefined && place.anchoredTop !== undefined ? rowTop(place.anchoredId) : undefined
  if (marked !== undefined && place.anchoredTop !== undefined) return clamp(marked - place.anchoredTop)
  for (const a of place.anchors) {
    const top = rowTop(a.id)
    if (top !== undefined) return clamp(top + a.offset)
  }
  return clamp(place.scrollTop)
}

/** A chat opens at its end when it has no spot, when it was left at the end, or when the reader sent a message since. `lastSentId` is the latest message the reader sent. A chat left with its sent message anchored keeps that spot, since the space under it is still there. */
export const opensAtEnd = (place: Place | undefined, lastSentId: string | undefined) =>
  !place || (lastSentId !== undefined && lastSentId !== place.lastUserId) || (place.pinned && !keptAnchor(place, lastSentId))

/** The chat a transcript shows, so a row can keep its open state without every prop passing it down. */
export const TranscriptChat = createContext<string | null>(null)

/** Open state for a row inside a chat that outlives the row being drawn. Without a chat id it is plain local state. */
export function useRowOpen(chatId: string | null, rowId: string, initial: boolean): [boolean, (open: boolean) => void] {
  const [open, set] = useState(() => (chatId ? opened.get(chatId)?.get(rowId) : undefined) ?? initial)
  const setOpen = useCallback((next: boolean) => {
    set(next)
    if (!chatId) return
    let rows = opened.get(chatId)
    if (!rows) opened.set(chatId, (rows = new Map()))
    rows.set(rowId, next)
  }, [chatId, rowId])
  return [open, setOpen]
}
