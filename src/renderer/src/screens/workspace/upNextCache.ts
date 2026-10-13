import type { IssueSummary, RoomTracker } from '@shared/types'

/** What Up next last showed for a room: the tracker's kind and the rows `issues.next` returned. */
export type UpNextEntry = { kind?: RoomTracker['kind']; rows: IssueSummary[] }

const cache = new Map<string, UpNextEntry>()

export function readUpNext(roomId: string): UpNextEntry | undefined {
  return cache.get(roomId)
}

/** Whether two lists show the same issues in the same order, so a refresh that found nothing new changes nothing on screen. */
export function sameIssues(a: IssueSummary[], b: IssueSummary[]): boolean {
  return a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]))
}

/**
 * Keeps a successful refresh. Returns the entry to show: the cached one when nothing changed, so React sees the same object,
 * otherwise the new one. A failed refresh never gets here, which is how it keeps the cached rows.
 */
export function storeUpNext(roomId: string, next: UpNextEntry): UpNextEntry {
  const old = cache.get(roomId)
  if (old && old.kind === next.kind && sameIssues(old.rows, next.rows)) return old
  cache.set(roomId, next)
  return next
}

export function clearUpNext(): void {
  cache.clear()
}
