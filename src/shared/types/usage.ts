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
 * Why a provider moved to another account (KERNEL-568): `user` from Settings, the account menu or Cmd+K, `banner` from the
 * limit banner's Switch to, and `limit` when Kernel moved on its own because the account in use hit its limit.
 */
export type SwitchReason = 'user' | 'banner' | 'limit'

/**
 * Which chats a switch moves (KERNEL-843): `keep` only changes the account new chats start on, and chats stay on the account
 * that holds their cache. `all` moves every chat of the provider. `keep` is the default while `accounts.keepChatsOnAccount` is on.
 */
export type SwitchMove = 'keep' | 'all'

/**
 * One account a provider can run on (Settings, Providers, KERNEL-406). Each provider always has its CLI's own login
 * (`cli`), which is `~/.claude` or `~/.codex` as the user set it up. Added accounts keep only their credential apart. The
 * active one runs the next turn. Switching is the user's click, or Kernel's at a limit once the user turned that on
 * (`accounts.switchAtLimit`, KERNEL-568).
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
   * An added account that is also the CLI's own login: the same email, and on Claude the same organization unless either is
   * unknown. The list shows it once, as this row, and leaves the CLI's own row out. It is in use while the CLI's own login is
   * (KERNEL-701).
   */
  alsoCli?: true
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
  /**
   * Claude only: the MCP servers that need a sign-in on this account, as `accounts.checkMcp` last found them, an empty list
   * when none do. Undefined until checked (KERNEL-616). Servers ignored on the account, or switched off in every project, are
   * left out, so they don't warn (KERNEL-646).
   */
  mcpSignIns?: McpSignIn[]
  /**
   * The models agents start on that this account doesn't offer, each with the agents that use it, as Kernel last read the
   * account's models. Kernel reads them when it switches to the account. Undefined until read or when nothing is missing
   * (KERNEL-616).
   */
  missingModels?: MissingModel[]
  /**
   * Claude only: the provider's other accounts signed in to the same claude.ai organization, by id (KERNEL-618). Seats in one
   * Team or Enterprise organization can share limits, so Kernel counts such an account as having project only when its own
   * windows say so (`switchChoices`). Settings, Providers says "Same organization as Work". Undefined when it shares none.
   */
  sameOrg?: string[]
  /**
   * Claude only: this added login's Keychain item waits on a macOS prompt (KERNEL-618). Until someone allows it, Claude Code
   * reads the login as signed out, so Kernel says this instead and keeps the sign-in it last read. Settings, Providers says
   * "Waiting for Keychain access".
   */
  keychainWait?: boolean
  /**
   * How many of the provider's open chats run their next turn on this account (KERNEL-843). Chats that never ran a turn are
   * left out, since they start on whichever account is in use then. Undefined when none do.
   */
  chats?: number
}

/**
 * An MCP server that needs a sign-in on one Claude account (KERNEL-616). A server the user added signs in once for every
 * account, since Kernel shares its sign-in between the CLI's own login and each added login. A claude.ai connector
 * (`connector`) belongs to the claude.ai account: each account has only the connectors set up on it, and Kernel never
 * copies one.
 */
export interface McpSignIn {
  /** The server's name as Claude Code lists it: "linear", "claude.ai Google Drive". */
  server: string
  connector: boolean
}

/** A model agents start on that an account doesn't offer, so their next turns there fail (KERNEL-616). */
export interface MissingModel {
  /** "claude-opus-5-5". */
  model: string
  /** "Opus 5.5", or the id when Kernel has no name for it. */
  label: string
  /** The names of the agents whose role or file puts them on it, "Kernel". */
  agents: string[]
}

/**
 * Where a sign-in to one MCP server on one account is (`accounts.mcpSignIn`, KERNEL-616). `browser` carries the page Claude
 * Code or Codex opened, for a link in case it didn't open. A claude.ai connector is `done` once the page is open: the user
 * finishes on claude.ai, and the connector loads from the account's next session. `provider` is unset for Claude (KERNEL-646).
 */
export interface McpSignInStep {
  provider?: Provider
  accountId: string
  server: string
  step: 'browser' | 'done' | 'failed'
  url?: string
  connector?: boolean
  error?: string
}

