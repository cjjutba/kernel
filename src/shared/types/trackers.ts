import type { IssueSummary } from './pullRequests'

/** The issue trackers a project can use. A project's `[tracker] kind` can also be `none` (KERNEL-432). */
export type TrackerKind = 'linear' | 'github'

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
  /**
   * Who the issue is assigned to, as the tracker names them. `me` says whether it is the user Kernel reads the tracker as,
   * and is left out when the tracker couldn't tell (KERNEL-479).
   */
  assignees?: { name: string; me?: boolean }[]
}

/** One sign that someone else may already be on an issue, found before Kernel starts a workspace for it (KERNEL-479). */
export type IssueTakenFinding =
  /** A branch on the project's remote whose name holds the issue key, with the remote: "origin/feat/kernel-31-export-pdf". */
  | { kind: 'branch'; ref: string }
  /** An open pull request whose title, description or branch names the issue key. */
  | { kind: 'pr'; number: number; title: string; url?: string }
  /** Someone the tracker has the issue assigned to, other than the user. */
  | { kind: 'assignee'; name: string }

/** What Kernel found before starting a workspace for an issue: ConfirmIssueTaken.png, and create_workspace's warning (KERNEL-479). */
export interface IssueTaken {
  findings: IssueTakenFinding[]
  /** Each check that couldn't answer, in a sentence: "Couldn't read the branches on origin: no answer in 10 seconds." The start goes ahead without it. */
  notes: string[]
}

/**
 * A project's issue tracker: Linear, GitHub Issues or none (KERNEL-432). Kernel builds one per project, so no call names
 * the project. A tracker that can't answer rejects, and the caller decides what that costs.
 */
export interface Tracker {
  kind: TrackerKind | 'none'
  /** Open issues whose title or number matches `query`, for New workspace and the From popover. */
  search: (query?: string) => Promise<IssueSummary[]>
  /** Issues nobody has started, the most pressing first, for Up next in New chat. A tracker without one lists `search()`. */
  next?: () => Promise<IssueSummary[]>
  /** One issue in full. */
  issue: (id: string) => Promise<TrackerIssue>
  /** Moves the issue to its first started state when it hasn't started (D-140). The state's name when it moved. */
  start: (id: string) => Promise<string | undefined>
  /** Files a new issue, in the project's Linear team or GitHub repo: the Lead's file_issue. The issue as the tracker keys it. */
  create: (issue: IssueDraft) => Promise<IssueSummary>
  /** Changes what `change` sets on one issue, leaving the rest as it was: the Lead's file_issue with an issue key. */
  edit: (id: string, change: Partial<IssueDraft>) => Promise<IssueSummary>
}

/** What the Lead's file_issue writes to an issue: its title and its description in markdown. */
export interface IssueDraft {
  title: string
  description?: string
}

/** The tracker a project uses, for the screens that list its issues. `where` is GitHub's `owner/repo` (KERNEL-471). */
export interface ProjectTracker {
  /** The project's own tracker by KERNEL-462's rule: the one Up next, the From popover and the move to In Progress use. */
  kind: TrackerKind | 'none'
  where?: string
  /**
   * The trackers the Issues screen can list for the project (KERNEL-933): Linear with a token and the project's `[linear] team`,
   * GitHub with a github.com remote, `where` being its `owner/repo`. Neither with `[tracker] kind = "none"`.
   */
  available: { linear: boolean; github?: { where: string } }
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
