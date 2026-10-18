export type AttentionKind = 'plan' | 'tool' | 'question' | 'blocker' | 'merge'

export interface PlanAttention {
  prsMerged: number
  needed: number
  byKind: Record<AttentionKind, number>
  finished: boolean
}