/**
 * One MCP server's state on one account (`mcp.accounts`, KERNEL-626, KERNEL-646). Every server any account of the provider
 * has gets one on every account of it:
 * - `ready`: it starts and lists its tools there, or a claude.ai connector of the account covers it (`note` says which).
 * - `needs-sign-in`: it waits on an OAuth sign-in there (`accounts.mcpSignIn`).
 * - `failed`: it didn't start, with the provider's reason in one line (`error`).
 * - `not-set-up`: the account doesn't have it. `note` says why, and a claude.ai connector carries `connectUrl`.
 * - `ignored`: the user chose to ignore it on that account (`accounts.mcpIgnore`), whatever its state would be.
 * - `off`: off on purpose, with the reason in `note`: switched off in Codex's `config.toml` ("Off in Codex config"), or a
 *   plugin's server Codex lists and never starts ("Not started by Codex"). It never needs the user (KERNEL-660).
 */
export type McpAccountState = 'ready' | 'needs-sign-in' | 'failed' | 'not-set-up' | 'ignored' | 'off'

/**
 * Where an MCP server comes from (KERNEL-646). `user`: one the user added, which Kernel shares with every account of the
 * provider, its sign-in included. `connector`: a claude.ai connector, set up per claude.ai account, which Kernel can't copy.
 * `plugin`: a plugin's server, shared with the plugin.
 */
export type McpServerKind = 'user' | 'connector' | 'plugin'

/** One MCP server on one account, as `mcp.accounts` last checked it (KERNEL-626, KERNEL-646). */
export interface McpAccountServer {
  name: string
  kind: McpServerKind
  /** `kind` is `connector`. Kept for the screens built before KERNEL-646. */
  connector: boolean
  state: McpAccountState
  /** Why it failed, as the provider said, in one line. Only on `failed`. */
  error?: string
  /**
   * One line on a state that needs a why: what keeps a `not-set-up` server off the account, the connector that stands in
   * for a plugin's server on a `ready` one ("Covered by claude.ai Vercel on this account."), or why one is `off`.
   */
  note?: string
  /**
   * A claude.ai connector that isn't set up on the account: claude.ai's connector settings, where only the account's owner can
   * add it. The account's `email` says who to be signed in to claude.ai as. A re-check picks it up once added.
   */
  connectUrl?: string
  /** Switched off in every project, so it never warns: not on the account's row, the notice after adding, or Sign in to all. */
  projectOff?: boolean
}

/** One signed-in subscription account's MCP servers (`mcp.accounts`, KERNEL-626). */
export interface McpAccount {
  provider: Provider
  accountId: string
  label: string
  /** The account's email, for "Sign in to claude.ai as cj@example.com first" before a connector's `connectUrl` (KERNEL-646). */
  email?: string
  /** When Kernel last checked it. Undefined while the first check runs or after it failed. */
  checkedAt?: number
  /** Why the last check failed. The account then has no servers. */
  error?: string
  servers: McpAccountServer[]
  /**
   * The servers that need the user here (`mcpNeedsYou`): needing a sign-in, failed or not set up, and not ignored, `off` or
   * switched off in every project. Every surface shows this number (KERNEL-660).
   */
  needsYou: number
  /** The servers `ready` here (KERNEL-660). */
  ready: number
  /**
   * Codex only: the provider's other accounts whose servers read the same, by id (KERNEL-660). Codex keeps MCP sign-ins in one
   * store for every Codex account (KERNEL-646.md), so these can show as one. Undefined when none match.
   */
  sharedWith?: string[]
}

/**
 * The claude.ai connectors Set up this account sends to claude.ai in one step (`accounts.mcpSetUp`, KERNEL-660): open `url`
 * once, signed in to claude.ai as `email`, and add `servers` there. A re-check picks them up once added.
 */
export interface McpConnect {
  provider: Provider
  accountId: string
  email?: string
  url: string
  servers: string[]
}

/**
 * Where Sign in to all on one account is (`accounts.mcpSignInAll`, KERNEL-626). `servers` is the queue in order and
 * `current` the one signing in now, whose own steps come as `account.mcpSignIn` pushes. `finished` is set once the queue
 * ends, with `canceled` when Cancel stopped it. `provider` is unset for Claude, as before Codex could sign in (KERNEL-646).
 */
export interface McpSignInAll {
  provider?: Provider
  accountId: string
  servers: string[]
  current?: string
  done: string[]
  failed: { server: string; error: string }[]
  finished?: boolean
  canceled?: boolean
  /** Set up this account (`accounts.mcpSetUp`): the servers it ignored because they weren't ticked (KERNEL-660). */
  ignored?: string[]
  /** Set up this account: the claude.ai connectors it sent to claude.ai, as its `account.mcpConnect` push (KERNEL-660). */
  connect?: McpConnect
}

/**
 * MCP servers that need a sign-in on an account just added, after its first check (KERNEL-626). Pushed once per added
 * account, only when some do. `title` is "3 MCP servers need a sign-in on Personal".
 */
export interface McpNeeded {
  provider: Provider
  accountId: string
  servers: string[]
  title: string
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
