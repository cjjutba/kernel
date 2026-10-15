import type { Project, TrackerKind, WorkspaceSource } from '@shared/types'

type IssueSource = Extract<WorkspaceSource, { kind: 'issue' }>

/** A GitHub key starts with `#`. A Linear key looks like KERNEL-160. */
export const isGithubKey = (id: string) => id.startsWith('#')

/**
 * The tracker an issue came from: the source's own tag (KERNEL-462), else its key tells. A source saved before the tag, or from a project
 * that had no tracker, has none, and `#41` is GitHub's where anything else is Linear's.
 */
export const issueTracker = (source: IssueSource): TrackerKind => source.tracker ?? (isGithubKey(source.id) ? 'github' : 'linear')

/**
 * The page a GitHub issue key opens. The Lead saves the source without a url, so it falls back to the project's repo when that is a GitHub
 * owner/repo (a scratch project's repo is its template, not where the issues live). Undefined when there is nothing to open.
 */
export function githubIssueUrl(source: IssueSource, project?: Pick<Project, 'kind' | 'repo'>): string | undefined {
  if (source.url) return source.url
  const number = /^#(\d+)$/.exec(source.id)?.[1]
  if (!number || !project || project.kind === 'scratch' || !project.repo || !/^[\w.-]+\/[\w.-]+$/.test(project.repo)) return undefined
  return `https://github.com/${project.repo}/issues/${number}`
}
