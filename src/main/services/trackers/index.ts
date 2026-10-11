import type { TrackerKind } from '@shared/types'

/**
 * The tracker a room uses (KERNEL-462). The room's `[tracker] kind` always wins. Without one, a Linear token plus the room's
 * `[linear] team` means Linear, then a github.com remote means GitHub Issues, and otherwise the room has none.
 */
export function trackerKind(o: { kind?: TrackerKind | 'none'; linearToken: boolean; linearTeam: boolean; githubRemote: boolean }): TrackerKind | 'none' {
  if (o.kind) return o.kind
  if (o.linearToken && o.linearTeam) return 'linear'
  return o.githubRemote ? 'github' : 'none'
}

/**
 * The tracker an issue source came from, by its tag (KERNEL-470). A source saved before KERNEL-462 has none, and its id
 * tells, as it did then: `#41` is a GitHub issue, anything else Linear.
 */
export function issueTracker(source: { id: string; tracker?: TrackerKind }): TrackerKind {
  return source.tracker ?? (source.id.startsWith('#') ? 'github' : 'linear')
}
