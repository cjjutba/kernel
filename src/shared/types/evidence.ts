/** Where a criterion stands. It is `unverified` until a real event links it, and an agent saying it is done is not an event. */
export type CriterionStatus = 'passed' | 'failed' | 'unverified'

/** The kind of event a link comes from. `review` is always the reviewer's judgment. */
export type EvidenceSource = 'check' | 'review' | 'files' | 'image'

/**
 * One real event tied to one criterion. Only `supports` and `contradicts` move the status, and only while the link is
 * current. `context` shows what happened without deciding anything: a touched file proves nothing about behavior.
 */
export interface EvidenceLink {
  id: string
  source: EvidenceSource
  label: string
  effect: 'supports' | 'contradicts' | 'context'
  /** The PR head the event was about. A link from an older head is `stale` and no longer counts. */
  commit?: string
  stale: boolean
  /** Set where the link is the reviewer's opinion, not something a machine checked. */
  judgedBy?: 'reviewer'
  url?: string
  ts: number
}

export interface CriterionEvidence {
  /** Position in the plan step's `criteria`, from 0. */
  index: number
  text: string
  status: CriterionStatus
  /** Some link is from an older commit. When no current link remains, the criterion is back to `unverified`. */
  stale: boolean
  links: EvidenceLink[]
}

/** What happened during the run, for the whole PR. Approvals and files say how the work went, not which criterion it met. */
export interface RunEvidence {
  approvals: { id: string; title: string; toolName?: string; status: string; at: number }[]
  files: string[]
  images: { sharedId: string; version: number; title: string }[]
}

/** The evidence for one workspace's PR, against the criteria of the plan step it was handed. */
export interface PrEvidence {
  workspaceId: string
  prNumber?: number
  head?: string
  stepTitle?: string
  criteria: CriterionEvidence[]
  run: RunEvidence
  /** The GitHub comment Kernel keeps for this PR, once it has posted one. */
  commentUrl?: string
}
