import type { TrackerKind } from '@shared/types'

export { trackerKind } from '@shared/trackerKind'

/** A tracker as text agents read names it: "Linear", "GitHub". */
const NAMES: Record<TrackerKind, string> = { linear: 'Linear', github: 'GitHub' }

/**
 * The tracker an issue source came from, by its tag (KERNEL-470). A source saved before KERNEL-462 has none, and its id
 * tells, as it did then: `#41` is a GitHub issue, anything else Linear. A tag Kernel no longer has, like the `jira` of an
 * issue saved before Jira was removed, names no tracker, so no room's tracker is asked about it.
 */
export function issueTracker(source: { id: string; tracker?: TrackerKind }): TrackerKind | undefined {
  if (!source.tracker) return source.id.startsWith('#') ? 'github' : 'linear'
  return Object.hasOwn(NAMES, source.tracker) ? source.tracker : undefined
}

/** The tracker's name, or "the issue tracker" for an issue saved without one or with a tracker Kernel no longer has. */
export const trackerName = (kind: TrackerKind | undefined) => (kind && Object.hasOwn(NAMES, kind) ? NAMES[kind] : 'the issue tracker')
