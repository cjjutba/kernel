import type { IssueSummary, ProjectTracker } from '@shared/types'

/** What Up next last showed for a project: the tracker's kind and the rows `issues.next` returned. */
export type UpNextEntry = { kind?: ProjectTracker['kind']; rows: IssueSummary[] }

const cache = new Map<string, UpNextEntry>()

export function readUpNext(projectId: string): UpNextEntry | undefined {
  return cache.get(projectId)
}

/** Whether two lists show the same issues in the same order, so a refresh that found nothing new changes nothing on screen. */
export function sameIssues(a: IssueSummary[], b: IssueSummary[]): boolean {
  return a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]))
}

/**
 * Keeps a successful refresh. Returns the entry to show: the cached one when nothing changed, so React sees the same object,
 * otherwise the new one. A failed refresh never gets here, which is how it keeps the cached rows.
 */
export function storeUpNext(projectId: string, next: UpNextEntry): UpNextEntry {
  const old = cache.get(projectId)
  if (old && old.kind === next.kind && sameIssues(old.rows, next.rows)) return old
  cache.set(projectId, next)
  return next
}

export function clearUpNext(): void {
  cache.clear()
}
