import type { PrState } from './workspaces'

export interface PrCheck {
  name: string
  state: 'queued' | 'running' | 'pass' | 'fail' | 'skipped'
  /** Duration or a word like "ready" (Vercel preview). */
  meta?: string
  url?: string
  /**
   * The check doesn't decide the PR: the repo requires other checks but not this one, or the repo requires none and the
   * room's `[pr] optionalChecks` lists it. Its failure leaves the PR ready (KERNEL-388).
   */
  optional?: true
}

export interface ReviewComment {
  id: string
  author: string
  path?: string
  line?: number
  body: string
  resolved: boolean
  /**
   * Whether GitHub counts the author as part of the repo: OWNER, MEMBER and COLLABORATOR are `trusted`, anyone else, bots
   * included, is `outside`. Only trusted comments reach the agent (KERNEL-222), so a comment without it counts as outside.
   */
  association?: 'trusted' | 'outside'
}

/** Everything the PR header and the Checks panel show (WorkspaceCIFailed.png, WorkspaceChangesRequested.png). */
export interface PrInfo {
  workspaceId: string
  number: number
  url: string
  title: string
  state: PrState
  baseRef: string
  checks: PrCheck[]
  comments: ReviewComment[]
  /** Files with conflicts against the base. */
  conflicts: string[]
  reviewDecision?: 'approved' | 'changes' | 'pending'
  /** The head commit (headRefOid). */
  head?: string
  /** GitHub is still working out whether the open PR conflicts with its base (mergeable UNKNOWN), as after the base moved. */
  conflictsUnknown?: boolean
  /** Why GitHub won't merge a PR whose checks passed yet: a required review, a branch behind its base, or other branch rules (KERNEL-388). */
  blocked?: PrBlocked
  /** When GitHub last saw the PR change: a push, a review, a comment. */
  updatedAt?: string
}

/** GitHub's mergeStateStatus on a ready PR: BLOCKED with a review required, BEHIND, or BLOCKED for another rule (KERNEL-388). */
export type PrBlocked = 'review' | 'behind' | 'rules'

/** A room's Merge all run (KERNEL-411): the PRs it merges in order, by workspace id, and the one merging now. */
export interface MergeQueue {
  ids: string[]
  current?: string
}

/** How a Merge all run ended: the PR numbers it merged, and where it stopped and why, when it stopped. */
export interface MergeAllResult {
  merged: number[]
  stopped?: { workspaceId: string; prNumber?: number; reason: string }
}

/** A PR the new workspace modal can start from. */
export interface PrSummary {
  number: number
  title: string
  branch: string
  /** GitHub login of the PR author, so the From popover can search by author. */
  author?: string
}

/** An issue the new workspace modal can start from (Linear, or a board task). */
export interface IssueSummary {
  id: string
  title: string
  url?: string
  source?: 'linear' | 'github'
}
