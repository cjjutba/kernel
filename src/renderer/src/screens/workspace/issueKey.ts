import type { ChatPart, Project, ProjectTracker, TrackerKind, WorkspaceSource } from '@shared/types'

type IssueSource = Extract<WorkspaceSource, { kind: 'issue' }>

/** A GitHub key starts with `#`. A Linear key looks like KERNEL-160. */
export const isGithubKey = (id: string) => id.startsWith('#')

/**
 * The tracker an issue came from: the source's own tag (KERNEL-462), else its key tells. A source saved before the tag, or from a project
 * that had no tracker, has none, and `#41` is GitHub's where anything else is Linear's.
 */
export const issueTracker = (source: Pick<IssueSource, 'id' | 'tracker'>): TrackerKind => source.tracker ?? (isGithubKey(source.id) ? 'github' : 'linear')

/**
 * The page a GitHub issue key opens. The Lead saves the source without a url, so it falls back to the project's repo when that is a GitHub
 * owner/repo (a scratch project's repo is its template, not where the issues live). Undefined when there is nothing to open.
 */
export function githubIssueUrl(source: Pick<IssueSource, 'id' | 'url'>, project?: Pick<Project, 'kind' | 'repo'>): string | undefined {
  if (source.url) return source.url
  const number = /^#(\d+)$/.exec(source.id)?.[1]
  if (!number || !project || project.kind === 'scratch' || !project.repo || !/^[\w.-]+\/[\w.-]+$/.test(project.repo)) return undefined
  return `https://github.com/${project.repo}/issues/${number}`
}

/** An issue as the click rules read it: a workspace's source and a chat's issue chip both fit. */
export type IssueRef = Pick<IssueSource, 'id' | 'url' | 'tracker'>

/** A chip's part as an issue ref: its name is the key and its source the tracker. */
export const issueFromPart = (part: Extract<ChatPart, { type: 'issue' }>): IssueRef => ({ id: part.name, url: part.url, tracker: part.source })

/** The page the issue opens in the browser: its own url, else for a GitHub key the one built from the project's repo. */
export const issueUrl = (issue: IssueRef, project?: Pick<Project, 'kind' | 'repo'>): string | undefined =>
  issueTracker(issue) === 'github' ? githubIssueUrl(issue, project) : issue.url

/** The owner/repo a GitHub issue url points at, lowercased. */
const urlRepo = (url: string) => /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\//i.exec(url)?.[1]?.toLowerCase()

export type IssueTarget = { kind: 'issues'; projectId: string } | { kind: 'url'; url: string } | { kind: 'none' }

/**
 * Where clicking an issue goes (KERNEL-898), for the header's key and every issue chip. Issues, when the project's tracker is the issue's
 * and, for GitHub, the issue's own url is in the project's repo. Otherwise the browser, when there is a url. Otherwise nowhere. A tracker
 * that is still loading, or failed to load, is not a match, so it falls to the url.
 */
export function issueOpen(issue: IssueRef, project?: Pick<Project, 'id' | 'kind' | 'repo'>, tracker?: ProjectTracker): IssueTarget {
  const kind = issueTracker(issue)
  if (project && tracker?.kind === kind) {
    const repo = issue.url && kind === 'github' ? urlRepo(issue.url) : undefined
    if (kind === 'linear' || !issue.url || (!!repo && repo === tracker.where?.toLowerCase())) return { kind: 'issues', projectId: project.id }
  }
  const url = issueUrl(issue, project)
  return url ? { kind: 'url', url } : { kind: 'none' }
}
