import type { IssueSummary } from './pullRequests'

/** The issue trackers a room can use. A room's `[tracker] kind` can also be `none` (KERNEL-432). */
export type TrackerKind = 'linear' | 'github' | 'jira'

/** One issue as every tracker gives it: what create_workspace and the brief need (KERNEL-432). */
export interface TrackerIssue {
  /** The key the tracker shows: "KERNEL-83", "#41", "PROJ-7". */
  id: string
  title: string
  url?: string
  /** Markdown, empty when the issue has none. */
  description: string
  /** Oldest first. */
  comments: { author?: string; body: string; createdAt: string }[]
  labels: string[]
  /** The open issues that block it, by key, from a tracker that records blockers. */
  blockedBy?: string[]
}

/**
 * A room's issue tracker: Linear, GitHub Issues, Jira or none (KERNEL-432). Kernel builds one per room, so no call names
 * the room. A tracker that can't answer rejects, and the caller decides what that costs.
 */
export interface Tracker {
  kind: TrackerKind | 'none'
  /** Open issues whose title or number matches `query`, for New workspace and the From popover. */
  search: (query?: string) => Promise<IssueSummary[]>
  /** One issue in full. */
  issue: (id: string) => Promise<TrackerIssue>
  /** Moves the issue to its first started state when it hasn't started (D-140). The state's name when it moved. */
  start: (id: string) => Promise<string | undefined>
}

/** The tracker a room uses, for the screens that list its issues. `where` is GitHub's `owner/repo` (KERNEL-471). */
export interface RoomTracker {
  kind: TrackerKind | 'none'
  where?: string
}

/** A GitHub issue as the Issues screen lists it (KERNEL-471). */
export interface GithubIssue {
  number: number
  /** `#41`, the key the rest of Kernel uses. */
  id: string
  title: string
  url: string
  labels: string[]
  /** Logins. */
  assignees: string[]
  milestone?: string
  /** The login of whoever opened it. */
  author?: string
  updatedAt: string
  /** Assigned to the account gh is signed in as. */
  mine: boolean
}

/** One GitHub issue in full, for the Issues screen's pane. Comments are oldest first. */
export interface GithubIssueDetail extends GithubIssue {
  body: string
  comments: { id: string; author?: string; body: string; createdAt: string }[]
}

/** The Jira Cloud account saved in Settings, as Jira reads it (KERNEL-474). */
export interface JiraAccount {
  /** The site's host: "acme.atlassian.net". */
  site: string
  email: string
  /** The name Jira shows for the account. */
  name: string
  accountId: string
}

/** Jira's three status categories: To Do is `new`, In Progress is `indeterminate`. */
export type JiraStatusCategory = 'new' | 'indeterminate' | 'done'

/** One open Jira issue for the Issues screen (KERNEL-474). */
export interface JiraIssue {
  /** The key: "PROJ-7". */
  id: string
  title: string
  url: string
  status: { name: string; category: JiraStatusCategory }
  assignee?: { name: string; accountId: string }
  /** The issue type: "Bug", "Story". */
  type?: string
  priority?: string
  labels: string[]
  updatedAt: string
}

/** The Issues screen's Jira filter. `mine` keeps the issues assigned to the saved account. */
export interface JiraFilter {
  query?: string
  mine?: boolean
}

/** A move Jira offers an issue, which the room saves to start its issues with (KERNEL-474). */
export interface JiraTransition {
  id: string
  name: string
  /** The status the issue lands in. */
  to: { name: string; category: JiraStatusCategory }
}
