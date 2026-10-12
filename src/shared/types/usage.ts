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
  /** When Kernel last heard of the window, in epoch ms (KERNEL-406). */
  readAt?: number
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
 * How an account signs in (KERNEL-523). `subscription` runs on a Claude or ChatGPT plan: the CLI's own login, a full Claude
 * login in a folder of its own (KERNEL-567), a `claude setup-token` token from before that, or a ChatGPT sign-in. `apiKey`
 * runs on an API key the user added, which bills the key.
 */
export type AccountAuth = 'subscription' | 'apiKey'

/**
 * One account a provider can run on (Settings, Providers, KERNEL-406). Each provider always has its CLI's own login
 * (`cli`), which is `~/.claude` or `~/.codex` as the user set it up. Added accounts keep only their credential apart. The
 * active one runs the next turn, and switching is always the user's click.
 */
export interface AccountProfile {
  id: string
  provider: Provider
  /** Its nickname (`accounts.rename`), or its email when it has none (KERNEL-567). */
  label: string
  email?: string
  /** "Claude Max", "ChatGPT Plus". None for an API key account. */
  plan?: string
  /** The CLI's own login rather than one Kernel added. It can be signed out but not removed. */
  cli: boolean
  /**
   * An API key account has no plan and no usage windows, so it never hits a usage limit, and Kernel never switches to it
   * on its own. A key the API refuses signs it out until the user gives it a new one (KERNEL-523).
   */
  auth: AccountAuth
  active: boolean
  signedIn: boolean
  /**
   * Its usage is known only from its turns: a legacy token account (`legacyToken`) can't read the usage call, so its meters
   * stand as of its last turn (KERNEL-406). Every other subscription account reads its own (KERNEL-567).
   */
  usageFromTurns?: boolean
  /**
   * A Claude account added before KERNEL-567, which runs on a `claude setup-token` token. The token can't say its email or
   * plan, so the row asks the user to sign in again, which moves it to a full login and keeps its id and nickname.
   */
  legacyToken?: boolean
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

/**
 * Where Add account or Sign in again is, for its sheet. `code` asks for the code the sign-in page shows (Claude only), which
 * Claude Code's login offers from the start, so it follows `browser` at once.
 */
export interface AccountAddStep {
  provider: Provider
  step: 'browser' | 'code' | 'done' | 'failed'
  /** The sign-in page, opened in the browser, for a link in case it didn't open. */
  url?: string
  account?: AccountProfile
  error?: string
}
