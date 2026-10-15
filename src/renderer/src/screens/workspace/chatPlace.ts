import { createContext, useCallback, useState } from 'react'

/** A row the reader was looking at, and how far into it their view sat. */
export interface Anchor { id: string; offset: number }

/** Where a chat was left. `anchors` are the row the view started in and up to two rows above it, for when that row is gone. */
export interface Place { pinned: boolean; anchors: Anchor[]; scrollTop: number; lastUserId?: string }

export interface RowBox { id: string; top: number; height: number }

const ANCHORS = 3

/** Spots last until Kernel restarts (KERNEL-765). They live here and not in the store, so nothing is persisted. */
const places = new Map<string, Place>()
const opened = new Map<string, Map<string, boolean>>()

export const savePlace = (chatId: string, place: Place) => { places.set(chatId, place) }

export const takePlace = (chatId: string): Place | undefined => places.get(chatId)

/** Forgets the chat's spot and the rows it had open, for a chat that is closed or archived. */
export function dropPlace(chatId: string) {
  places.delete(chatId)
  opened.delete(chatId)
}

/** The row the view starts in is the first whose bottom is below the top of the view. The rows above it are the fallbacks, each with its own offset. */
export function readPlace(rows: RowBox[], scrollTop: number, pinned: boolean, lastUserId?: string): Place {
  let at = rows.findIndex((r) => r.top + r.height > scrollTop)
  if (at < 0) at = rows.length - 1
  const anchors: Anchor[] = []
  for (let i = at; i >= 0 && anchors.length < ANCHORS; i--) anchors.push({ id: rows[i].id, offset: scrollTop - rows[i].top })
  return { pinned, anchors, scrollTop, lastUserId }
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
