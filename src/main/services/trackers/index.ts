import type { TrackerKind } from '@shared/types'

export { trackerKind } from '@shared/trackerKind'

/**
 * The tracker an issue source came from, by its tag (KERNEL-470). A source saved before KERNEL-462 has none, and its id
 * tells, as it did then: `#41` is a GitHub issue, anything else Linear.
 */
export function issueTracker(source: { id: string; tracker?: TrackerKind }): TrackerKind {
  return source.tracker ?? (source.id.startsWith('#') ? 'github' : 'linear')
}
