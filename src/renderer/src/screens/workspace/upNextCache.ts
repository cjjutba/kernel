import type { IssueSummary, ProjectTracker } from '@shared/types'
import { call } from '../../api'
import { readSavedJson, writeSaved, writeSavedJson } from '../../remember'

/** What Up next last showed for a project: the tracker's kind and the rows `issues.next` returned. */
export type UpNextEntry = { kind?: ProjectTracker['kind']; rows: IssueSummary[] }

const cache = new Map<string, UpNextEntry>()
/** Every project's last entry, saved as one record so a restart starts from the last list and clearing is one removal. */
const SAVED = 'upNext'
let loaded = false

const isEntry = (v: unknown): v is UpNextEntry =>
  !!v && typeof v === 'object' && Array.isArray((v as UpNextEntry).rows) && (v as UpNextEntry).rows.every((r) => !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.title === 'string')

/** Loads the saved entries into memory once, on the first read. Junk or nothing saved acts like no cache; an entry already in memory wins. */
function load() {
  if (loaded) return
  loaded = true
  const saved = readSavedJson<Record<string, unknown>>(SAVED, (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}))
  for (const [id, entry] of Object.entries(saved)) if (isEntry(entry) && !cache.has(id)) cache.set(id, { kind: entry.kind, rows: entry.rows })
}

export function readUpNext(projectId: string): UpNextEntry | undefined {
  load()
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
  load()
  const old = cache.get(projectId)
  if (old && old.kind === next.kind && sameIssues(old.rows, next.rows)) return old
  cache.set(projectId, next)
  writeSavedJson(SAVED, Object.fromEntries(cache))
  return next
}

/**
 * Asks for a project's Up next and keeps the answer through `storeUpNext`: the one path the component and the launch fetch share.
 * Both calls start at once, since main resolves the tracker for `issues.next` itself. A call that failed keeps what the cache had,
 * and both failing leaves the cached entry as it was. Resolves to the entry to show.
 */
export async function refreshUpNext(projectId: string): Promise<UpNextEntry | undefined> {
  const [rows, kind] = await Promise.all([
    call('issues.next', { projectId }).then((r): IssueSummary[] | undefined => r, () => undefined),
    call('issues.tracker', { projectId }).then((t): ProjectTracker['kind'] | undefined => t.kind, () => undefined),
  ])
  const old = readUpNext(projectId)
  return rows || kind !== undefined ? storeUpNext(projectId, { kind: kind ?? old?.kind, rows: rows ?? old?.rows ?? [] }) : old
}

export function clearUpNext(): void {
  cache.clear()
  loaded = true
  writeSaved(SAVED, null)
}
