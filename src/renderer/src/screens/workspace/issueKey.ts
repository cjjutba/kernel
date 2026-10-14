import type { Room, TrackerKind, WorkspaceSource } from '@shared/types'

type IssueSource = Extract<WorkspaceSource, { kind: 'issue' }>

/** A GitHub key starts with `#`. A Linear key looks like KERNEL-160. */
export const isGithubKey = (id: string) => id.startsWith('#')

/**
 * The tracker an issue came from: the source's own tag (KERNEL-462), else its key tells. A source saved before the tag, or from a room
 * that had no tracker, has none, and `#41` is GitHub's where anything else is Linear's.
 */
export const issueTracker = (source: IssueSource): TrackerKind => source.tracker ?? (isGithubKey(source.id) ? 'github' : 'linear')

/**
 * The page a GitHub issue key opens. The Lead saves the source without a url, so it falls back to the room's repo when that is a GitHub
 * owner/repo (a scratch room's repo is its template, not where the issues live). Undefined when there is nothing to open.
 */
export function githubIssueUrl(source: IssueSource, room?: Pick<Room, 'kind' | 'repo'>): string | undefined {
  if (source.url) return source.url
  const number = /^#(\d+)$/.exec(source.id)?.[1]
  if (!number || !room || room.kind === 'scratch' || !room.repo || !/^[\w.-]+\/[\w.-]+$/.test(room.repo)) return undefined
  return `https://github.com/${room.repo}/issues/${number}`
}
