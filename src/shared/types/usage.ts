import type { ModelId, Provider } from './chats'

export interface RateLimit {
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** 0 to 1. */
  utilization?: number
  /** Epoch seconds, as rate_limit_event sends it. Multiply by 1000 for a Date. */
  resetsAt?: number
  /** Set when one model has its own weekly limit (WorkspaceModelLimit.png). */
  model?: ModelId
  /** Whose limit it is. Absent reads as `claude`, as every limit saved before KERNEL-406. A rejection holds only that provider's chats. */
  provider?: Provider
  /** The account it was read on (`AccountProfile.id`). Absent is the CLI's own login. */
  accountId?: string
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

/**
 * One account a provider can run on (Settings, Providers, KERNEL-406). Each provider always has its CLI's own login
 * (`cli`), which is `~/.claude` or `~/.codex` as the user set it up. Added accounts keep only their credential apart. The
 * active one runs the next turn, and switching is always the user's click.
 */
export interface AccountProfile {
  id: string
  provider: Provider
  /** What the user calls it, or its email. */
  label: string
  email?: string
  /** "Claude Max", "ChatGPT Plus". */
  plan?: string
  /** The CLI's own login rather than one Kernel added. It can be signed out but not removed. */
  cli: boolean
  active: boolean
  signedIn: boolean
}

/** Where a provider's executable comes from: Kernel's bundled copy, the one on the PATH, a path from Settings, or none found. */
export type BinarySource = 'bundled' | 'system' | 'custom' | 'missing'

/** A provider's status table on Settings, Providers. Text only, no status dots (DESIGN.md). */
export interface ProviderStatus {
  provider: Provider
  version?: string
  /** The executable Kernel runs. */
  path?: string
  source: BinarySource
  signedIn: boolean
  /** "Claude account", "ChatGPT". */
  loginMethod?: string
  plan?: string
  email?: string
  /** The CLI's own config file, for Open. */
  configFile: string
  /** Why the status couldn't be read, when it couldn't. */
  error?: string
}

/** Where Add account is, for its sheet. `code` asks for the code the sign-in page shows (Claude only). */
export interface AccountAddStep {
  provider: Provider
  step: 'browser' | 'code' | 'done' | 'failed'
  /** The sign-in page, opened in the browser, for a link in case it didn't open. */
  url?: string
  account?: AccountProfile
  error?: string
}
