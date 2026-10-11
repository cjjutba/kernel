/** Columns on the board. Spec, Plan and Review are gates that wait on the user (Board.png). */
export type TaskColumn = 'spec' | 'plan' | 'build' | 'qa' | 'review' | 'done'
export type TaskState = 'working' | 'needs' | 'blocked' | 'idle' | 'done'

export interface TaskStep {
  text: string
  state: 'done' | 'doing' | 'next'
}

export interface Task {
  /** Short id the Lead assigns, for example "T-14" or "T-15b". */
  id: string
  roomId: string
  title: string
  column: TaskColumn
  state: TaskState
  agentId?: string
  workspaceId?: string
  /** The parent of a split task, "T-15" for "T-15a". */
  parentId?: string
  /** Board header grouping, for example "Invoices v1". */
  milestone?: string
  spec?: string
  steps: TaskStep[]
  /** The plan approval that created it. */
  approvalId?: string
  /** The id a session outside Kernel gave it, from the TaskCreated and TaskCompleted hooks. */
  externalId?: string
  createdAt: number
  updatedAt: number
  /** When it reached Done. */
  completedAt?: number
}
