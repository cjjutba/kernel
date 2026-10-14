import type { MergeMethod } from './settings'
import type { TrackerKind } from './trackers'
import type { DiffStat, PrState } from './workspaces'

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
  /** The review thread a line comment opens, so the agent can reply in it. A review's own body has none (KERNEL-564). */
  threadId?: string
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
  /** What git says before a local merge, in a room with no GitHub (KERNEL-467). Such a PR has no number or url. */
  local?: LocalMerge
}

/** A branch that merges on the Mac, read from git: how far it is from its base and what would merge (KERNEL-467). */
export interface LocalMerge {
  /** Commits on the branch that the base doesn't have. */
  ahead: number
  /** Commits on the base that the branch doesn't have. The merge goes ahead anyway when nothing conflicts. */
  behind: number
  /** The branch's committed changes since it left the base, which is what merges. */
  stat: DiffStat
  /** The room's merge method. */
  method: MergeMethod
  /**
   * The folder that has the base branch checked out, if one does. `dirty` lists, with their `git status` letters, its tracked
   * files with uncommitted changes and its untracked files where the merge would write. Kernel moves that folder along with
   * the branch, so it merges only while `dirty` is empty.
   */
  checkout?: { path: string; dirty: { status: string; path: string }[] }
}

/** GitHub's mergeStateStatus on a ready PR: BLOCKED with a review required, BEHIND, or BLOCKED for another rule (KERNEL-388). */
export type PrBlocked = 'review' | 'behind' | 'rules'

/**
 * The PR action Kernel is running on a workspace, from the press until it ends, whichever button or tool started it. Every
 * place showing the PR spins from it (KERNEL-519). The same names as the PR band's buttons.
 */
export type PrPending = 'create' | 'resolve' | 'merge' | 'ready' | 'reopen' | 'update'

/** A PR the new workspace modal can start from. */
export interface PrSummary {
  number: number
  title: string
  branch: string
  /** GitHub login of the PR author, so the From popover can search by author. */
  author?: string
}

/** An issue the new workspace modal can start from, in Linear, GitHub or Jira. */
export interface IssueSummary {
  id: string
  title: string
  url?: string
  source?: TrackerKind
  /** Linear's priority, 0 none, 1 urgent to 4 low, where the tracker has one. Up next in New chat shows it. */
  priority?: number
  /** The Linear project the issue is in, when it has one. Up next shows it after the title. */
  project?: string
}
