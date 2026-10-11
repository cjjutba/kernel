/** Linear's workflow state types. Open issues are the first four. `duplicate` is an issue marked as a duplicate of another. */
export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate'

export interface LinearIssue {
  /** The identifier, "KERNEL-83". */
  id: string
  uuid: string
  title: string
  url: string
  /** Linear's suggested git branch name. */
  branchName: string
  state: { id: string; name: string; type: LinearStateType; position: number }
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number
  /** `me` is true when the issue is assigned to the token's user. */
  assignee?: { name: string; me: boolean }
  labels: string[]
  team: { id: string; key: string; name: string }
  project?: { id: string; name: string }
  cycle?: { id: string; number: number; name?: string }
  updatedAt: string
}

export interface LinearComment {
  id: string
  body: string
  author?: string
  createdAt: string
}

export interface LinearIssueDetail extends LinearIssue {
  /** Markdown, empty when the issue has none. */
  description: string
  /** Oldest first, up to 50. */
  comments: LinearComment[]
}

/** What the Issues screen lists. Every set field narrows the list. `query` matches the title or the number. */
export interface LinearFilter {
  mine: boolean
  teamId?: string
  projectId?: string
  cycleId?: string
  query?: string
}

/** The teams, projects and cycles the Issues screen filters by. */
export interface LinearScope {
  teams: { id: string; key: string; name: string }[]
  projects: { id: string; name: string; teamIds: string[] }[]
  /** Active and upcoming cycles. */
  cycles: { id: string; number: number; name?: string; teamId: string; active: boolean }[]
}
