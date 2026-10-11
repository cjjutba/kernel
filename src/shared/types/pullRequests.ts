import type { PrState } from './workspaces'

export interface PrCheck {
  name: string
  state: 'queued' | 'running' | 'pass' | 'fail' | 'skipped'
  /** Duration or a word like "ready" (Vercel preview). */
  meta?: string
  url?: string
}

export interface ReviewComment {
  id: string
  author: string
  path?: string
  line?: number
  body: string
  resolved: boolean
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
