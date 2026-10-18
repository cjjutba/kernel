/** What the user had to do for a plan: the Inbox events its workspaces raised. */
export type AttentionKind = 'plan' | 'tool' | 'question' | 'blocker' | 'merge'

/**
 * What an approved plan cost the user between its approval and its last task merging or closing (KERNEL-1060).
 * `needed` is the sum of `byKind`. `finished` is false while any task is still open or has no workspace yet.
 */
export interface PlanAttention {
  prsMerged: number
  needed: number
  byKind: Record<AttentionKind, number>
  finished: boolean
}
