import type { TrackerKind } from '@shared/types'

export { trackerKind } from '@shared/trackerKind'

/** A tracker as text agents read names it: "Linear", "GitHub". */
const NAMES: Record<TrackerKind, string> = { linear: 'Linear', github: 'GitHub', jira: 'Jira' }

/** The tracker's name, or "the issue tracker" for an issue saved without one. */
export const trackerName = (kind: TrackerKind | undefined) => (kind ? NAMES[kind] : 'the issue tracker')
