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
  /**
   * Who the issue is assigned to, as the tracker names them. `me` says whether it is the user Kernel reads the tracker as,
   * and is left out when the tracker couldn't tell (KERNEL-479).
   */
  assignees?: { name: string; me?: boolean }[]
}

/** One sign that someone else may already be on an issue, found before Kernel starts a workspace for it (KERNEL-479). */
export type IssueTakenFinding =
  /** A branch on the room's remote whose name holds the issue key, with the remote: "origin/feat/kernel-31-export-pdf". */
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
