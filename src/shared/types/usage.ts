import type { ModelId } from './chats'

export interface RateLimit {
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** 0 to 1. */
  utilization?: number
  /** Epoch seconds, as rate_limit_event sends it. Multiply by 1000 for a Date. */
  resetsAt?: number
  /** Set when one model has its own weekly limit (WorkspaceModelLimit.png). */
  model?: ModelId
}

/** The Claude Code login sessions run on (AccountMenu.png, Settings > Account). */
export interface ClaudeAccount {
  signedIn: boolean
  name?: string
  /** GitHub-style handle shown in the account menu. */
  login?: string
  email?: string
  /** "Claude Max", "Claude Pro". */
  plan?: string
}
