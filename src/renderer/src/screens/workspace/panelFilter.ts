import type { FileEntry } from '@shared/types'

/** What a filter box holds, as matched: trimmed and lower case, so "Inbox " finds `src/shared/inbox.ts`. Empty means no filter. */
export const filterQuery = (text: string) => text.trim().toLowerCase()

/** A path matches when it contains the query anywhere, folders included, so "screens/inbox" finds what is in that folder. */
export const matchesPath = (path: string, query: string) => !query || path.toLowerCase().includes(query)

/** Where `query` sits in `path`, as `[start, end)` pairs for the highlight. Matches don't overlap. */
export function matchRanges(path: string, query: string): [number, number][] {
  const out: [number, number][] = []
  if (!query) return out
  const lower = path.toLowerCase()
  for (let at = lower.indexOf(query); at >= 0; at = lower.indexOf(query, at + query.length)) out.push([at, at + query.length])
  return out
}

/**
 * The tree narrowed to what matches: every entry whose path matches and the folders above them. `dirs` are the folders left, all of
 * them to be drawn open so no match hides inside a closed one.
 */
export function filterEntries(entries: FileEntry[], query: string): { entries: FileEntry[]; dirs: Set<string> } {
  const keep = new Set<string>()
  for (const e of entries) {
    if (!matchesPath(e.path, query)) continue
    keep.add(e.path)
    for (let i = e.path.lastIndexOf('/'); i > 0; i = e.path.lastIndexOf('/', i - 1)) keep.add(e.path.slice(0, i))
  }
  const kept = entries.filter((e) => keep.has(e.path))
  return { entries: kept, dirs: new Set(kept.filter((e) => e.dir).map((e) => e.path)) }
}
