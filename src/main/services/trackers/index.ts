import type { TrackerKind } from '@shared/types'

export { trackerKind } from '@shared/trackerKind'

/**
 * The tracker an issue source came from, by its tag (KERNEL-470). A source saved before KERNEL-462 has none, and its id
 * tells, as it did then: `#41` is a GitHub issue, anything else Linear.
 */
export function issueTracker(source: { id: string; tracker?: TrackerKind }): TrackerKind {
  return source.tracker ?? (source.id.startsWith('#') ? 'github' : 'linear')
}

/** A tracker as text agents read names it: "Linear", "GitHub". */
const NAMES: Record<TrackerKind, string> = { linear: 'Linear', github: 'GitHub', jira: 'Jira' }

/** The tracker's name, or "the issue tracker" for an issue saved without one. */
export const trackerName = (kind: TrackerKind | undefined) => (kind ? NAMES[kind] : 'the issue tracker')
