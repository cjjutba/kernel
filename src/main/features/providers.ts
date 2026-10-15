import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EFFORT_LABELS, EFFORTS, MODELS, PROVIDERS, type AccountAddStep, type AccountAuth, type AccountProfile, type ClaudePlan, type Effort, type McpAccountServer, type McpSignIn, type McpSignInStep, type MissingModel, type Provider, type ProviderBinary, type ProviderModel, type ProviderStatus, type RateLimit, type Role, type SwitchMove, type SwitchReason } from '@shared/types'
import { limitProvider } from '@shared/providers'
import { switchChoices } from '@shared/usage'
import { joinLabels } from '@shared/waits'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { signOut as claudeSignOut, type ReadAccount } from '../services/account'
import { exec } from '../services/exec'
import { removeTree } from '../services/removeTree'
import { claudeAccountServers, codexAccountServers, codexServers } from '../services/mcp'
import { blockingLimit } from '../services/health'
import { LIMIT_NAME, type LimitPatch } from '../services/providers/limits'
import type { UsageRead } from '../services/sessions'
import { planOf } from '../services/settings'
import { checkApiKey } from '../services/providers/apiKeys'
import { claudeExecutable, resolveBinary } from '../services/providers/binary'
import { accountEnv, claudeStatus, credentialsDir, credentialsItem, isConnector, linkClaudeHome, loginEnv, loginMcp, logoutClaude, removeClaudeHome, shareMcpSignIns, syncClaudeConfig, syncClaudePlugins, type ClaudeLogin } from '../services/providers/claudeHome'
import { loginClaude } from '../services/providers/claudeToken'
import { claudeModels, probeClaudeMcp, probeClaudeUsage, sessionEnv } from '../services/providers/claude'
import { codexPlan, loginCodexMcp, readCodexAccount, readCodexMcp, readCodexModels, withCodex } from '../services/providers/codex/client'
import { codexLimits } from '../services/providers/codex/runner'
import type { Rpc } from '../services/providers/codex/rpc'
import type { AccountLoginCompletedNotification } from '../services/providers/codex/protocol/v2/AccountLoginCompletedNotification'
import type { LoginAccountResponse } from '../services/providers/codex/protocol/v2/LoginAccountResponse'
import type { ThreadForkResponse } from '../services/providers/codex/protocol/v2/ThreadForkResponse'
import { Feature } from './feature'

/** "codex-cli 0.153.4" or "2.1.292 (Claude Code)" to the version alone. */
export const versionOf = (out: string) => /(\d+\.\d+\.\d+)/.exec(out)?.[1]

/**
 * An account Kernel added. Its credential lives apart: a Claude login in its own folder (`home`, KERNEL-567), a legacy Claude
 * token in `claude-tokens.json`, Codex's `auth.json` in its home, and an API key account's key in `api-keys.json` (`auth`,
 * KERNEL-523). `label` is its nickname, or its email when it has none. A login's email and plan are read from it. A legacy
 * token account's plan is the one the user picked (`claudePlan`), since its token can't read it. An API key account has none.
 */
interface StoredAccount {
  id: string
  label: string
  email?: string
  plan?: string
  claudePlan?: Exclude<ClaudePlan, 'unknown'>
  auth?: 'apiKey'
  /** A Claude login's folder, as the exact path string it signed in with, which names its Keychain item (KERNEL-560). */
  home?: string
  /** What Kernel last read of a login's sign-in. Undefined until the first read, so a restart never announces an old sign-out. */
  signedIn?: boolean
  /** A Claude login's claude.ai organization, which tells two plans on one email apart (KERNEL-616). */
  orgId?: string
  /** The MCP servers the user ignores on this account (`accounts.mcpIgnore`, KERNEL-646). */
  mcpIgnored?: string[]
  createdAt: number
}
/**
 * The CLI's own login as `accounts.json` keeps it: its nickname, its last email, what Kernel last read of its sign-in
 * (KERNEL-567), on Claude its claude.ai organization (KERNEL-618), and the MCP servers ignored on it (KERNEL-646).
 */
interface StoredCli { label?: string; email?: string; signedIn?: boolean; orgId?: string; mcpIgnored?: string[] }
/** Each provider's added accounts, the one it runs on, and its CLI login. No `active` is the CLI's own login. */
type AccountsFile = Record<Provider, { active?: string; accounts: StoredAccount[]; cli?: StoredCli }>

/** The id the CLI's own login goes by in `accounts.*`. */
export const CLI_ACCOUNT = 'cli'

/** What the CLI's own login is called until it is renamed or its email is known. */
const OWN_LOGIN: Record<Provider, string> = { claude: 'Claude Code’s own login', codex: 'Codex’s own login' }

/** How long a sign-in in the browser may take before Kernel gives up on it. */
const SIGN_IN_MS = 15 * 60_000

/** How long `readUsage` trusts an account's last read. Claude Code answers the usage call from a snapshot under a minute old. */
const USAGE_FRESH_MS = 60_000

/**
 * How long a finished turn waits to read its account's usage, so the turns that finish meanwhile share one read
 * (KERNEL-673). As long as USAGE_FRESH_MS: a read sooner could get Claude Code's snapshot from before the turn, and any read
 * `readUsage` skips as fresh then ran after the turn ended.
 */
export const USAGE_AFTER_TURN_MS = USAGE_FRESH_MS

/** How often the MCP sign-ins are shared at most, so chats starting together read the Keychain once (KERNEL-616). */
const SHARE_EVERY_MS = 2_000

/** Adding a login Kernel already has (KERNEL-616). */
const ALREADY_IN = 'That account is already in Kernel.'

/** What `accounts.switch` takes as `move`, besides none. */
const MOVES: readonly SwitchMove[] = ['keep', 'all']

/**
 * Whether two logins are one: the same email, ignoring case, and the same organization unless either is unknown, since one
 * email can have a personal plan and a Team seat. Codex says no organization, so its email decides. A login with no email
 * matches nothing (KERNEL-616, KERNEL-701).
 */
const sameLogin = (a: { email?: string; orgId?: string } | undefined, b: { email?: string; orgId?: string } | undefined) => {
  const email = a?.email?.toLowerCase()
  return !!email && email === b?.email?.toLowerCase() && (!a!.orgId || !b.orgId || a!.orgId === b.orgId)
}

/** A role's name, for an agent Kernel names by its role before any room's team is read (KERNEL-616). */
const ROLE_NAMES: Record<Role, string> = { lead: 'Kernel', engineers: 'Engineers', qa: 'QA', reviewer: 'Reviewer' }

/** A model id without its case and its context-window tag (`[1m]`). */
const bareModel = (id: string) => id.toLowerCase().replace(/\[[^\]]*\]$/, '')

/**
 * What a Codex account's home shares with `~/.codex`, made first when `~/.codex` has none, so chats, MCP servers, plugins,
 * skills and rules stay one set however many accounts there are. Everything else already in `~/.codex` is shared too.
 * Only `auth.json` is the account's own (KERNEL-406).
 */
const CODEX_SHARED_DIRS = ['skills', 'plugins', 'rules', 'sessions', 'archived_sessions', 'memories']
const CODEX_OWN = new Set(['auth.json'])

/** Claude Code and Codex: their executables, accounts, switching, model lists and status (KERNEL-406). */
export class Providers extends Feature {
  /** Codex's models, read once per launch from `model/list`. A failed read is tried again next time. */
  private codexModels?: Promise<ProviderModel[]>
  private accounts?: AccountsFile
  /** The sign-in Add account or Run login is waiting on, per provider, so Cancel can stop it and a code can reach it. */
  private adding = new Map<Provider, { cancel: () => void; code?: (code: string) => void }>()
  /** Added accounts whose token or API key a session refused. They read as signed out until a new one replaces it. */
  private refused = new Set<string>()
  /** When `readUsage` last read each account, by `provider:id`, so opening the account menu twice reads once. */
  private usageReadAt = new Map<string, number>()
  /** The read a finished turn asked for, by `provider:id`, which the turns that finish before it runs share (KERNEL-673). */
  private afterTurn = new Map<string, NodeJS.Timeout>()
  /** Usage reads running, by account id, which Remove waits for so none writes to a folder it deleted. */
  private reading = new Map<string, Set<Promise<void>>>()
  /**
   * Each provider's last switch, by account id, for the note a chat gets when its next turn starts on the new account
   * (KERNEL-568). `limit` is the window the account it left had hit, when the banner or Kernel moved it off a limit.
   */
  private switches = new Map<Provider, { to: string; from: string; limit?: RateLimit['type'] }>()
  /** When the MCP sign-ins were last shared (KERNEL-616). */
  private sharedAt = 0
  /** What `checkMcp` last found on each Claude login, by account id, `cli` for the CLI's own (KERNEL-616). */
  private mcpSignIns = new Map<string, McpSignIn[]>()
  /** The models each account offers, by `provider:id`, with the login they were read on (`loginKey`, KERNEL-616). */
  private offered = new Map<string, { login: string; ids: string[] }>()
  /** When the MCP servers were last synced across every Claude login (KERNEL-618). */
  private syncedAt = 0
  /**
   * Added Claude logins whose Keychain item waits on a macOS prompt, by account id (KERNEL-618): `prompt` while Kernel's own
   * read keeps the prompt up, true once someone allowed it, and `endedAt` once it gave up. `checking` is a check under way.
   */
  private keychain = new Map<string, { prompt?: Promise<boolean>; endedAt?: number }>()
  private checking = new Map<string, Promise<'prompt' | 'later' | undefined>>()
  /**
   * How long a Keychain read may take before it counts as waiting on a macOS prompt, how long Kernel keeps its read and so
   * the prompt up for someone to allow it, and how long after one nobody allowed before it asks again (KERNEL-618). Tests
   * shorten them.
   */
  keychainMs = { wait: 5_000, prompt: 2 * 60_000, retry: 10 * 60_000 }

  // ---------- models

  /**
   * A provider's models with the efforts each takes. Claude's are Kernel's own list. Codex's come from `model/list` on the
   * active account, hidden ones left out.
   */
  models(provider: Provider): Promise<ProviderModel[]> {
    if (provider === 'claude') return Promise.resolve(MODELS.map((m) => ({ provider, id: m.id, label: m.label, efforts: EFFORTS.map((e) => e.id), defaultEffort: 'high' as Effort })))
    this.codexModels ??= (async () => {
      const bin = this.binary('codex').path
      if (!bin) throw new Error('Kernel could not find Codex.')
      const known = (e: string): e is Effort => e in EFFORT_LABELS
      return (await readCodexModels(bin, this.codexHome(), this.apiKey('codex'))).map((m) => ({
        provider: 'codex' as const, id: m.id, label: m.displayName, description: m.description, isDefault: m.isDefault,
        efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort).filter(known),
        defaultEffort: known(m.defaultReasoningEffort) ? m.defaultReasoningEffort : 'medium'
      }))
    })().catch((e) => { this.codexModels = undefined; throw e })
    return this.codexModels
  }

  /** Fork chat on Codex: a new thread with the old one's turns, through `lastTurnId` when given. Returns the new thread's id. */
  async forkCodex(threadId: string, cwd: string, lastTurnId?: string): Promise<string> {
    const r = await withCodex(this.mustBinary('codex'), this.codexHome(), (rpc) => rpc.request<ThreadForkResponse>('thread/fork', { threadId, cwd, ...(lastTurnId ? { lastTurnId } : {}) }), { cwd, apiKey: this.apiKey('codex') })
    return r.thread.id
  }

  // ---------- executables and status

  /** The executable a provider runs, by Settings, Providers. */
  binary(provider: Provider): { path?: string; source: ProviderStatus['source'] } {
    return resolveBinary(provider, this.settings?.providers?.[provider])
  }

  private mustBinary(provider: Provider): string {
    const path = this.binary(provider).path
    if (!path) throw new Error(provider === 'claude' ? 'Kernel could not find Claude Code.' : 'Kernel could not find Codex.')
    return path
  }

  /** The CLI's own config file, which Open shows. */
  configFile(provider: Provider) { return provider === 'claude' ? this.k.hooks.claudeSettings : join(this.codexRoot(), 'config.toml') }

  /** Codex's own home, which every account's home links to. */
  private codexRoot() { return process.env.CODEX_HOME ?? join(this.home, '.codex') }

  /**
   * Settings, Providers' status table for the active account, read through Kernel's own binary rather than whatever is on
   * the PATH (KERNEL-277). Text only: version, login method, plan and email.
   */
  async status(provider: Provider): Promise<ProviderStatus> {
    const { path, source } = this.binary(provider)
    const base: ProviderStatus = { provider, path, source, signedIn: false, configFile: this.configFile(provider) }
    if (!path) return { ...base, error: provider === 'claude' ? 'Kernel could not find Claude Code.' : 'Kernel could not find Codex.' }
    const v = await exec(path, ['--version'], { timeoutMs: 60_000 })
    const version = v.code === 0 ? versionOf(v.stdout) : undefined
    if (!version) return { ...base, error: `${path} did not start.` }
    const who = await this.identity(provider, this.active(provider), path)
    return { ...base, version, ...who }
  }

  /**
   * Who an account is signed in as, read through `bin`. Every read of a login counts toward its sign-in health (`noteLogin`).
   * An added Claude login reads through its folder (KERNEL-567). An API key account is signed in while it has a key no
   * session refused. A Codex login made with an API key outside Kernel reads as signed out: only a key account the user
   * added bills a key (D-018, KERNEL-523).
   */
  private async identity(provider: Provider, accountId: string | undefined, bin: string): Promise<Pick<ProviderStatus, 'signedIn' | 'loginMethod' | 'plan' | 'email' | 'error'>> {
    const added = accountId ? this.stored(provider, accountId) : undefined
    if (added?.auth === 'apiKey') return this.keySignedIn(added.id) ? { signedIn: true, loginMethod: 'API key' } : { signedIn: false }
    if (provider === 'claude') {
      // A legacy token can't say who it belongs to or which plan, so it is what the user said when adding it.
      if (added && !added.home) return this.tokenSignedIn(added.id) ? { signedIn: true, loginMethod: 'Token from claude setup-token', plan: added.plan } : { signedIn: false }
      const who = added ? await this.readClaudeLogin(added) : await claudeStatus(bin)
      if (!added && who) await this.noteLogin('claude', undefined, who)
      return who?.signedIn ? { signedIn: true, loginMethod: 'Claude account', plan: who.plan, email: who.email } : { signedIn: false }
    }
    const r = await readCodexAccount(bin, added ? this.codexHome(added.id) : undefined)
    const chatgpt = r.account?.type === 'chatgpt' ? r.account : undefined
    if (!r.failed) await this.noteLogin('codex', added?.id, { signedIn: !!chatgpt, email: chatgpt?.email ?? undefined, plan: codexPlan(chatgpt?.planType) })
    if (!chatgpt) return { signedIn: false, ...(r.account ? { error: 'Codex is signed in with an API key. Kernel runs agents on your ChatGPT plan, so sign in with ChatGPT.' } : {}) }
    return { signedIn: true, loginMethod: 'ChatGPT', plan: codexPlan(chatgpt.planType), email: chatgpt.email ?? undefined }
  }

  /** Whether the provider's active account is signed in. */
  async signedIn(provider: Provider): Promise<boolean> {
    const bin = this.binary(provider).path
    return !!bin && (await this.identity(provider, this.active(provider), bin)).signedIn
  }

  /** The executable path field and "Use system Claude" / "Use system Codex" / "Use bundled". */
  async setPath(provider: Provider, o: { path?: string; useSystem?: boolean }): Promise<ProviderStatus> {
    const cur: ProviderBinary = this.settings.providers[provider]
    const next = { path: o.path !== undefined ? o.path.trim() : cur.path, useSystem: o.useSystem ?? cur.useSystem }
    await this.k.config.setSettings({ providers: { [provider]: next } })
    if (provider === 'codex') this.codexModels = undefined
    this.k.team.forgetOffers(provider)
    // A process runs the executable it started with, so the next turn picks up the new one.
    this.sessions.restartProvider(provider)
    return this.status(provider)
  }

  // ---------- accounts

  private get accountsFile() { return join(this.o.dataDir, 'accounts.json') }
  private get tokensFile() { return join(this.o.dataDir, 'claude-tokens.json') }
  private get keysFile() { return join(this.o.dataDir, 'api-keys.json') }

  private load(): AccountsFile {
    if (this.accounts) return this.accounts
    const empty: AccountsFile = { claude: { accounts: [] }, codex: { accounts: [] } }
    try {
      const saved = JSON.parse(readFileSync(this.accountsFile, 'utf8')) as Partial<AccountsFile>
      for (const p of ['claude', 'codex'] as const) {
        const list = Array.isArray(saved[p]?.accounts) ? saved[p]!.accounts.filter((a) => typeof a?.id === 'string' && typeof a.label === 'string') : []
        const cli = saved[p]?.cli && typeof saved[p]!.cli === 'object' ? saved[p]!.cli : undefined
        empty[p] = { accounts: list, ...(list.some((a) => a.id === saved[p]?.active) ? { active: saved[p]!.active } : {}), ...(cli ? { cli } : {}) }
      }
    } catch { /* none yet */ }
    this.accounts = empty
    return empty
  }

  private async save() { await writeFile(this.accountsFile, JSON.stringify(this.load(), null, 2)) }

  private stored(provider: Provider, id: string): StoredAccount | undefined { return this.load()[provider].accounts.find((a) => a.id === id) }

  /** The account a provider runs on now. Undefined is the CLI's own login. */
  active(provider: Provider): string | undefined { return this.load()[provider].active }

  /** The account is in Kernel: the CLI's own login (`cli`) always is, an added one until it is removed (KERNEL-843). */
  has(provider: Provider, accountId: string): boolean { return accountId === CLI_ACCOUNT || !!this.stored(provider, accountId) }

  /**
   * Whether the account is signed in, as Kernel last read it, with no read now (KERNEL-843). The CLI's own login until a read
   * found it signed out, an added login likewise, and a token or key account while it has one no session refused.
   */
  signedInNow(provider: Provider, accountId: string): boolean {
    if (accountId === CLI_ACCOUNT) return this.load()[provider].cli?.signedIn !== false
    const a = this.stored(provider, accountId)
    return !!a && this.storedSignedIn(provider, a)
  }

  private storedSignedIn(provider: Provider, a: StoredAccount): boolean {
    if (a.auth === 'apiKey') return this.keySignedIn(a.id)
    if (provider === 'codex') return a.signedIn !== false && existsSync(join(this.codexHome(a.id)!, 'auth.json'))
    return a.home ? a.signedIn !== false && !this.moved(a) : this.tokenSignedIn(a.id)
  }

  /** The providers a room's agents run on, by their picks. A room Kernel hasn't read yet counts every role's. */
  usedIn(roomId: string): Provider[] {
    const agents = this.k.team.agentsSync(roomId)
    const picks = agents.length ? agents.map((a) => this.k.team.pickFor(a).provider) : Object.values(this.settings.models.roles).map((r) => r.provider)
    return [...new Set(picks)]
  }

  /** CODEX_HOME of a Codex account, the active one by default. Undefined is Codex's own `~/.codex`, the CLI login. */
  codexHome(accountId = this.active('codex')): string | undefined {
    return accountId ? join(this.o.dataDir, 'codex-homes', accountId) : undefined
  }

  /**
   * The folder a Claude account signs in to and runs in, as CLAUDE_CONFIG_DIR. Built one way, with no trailing slash and no
   * `realpath`, since its Keychain item is named after this exact string (KERNEL-560).
   */
  claudeHome(accountId: string): string { return join(this.o.dataDir, 'claude-homes', accountId) }

  /** `~/.claude`, which every Claude account's folder links to. CLAUDE_CONFIG_DIR moves it, as it does for the CLI. */
  private claudeRoot() { return process.env.CLAUDE_CONFIG_DIR ?? join(this.home, '.claude') }

  /** The CLI login's `.claude.json`, which holds the MCP servers every account copies. */
  private claudeConfig() { return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(this.home, '.claude.json') }

  /**
   * A Claude login's folder moved with the data folder, so the Keychain item it signed in with no longer matches. It reads
   * as signed out until Sign in again logs in at the new path (KERNEL-560).
   */
  private moved(a: StoredAccount) { return !!a.home && a.home !== this.claudeHome(a.id) }

  /**
   * Before each Claude process on an added login: what `~/.claude` gained since is linked in, its plugins are merged with the
   * CLI login's and linked again (KERNEL-646), and its MCP servers are synced with the CLI login's, which then gives it the
   * shared `.claude.json` keys (KERNEL-560, KERNEL-618). A failure leaves the folder as it was, and the login still runs.
   */
  private readyClaudeHome(home: string) {
    try { linkClaudeHome(home, this.claudeRoot()) } catch { /* ~/.claude can't be read: the account runs on what it has */ }
    try { syncClaudePlugins(home, this.claudeRoot()) } catch { /* the same */ }
    try { syncClaudeConfig(home, this.claudeConfig()) } catch { /* the same */ }
  }

  /**
   * Brings the MCP servers added, changed or removed on each added login to the CLI login's `.claude.json`, and from there to
   * the others (`syncClaudeConfig`), so one added on any account is on every account from its next process, the CLI's own
   * included (KERNEL-618). Plugins go the same way through `~/.claude/plugins` (`syncClaudePlugins`, KERNEL-646). At most
   * once every SHARE_EVERY_MS. A folder that moved is left alone.
   */
  private syncConfigs() {
    if (this.stopped || Date.now() - this.syncedAt < SHARE_EVERY_MS) return
    this.syncedAt = Date.now()
    for (const a of this.load().claude.accounts) {
      if (!a.home || this.moved(a)) continue
      try { syncClaudePlugins(a.home, this.claudeRoot()) } catch { /* the next process tries again */ }
      try { syncClaudeConfig(a.home, this.claudeConfig()) } catch { /* the next process tries again */ }
    }
  }

  /**
   * What a Claude process adds to its environment for an account, the active one by default: an added login's folder as
   * CLAUDE_CONFIG_DIR, readied first (KERNEL-567), a legacy token, or an API key account's key (KERNEL-523). Nothing for
   * the CLI login, which `cli` names too. A folder that moved is passed as it signed in, so its sessions fail as signed out
   * rather than run on another login. The MCP sign-ins are shared first (KERNEL-616), and the MCP servers synced (KERNEL-618).
   */
  claudeEnv(accountId = this.active('claude')): Record<string, string> {
    const a = accountId && accountId !== CLI_ACCOUNT ? this.stored('claude', accountId) : undefined
    // Each Claude process reads its MCP sign-ins from its login's Keychain item, and its servers from its `.claude.json`.
    this.shareMcp()
    this.syncConfigs()
    if (!a) return {}
    if (a.auth === 'apiKey') {
      const key = this.apiKey('claude', a.id)
      return key ? { ANTHROPIC_API_KEY: key } : {}
    }
    if (a.home) {
      if (!this.moved(a)) this.readyClaudeHome(a.home)
      return accountEnv(a.home)
    }
    const token = this.tokens()[a.id]
    if (!token || !this.o.cipher) return {}
    try { return { CLAUDE_CODE_OAUTH_TOKEN: this.o.cipher.decrypt(token) } } catch { return {} }
  }

  /** How an account signs in, the active one by default (KERNEL-523). The CLI's own login is a subscription one. */
  auth(provider: Provider, accountId = this.active(provider)): AccountAuth {
    return accountId && this.stored(provider, accountId)?.auth === 'apiKey' ? 'apiKey' : 'subscription'
  }

  /** An API key account's key, the active account's by default. Undefined for any other account, or a key Kernel can't read. */
  apiKey(provider: Provider, accountId = this.active(provider)): string | undefined {
    const sealed = accountId && this.auth(provider, accountId) === 'apiKey' ? this.keys()[accountId] : undefined
    if (!sealed || !this.o.cipher) return undefined
    try { return this.o.cipher.decrypt(sealed) } catch { return undefined }
  }

  /** A legacy Claude token account has a token no session has refused. */
  private tokenSignedIn(id: string) { return !!this.tokens()[id] && !this.refused.has(id) }

  /** An API key account has a key no session has refused. */
  private keySignedIn(id: string) { return !!this.keys()[id] && !this.refused.has(id) }

  /**
   * The Claude account sessions run on, when it is one Kernel added, with the plan the defaults follow (KERNEL-225). An
   * added login reads its email and plan from Claude Code, so the defaults follow an upgrade or a downgrade (KERNEL-567). A
   * legacy token account has the plan the user picked, and an API key account none. Undefined for the CLI's own login,
   * which Kernel reads from the CLI.
   */
  async addedClaudeAccount(): Promise<ReadAccount | undefined> {
    const id = this.active('claude')
    const a = id ? this.stored('claude', id) : undefined
    if (!a) return undefined
    if (a.auth === 'apiKey') return { signedIn: this.keySignedIn(a.id), name: a.label }
    if (!a.home) return { signedIn: this.tokenSignedIn(a.id), name: a.label, ...(a.plan ? { plan: a.plan } : {}), ...(a.claudePlan ? { subscriptionType: a.claudePlan } : {}) }
    const who = await this.readClaudeLogin(a)
    const signedIn = who?.signedIn ?? (a.signedIn !== false && !this.moved(a))
    return { signedIn, name: a.label, ...(a.email ? { email: a.email } : {}), ...(a.plan ? { plan: a.plan } : {}), ...(a.claudePlan ? { subscriptionType: a.claudePlan } : {}) }
  }

  /**
   * Reads an added Claude login through Claude Code with its folder: its sign-in, email and plan, kept on the account
   * (`noteLogin`). A folder that moved reads as signed out. Undefined when Claude Code didn't answer, or when the login it
   * read as signed out waits on a Keychain prompt (`keychainCheck`, KERNEL-618).
   */
  private async readClaudeLogin(a: StoredAccount): Promise<ClaudeLogin | undefined> {
    const bin = this.binary('claude').path
    if (!bin || !a.home) return undefined
    let who: ClaudeLogin | undefined = { signedIn: false }
    if (!this.moved(a)) {
      this.readyClaudeHome(a.home)
      who = await claudeStatus(bin, loginEnv(a.home))
      // Claude Code gives up on a Keychain read after 2 seconds and says signed out, which a login waiting on a prompt isn't.
      if (!who?.signedIn && a.signedIn !== false && await this.keychainCheck(a)) return undefined
      if (who?.signedIn) this.keychainRead(a.id)
    }
    if (who) await this.noteLogin('claude', a.id, who)
    return who
  }

  /**
   * What a read found about a login, `id` undefined for the CLI's own (KERNEL-567): an added one keeps its email and plan,
   * and a name that was its email follows a new one. Each change is saved and tells every window, and a login going from
   * signed in to signed out saves one Inbox notice, unless the user signed it out (`quiet`).
   */
  private async noteLogin(provider: Provider, id: string | undefined, who: { signedIn: boolean; email?: string; plan?: string; subscriptionType?: string; orgId?: string }, o: { quiet?: boolean; push?: boolean } = {}) {
    const file = this.load()
    const a = id ? this.stored(provider, id) : undefined
    if ((id && !a) || this.stopped) return
    const rec: StoredCli | StoredAccount = a ?? (file[provider].cli ??= {})
    const was = rec.signedIn
    let changed = was !== who.signedIn
    rec.signedIn = who.signedIn
    if (who.signedIn && who.email && rec.email !== who.email && !a) { rec.email = who.email; changed = true }
    if (who.signedIn && who.orgId && rec.orgId !== who.orgId && !a) { rec.orgId = who.orgId; changed = true }
    let planChanged = false
    if (who.signedIn && a) {
      const tier = provider === 'claude' ? planOf(who.subscriptionType) : 'unknown'
      const next = { email: who.email ?? a.email, plan: who.plan ?? a.plan, claudePlan: tier === 'unknown' ? a.claudePlan : tier, orgId: who.orgId ?? a.orgId }
      const label = a.label === a.email && next.email ? next.email : a.label
      planChanged = next.claudePlan !== a.claudePlan
      if (next.email !== a.email || next.plan !== a.plan || planChanged || next.orgId !== a.orgId || label !== a.label) {
        Object.assign(a, next, { label })
        if (!a.orgId) delete a.orgId
        changed = true
      }
    }
    if (!changed) return
    await this.save()
    if (this.stopped) return
    if (was === true && !who.signedIn && !o.quiet) {
      const name = a?.label ?? file[provider].cli?.label ?? file[provider].cli?.email ?? OWN_LOGIN[provider]
      // One a day at most: a session the server refuses while `auth status` still reads signed in goes round every 10 seconds.
      const day = new Date().toISOString().slice(0, 10)
      // The CLI's own login that is also an added account saves under that account's id, so when both sign out, whichever is
      // read first says so and the other adds nothing. One that signs out alone still says so (KERNEL-701).
      const on = a?.id ?? this.twinOfCli(provider, rec)?.id ?? CLI_ACCOUNT
      this.notifications.notice({ id: `n-signed-out-${provider}-${on}-${day}`, title: `${name} is signed out`, sub: 'Sign in again in Settings, Providers.', heading: `${name} is signed out`, body: `${name} is signed out. Sign in again in Settings, Providers.` })
    }
    // The plan defaults follow the plan of the account in use (KERNEL-225).
    if (planChanged && provider === 'claude' && id === this.active('claude')) void this.k.account.accountChanged().catch(() => undefined)
    if (o.push !== false) void this.pushAccounts()
  }

  /** Whether sessions start on this account now. Undefined and `cli` both name the CLI's own login. */
  isActive(provider: Provider, accountId: string | undefined): boolean {
    return (accountId ?? CLI_ACCOUNT) === (this.active(provider) ?? CLI_ACCOUNT)
  }

  /**
   * A session on one of the provider's accounts was refused: the one `on` names, undefined there for the CLI's own login,
   * or the active one without `on`. An added login reads as signed out
   * until a read of it says otherwise (KERNEL-567). A token or API key stays signed out until a new one replaces it, or the
   * 10-second sign-in check would lift the hold at once. The CLI's own login is read by `Account` while it is in use. One
   * the provider has left since reads as signed out here, as an added login does. A login waiting on a Keychain prompt is
   * not signed out (KERNEL-618).
   */
  credentialRefused(provider: Provider, on?: { account: string | undefined }) {
    const accountId = on ? on.account ?? CLI_ACCOUNT : this.active(provider)
    const a = accountId && accountId !== CLI_ACCOUNT ? this.stored(provider, accountId) : undefined
    if (!a) {
      const cli = !accountId || accountId === CLI_ACCOUNT
      if (cli && !this.isActive(provider, accountId)) void this.noteLogin(provider, undefined, { signedIn: false })
      return
    }
    if (this.keychain.get(a.id)?.prompt) return
    if (a.home || (provider === 'codex' && a.auth !== 'apiKey')) { void this.noteLogin(provider, a.id, { signedIn: false }); return }
    if (this.refused.has(a.id)) return
    this.refused.add(a.id)
    void this.pushAccounts()
  }

  private tokens() { return this.sealed(this.tokensFile) }
  private keys() { return this.sealed(this.keysFile) }
  private saveToken(id: string, token: string | undefined) { return this.seal(this.tokensFile, id, token, 'token') }
  private saveKey(id: string, key: string | undefined) { return this.seal(this.keysFile, id, key, 'key') }

  private sealed(file: string): Record<string, string> {
    try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string> } catch { return {} }
  }

  /** Keeps an account's credential encrypted with `safeStorage` in `file`, or forgets it. A new one is no longer refused. */
  private async seal(file: string, id: string, secret: string | undefined, what: 'token' | 'key') {
    const all = this.sealed(file)
    this.refused.delete(id)
    if (secret === undefined) delete all[id]
    else {
      if (!this.o.cipher) throw new Error(`Kernel can't keep the ${what} safe on this Mac, so it can't add the account.`)
      all[id] = this.o.cipher.encrypt(secret)
    }
    await writeFile(file, JSON.stringify(all, null, 2), { mode: 0o600 })
  }

  /**
   * A Codex account's home: its own `auth.json`, and everything else linked to `~/.codex`, so a switch keeps chat history,
   * MCP servers, plugins, skills and config. Run again before each use, so what `~/.codex` gained since is linked too.
   */
  async linkCodexHome(home: string) {
    const root = this.codexRoot()
    await mkdir(home, { recursive: true })
    await mkdir(root, { recursive: true })
    for (const dir of CODEX_SHARED_DIRS) await mkdir(join(root, dir), { recursive: true })
    for (const name of await readdir(root)) {
      if (CODEX_OWN.has(name)) continue
      const at = join(home, name)
      if (await lstat(at).then(() => true, () => false)) continue
      await symlink(join(root, name), at)
    }
  }

  /**
   * Every account of both providers, each provider's CLI login first. A signed-in CLI login that is also an added account
   * shows once, as that account's row with `alsoCli`, in use while the CLI login is, and other rows name that row for it
   * (KERNEL-701).
   */
  async list(): Promise<AccountProfile[]> {
    const file = this.load()
    const out: AccountProfile[] = []
    for (const { id: provider } of PROVIDERS) {
      const bin = this.binary(provider).path
      const cli = bin ? await this.identity(provider, undefined, bin) : { signedIn: false }
      const saved = file[provider].cli
      const cliActive = !file[provider].active
      const twin = cli.signedIn ? this.twinOfCli(provider, { email: cli.email, orgId: saved?.orgId }) : undefined
      // The CLI's own login's chats count on its twin's row (KERNEL-843).
      const counts = this.k.placement.chatsPerAccount(provider)
      const chats = (id: string) => (counts.get(id) ?? 0) + (twin?.id === id ? counts.get(CLI_ACCOUNT) ?? 0 : 0)
      const extras = (id: string) => {
        const e = { ...this.extras(provider, id), ...(chats(id) ? { chats: chats(id) } : {}) }
        if (!twin || !e.sameOrg) return e
        const { sameOrg, ...rest } = e
        const peers = [...new Set(sameOrg.map((x) => (x === CLI_ACCOUNT ? twin.id : x)))].filter((x) => x !== id)
        return peers.length ? { ...rest, sameOrg: peers } : rest
      }
      if (!twin) out.push({ id: CLI_ACCOUNT, provider, label: saved?.label ?? cli.email ?? saved?.email ?? OWN_LOGIN[provider], email: cli.email, plan: cli.plan, cli: true, auth: 'subscription', active: cliActive, signedIn: cli.signedIn, ...extras(CLI_ACCOUNT) })
      for (const a of file[provider].accounts) {
        const key = a.auth === 'apiKey'
        const legacy = provider === 'claude' && !key && !a.home
        const also = a === twin
        const signedIn = (also && cliActive) || this.storedSignedIn(provider, a)
        out.push({ id: a.id, provider, label: a.label, email: a.email, plan: a.plan, cli: false, ...(also ? { alsoCli: true as const } : {}), auth: key ? 'apiKey' : 'subscription', active: file[provider].active === a.id || (also && cliActive), signedIn, ...(legacy ? { usageFromTurns: true, legacyToken: true } : {}), ...extras(a.id) })
      }
    }
    return out
  }

  /**
   * What a row adds: the MCP servers that need a sign-in, as last checked, less the quiet ones (`loudSignIns`), and the models
   * it lacks, as last read (KERNEL-616).
   * On Claude, the accounts in its organization and a wait on a Keychain prompt (KERNEL-618).
   */
  private extras(provider: Provider, id: string): Pick<AccountProfile, 'mcpSignIns' | 'missingModels' | 'sameOrg' | 'keychainWait'> {
    const signIns = provider === 'claude' ? this.loudSignIns(id) : undefined
    const missing = this.missing(provider, id)
    const peers = this.sameOrg(provider, id)
    return { ...(signIns ? { mcpSignIns: signIns } : {}), ...(missing ? { missingModels: missing } : {}), ...(peers ? { sameOrg: peers } : {}), ...(provider === 'claude' && this.keychain.has(id) ? { keychainWait: true } : {}) }
  }

  /** Tells every window the accounts changed. */
  async pushAccounts() {
    const accounts = await this.list().catch(() => undefined)
    if (accounts && !this.stopped) bus.push({ type: 'accounts', accounts })
  }

  /** Every account, told to every window too, for an action's answer. */
  private async pushList(): Promise<AccountProfile[]> {
    const accounts = await this.list()
    if (!this.stopped) bus.push({ type: 'accounts', accounts })
    return accounts
  }

  private step(add: AccountAddStep) { if (!this.stopped) bus.push({ type: 'account.add', add }) }

  // ---------- usage (KERNEL-567)

  /**
   * Each subscription account whose usage windows Kernel can read, for `Sessions.usage`. A live process on the account
   * answers. With `probe`, an account without one gets a read of its own: a short Claude session in its folder, or Codex's
   * account read in its home, which also checks its sign-in. With `check`, a Claude read checks the sign-in first and asks a
   * signed-out account nothing. A legacy token account's usage comes from its turns and an API key account has none, so
   * neither is read. `active` keeps only the accounts in use, and `provider` only that provider's.
   */
  usageReads(o: { probe?: boolean; check?: boolean; active?: boolean; provider?: Provider } = {}): UsageRead[] {
    const file = this.load()
    const out: UsageRead[] = []
    for (const { id: provider } of PROVIDERS) {
      if (o.provider && o.provider !== provider) continue
      const added = file[provider].accounts.filter((a) => a.auth !== 'apiKey' && (provider === 'codex' || !!a.home)).map((a) => a.id)
      for (const id of [undefined, ...added]) {
        if (o.active && id !== this.active(provider)) continue
        const read = o.probe ? (merge: (p: LimitPatch[]) => void) => this.tracked(id, provider === 'claude' ? this.readClaudeUsage(id, merge, !!o.check) : this.readCodexUsage(id, merge)) : undefined
        out.push({ provider, ...(id ? { accountId: id } : {}), ...(read ? { read } : {}) })
      }
    }
    return out
  }

  /**
   * Reads every subscription account's usage windows and sign-in now (KERNEL-567): at launch and when the account menu or
   * Settings, Providers opens (`usage.get`), every 10 minutes while agents work, a minute after a turn finishes on the
   * account (`readUsageAfterTurn`), and when the account in use nears or hits
   * a limit (`Account.applyLimits`). An account read in the last minute isn't read again unless `force`, so a read that is
   * already running isn't doubled.
   */
  async readUsage(o: { force?: boolean; provider?: Provider; account?: string } = {}): Promise<RateLimit[]> {
    if (this.stopped) return []
    const now = Date.now()
    const key = (r: UsageRead) => `${r.provider}:${r.accountId ?? CLI_ACCOUNT}`
    const reads = this.usageReads({ probe: true, check: true, provider: o.provider })
      .filter((r) => (!o.account || (r.accountId ?? CLI_ACCOUNT) === o.account) && (o.force || now - (this.usageReadAt.get(key(r)) ?? 0) >= USAGE_FRESH_MS))
    for (const r of reads) this.usageReadAt.set(key(r), now)
    return this.sessions.usage(reads)
  }

  /**
   * A turn on `accountId` (undefined for the CLI's own login) finished, so its account's usage is read USAGE_AFTER_TURN_MS
   * from now, once for every turn on it that finishes before then (KERNEL-673). A failed read keeps the last numbers.
   */
  readUsageAfterTurn(provider: Provider, accountId: string | undefined) {
    const account = accountId ?? CLI_ACCOUNT
    const key = `${provider}:${account}`
    if (this.stopped || this.afterTurn.has(key)) return
    const timer = setTimeout(() => {
      this.afterTurn.delete(key)
      void this.readUsage({ provider, account }).catch(() => undefined)
    }, USAGE_AFTER_TURN_MS)
    timer.unref?.()
    this.afterTurn.set(key, timer)
  }

  private tracked(id: string | undefined, read: Promise<void>): Promise<void> {
    if (!id) return read
    const running = this.reading.get(id) ?? new Set<Promise<void>>()
    this.reading.set(id, running)
    const p = read.finally(() => running.delete(p))
    running.add(p)
    return p
  }

  /** A Claude account's windows from a short session on it, `id` undefined for the CLI's own login. `check` reads its sign-in first. */
  private async readClaudeUsage(id: string | undefined, merge: (p: LimitPatch[]) => void, check: boolean) {
    const bin = this.binary('claude').path
    const a = id ? this.stored('claude', id) : undefined
    if (!bin || (id && !a)) return
    if (check) {
      const who = a ? await this.readClaudeLogin(a) : await claudeStatus(bin)
      if (!a && who) await this.noteLogin('claude', undefined, who)
      if (!who?.signedIn) return
    }
    await probeClaudeUsage(this.o.dataDir, merge, { env: id ? this.claudeEnv(id) : {}, bin: claudeExecutable(this.settings.providers?.claude) })
  }

  /** A Codex account's windows and sign-in from one account read in its home, `id` undefined for the CLI's own login. */
  private async readCodexUsage(id: string | undefined, merge: (p: LimitPatch[]) => void) {
    const bin = this.binary('codex').path
    if (!bin || (id && !this.stored('codex', id))) return
    const r = await readCodexAccount(bin, id ? this.codexHome(id) : undefined)
    const chatgpt = r.account?.type === 'chatgpt' ? r.account : undefined
    if (!r.failed) await this.noteLogin('codex', id, { signedIn: !!chatgpt, email: chatgpt?.email ?? undefined, plan: codexPlan(chatgpt?.planType) })
    merge(codexLimits(r.limits?.rateLimits, id))
  }

  // ---------- adding, signing in and out

  /**
   * Add account. Claude runs `claude auth login` in a new folder of the account's own, and Codex signs in with ChatGPT in a
   * new home of its own (KERNEL-406, KERNEL-567). Each reads its email and plan from the account, and its email names it until
   * it is renamed. The new account is added but not used until the user switches to it, or Kernel does at a limit once the
   * user turned that on (KERNEL-568). A login Kernel already has is refused and its new folder or home goes (KERNEL-616).
   */
  async add(provider: Provider): Promise<AccountProfile> {
    if (this.adding.has(provider)) throw new Error('A sign-in is already open. Finish or cancel it first.')
    const id = randomUUID()
    const profile = provider === 'claude' ? await this.addClaude(id) : await this.addCodex(id)
    this.step({ provider, step: 'done', account: profile })
    void this.pushAccounts()
    // Its MCP servers, and a notice when some need a sign-in there (KERNEL-626).
    void this.k.mcp.accountAdded(provider, profile.id).catch(() => undefined)
    // Its windows, so its row has them before it runs a turn.
    void this.readUsage({ provider }).catch(() => undefined)
    return profile
  }

  private async addCodex(id: string): Promise<AccountProfile> {
    const home = this.codexHome(id)!
    await this.linkCodexHome(home)
    try {
      const who = await this.codexSignIn(home)
      if (await this.alreadyIn('codex', who)) throw new Error(ALREADY_IN)
      const stored: StoredAccount = { id, label: who.email || 'ChatGPT account', email: who.email, plan: who.plan, signedIn: true, createdAt: Date.now() }
      this.load().codex.accounts.push(stored)
      await this.save()
      return { id, provider: 'codex', label: stored.label, email: who.email, plan: who.plan, cli: false, auth: 'subscription', active: false, signedIn: true }
    } catch (e) {
      await removeTree(home).catch(() => undefined)
      this.step({ provider: 'codex', step: 'failed', error: (e as Error).message })
      throw e
    }
  }

  /**
   * Whether a login that just signed in is one Kernel has: an added account of the provider, or its CLI's own login while
   * that is signed in (`sameLogin`, KERNEL-616). Sign in again passes its own row as `except`, and leaves the CLI's own login
   * out (`cli: false`), since that one folds into its row (KERNEL-701).
   */
  private async alreadyIn(provider: Provider, who: { email?: string; orgId?: string }, o: { except?: string; cli?: boolean } = {}): Promise<boolean> {
    if (!who.email) return false
    if (this.load()[provider].accounts.some((a) => a.id !== o.except && a.auth !== 'apiKey' && sameLogin(a, who))) return true
    const bin = this.binary(provider).path
    if (!bin || o.cli === false) return false
    if (provider === 'claude') {
      const cli = await claudeStatus(bin)
      return !!cli?.signedIn && sameLogin(cli, who)
    }
    const r = await readCodexAccount(bin, undefined)
    return r.account?.type === 'chatgpt' && sameLogin({ email: r.account.email ?? undefined }, who)
  }

  /** The added account that is the CLI's own login `cli`, when one is (`sameLogin`, KERNEL-701). */
  private twinOfCli(provider: Provider, cli: { email?: string; orgId?: string } | undefined): StoredAccount | undefined {
    return this.load()[provider].accounts.find((a) => a.auth !== 'apiKey' && sameLogin(cli, a))
  }

  /** A full Claude login in the new account's folder. Never `claude setup-token` (KERNEL-567). */
  private async addClaude(id: string): Promise<AccountProfile> {
    const home = this.claudeHome(id)
    try {
      const who = await this.claudeLogin(home)
      if (await this.alreadyIn('claude', who)) {
        // The new folder's login goes with its Keychain item. The account's other login stays signed in.
        const bin = this.binary('claude').path
        if (bin) await logoutClaude(bin, home).catch(() => undefined)
        throw new Error(ALREADY_IN)
      }
      const tier = planOf(who.subscriptionType)
      const stored: StoredAccount = { id, label: who.email ?? 'Claude account', email: who.email, plan: who.plan, ...(tier !== 'unknown' ? { claudePlan: tier } : {}), ...(who.orgId ? { orgId: who.orgId } : {}), home, signedIn: true, createdAt: Date.now() }
      this.load().claude.accounts.push(stored)
      await this.save()
      return { id, provider: 'claude', label: stored.label, email: who.email, plan: who.plan, cli: false, auth: 'subscription', active: false, signedIn: true }
    } catch (e) {
      await removeClaudeHome(home).catch(() => undefined)
      this.step({ provider: 'claude', step: 'failed', error: (e as Error).message })
      throw e
    }
  }

  /**
   * Adds an API key account (KERNEL-523), or with `accountId` gives a key account a new key, which signs it in again. Kernel
   * checks the key with one request first and keeps it encrypted. A Codex key account gets a home of its own like any other,
   * and its processes log in with the key, in memory only. Like every account, it isn't used until the user switches to it.
   */
  async addKey(provider: Provider, o: { key: string; label?: string; accountId?: string }): Promise<AccountProfile> {
    const old = o.accountId === undefined ? undefined : this.load()[provider].accounts.find((a) => a.id === o.accountId && a.auth === 'apiKey')
    if (o.accountId !== undefined && !old) throw new Error('That API key account is no longer in Kernel.')
    const label = old?.label ?? o.label?.trim()
    const key = o.key.trim()
    if (!label) throw new Error('Give the account a name.')
    if (!key) throw new Error('Paste the API key.')
    if (!this.o.cipher) throw new Error("Kernel can't keep the key safe on this Mac, so it can't add the account.")
    await checkApiKey(provider, key, this.o.fetch)
    const id = old?.id ?? randomUUID()
    if (provider === 'codex') await this.linkCodexHome(this.codexHome(id)!)
    await this.saveKey(id, key)
    if (!old) {
      this.load()[provider].accounts.push({ id, label, auth: 'apiKey', createdAt: Date.now() })
      await this.save()
    }
    const active = this.active(provider) === id
    // Idle processes on the old key end, chats kept on the account included (KERNEL-843), and the next sign-in check lifts
    // the hold its refusal put on.
    if (old) this.sessions.restartProvider(provider, { account: id })
    if (active && provider === 'claude') await this.k.account.accountChanged()
    void this.pushAccounts()
    return { id, provider, label, cli: false, auth: 'apiKey', active, signedIn: true }
  }

  /**
   * `claude auth login` in a pty, in the account's folder `home` (KERNEL-560). The CLI opens its sign-in in the browser, and
   * Kernel passes the link on in case it didn't, with the code field at once, since the CLI shows its prompt from the start.
   * A code the page shows reaches the CLI through `accounts.code`. The folder is linked right after, before any session or
   * probe makes real folders where the links go. Resolves with who signed in. Never an API key or a token from the Mac (D-018).
   */
  private async claudeLogin(home: string): Promise<ClaudeLogin> {
    const bin = this.mustBinary('claude')
    await mkdir(home, { recursive: true })
    const run = loginClaude(bin, {
      env: sessionEnv(process.env, accountEnv(home)), cwd: this.home, timeoutMs: SIGN_IN_MS,
      onLink: (url) => this.step({ provider: 'claude', step: 'browser', url }),
      onCode: () => this.step({ provider: 'claude', step: 'code' })
    })
    this.adding.set('claude', { cancel: run.cancel, code: run.sendCode })
    try { await run.done } finally { this.adding.delete('claude') }
    this.readyClaudeHome(home)
    const who = await claudeStatus(bin, loginEnv(home))
    if (!who?.signedIn) throw new Error("Claude Code finished the sign-in, but Kernel couldn't read the account.")
    return who
  }

  /** The code the sign-in page showed, for the CLI that asked for it. */
  sendCode(provider: Provider, code: string) {
    const send = this.adding.get(provider)?.code
    if (!send) throw new Error('No sign-in is waiting for a code.')
    send(code)
  }

  /**
   * ChatGPT sign-in for a Codex home: Codex starts the login, Kernel opens the page in the browser, and Codex finishes it on
   * its own local callback. Resolves with who signed in.
   */
  private async codexSignIn(home: string | undefined): Promise<{ email?: string; plan?: string }> {
    let finish: (n: AccountLoginCompletedNotification) => void = () => undefined
    const completed = new Promise<AccountLoginCompletedNotification>((resolve) => { finish = resolve })
    let rpc: Rpc | undefined
    let loginId: string | undefined
    let cancel!: () => void
    const canceled = new Promise<never>((_, reject) => { cancel = () => { if (rpc && loginId) void rpc.request('account/login/cancel', { loginId }).catch(() => undefined); reject(new Error('Sign-in canceled.')) } })
    canceled.catch(() => undefined)
    this.adding.set('codex', { cancel })
    try {
      return await withCodex(this.mustBinary('codex'), home, async (r) => {
        rpc = r
        const start = await r.request<LoginAccountResponse>('account/login/start', { type: 'chatgpt' })
        if (start.type !== 'chatgpt') throw new Error('Codex did not start a ChatGPT sign-in.')
        loginId = start.loginId
        this.step({ provider: 'codex', step: 'browser', url: start.authUrl })
        await this.o.openExternal?.(start.authUrl)
        const done = await Promise.race([completed, canceled])
        if (!done.success) throw new Error(done.error ?? 'Sign-in did not finish.')
        const { account } = await r.request<{ account: { type: string; email?: string | null; planType?: string } | null }>('account/read', { refreshToken: false })
        if (account?.type !== 'chatgpt') throw new Error('Codex is not signed in with ChatGPT.')
        return { email: account.email ?? undefined, plan: codexPlan(account.planType) }
      }, { timeoutMs: SIGN_IN_MS, handlers: { notify: (m, p) => { if (m === 'account/login/completed' && (!loginId || p?.loginId === loginId)) finish(p) } } })
    } finally {
      this.adding.delete('codex')
    }
  }

  /** Closes the Add account sheet: the sign-in stops and nothing is added. */
  cancelAdd(provider: Provider) {
    // Sign in to all stops before the sign-in it is running, so it doesn't go on to the next server (KERNEL-626).
    this.k.mcp.cancelSignInAll(provider)
    this.adding.get(provider)?.cancel()
  }

  /**
   * Use: the provider runs on this account from its next turn. With `accounts.keepChatsOnAccount` on, `move` says which
   * chats: `keep`, the default, sends only new chats here and each chat stays on the account that holds its cache while that
   * account can take it (`Placement.accountFor`), and `all` sends every chat (KERNEL-843). A running turn finishes on the
   * account it started on, and idle processes of chats whose account changed end now (`restartProvider`). A limit on the account switched to holds its chats; one on the old account
   * no longer does. `reason` says who switched (KERNEL-568), and a switch to another account pushes `accountSwitched` (KERNEL-694). From the limit banner or by Kernel at a limit, the account it
   * left had hit a window: the chats' next turns say so, and its reset sends a notification. `from` is the account it
   * left, the one in use by default. Agents that start on a model the account doesn't offer are named in the Inbox and on
   * its row (`warnMissing`, KERNEL-616).
   */
  async switchTo(provider: Provider, accountId: string, o: { reason?: SwitchReason; from?: string; move?: SwitchMove } = {}): Promise<AccountProfile[]> {
    const file = this.load()
    const next = accountId === CLI_ACCOUNT ? undefined : file[provider].accounts.find((a) => a.id === accountId)?.id
    if (accountId !== CLI_ACCOUNT && !next) throw new Error('That account is no longer in Kernel.')
    const from = o.from ?? file[provider].active ?? CLI_ACCOUNT
    const to = next ?? CLI_ACCOUNT
    const limits = this.store.meta<RateLimit[]>('limits') ?? []
    const hit = o.reason === 'banner' || o.reason === 'limit' ? blockingLimit(limits.filter((l) => limitProvider(l) === provider && (l.accountId ?? CLI_ACCOUNT) === from)) : undefined
    if (provider === 'codex' && next) await this.linkCodexHome(this.codexHome(next)!)
    file[provider].active = next
    await this.save()
    const keep = this.k.placement.keeps()
    if (keep && o.move === 'all') this.k.placement.placeAll(provider, to)
    if (to !== from) this.switches.set(provider, { to, from, ...(hit ? { limit: hit.type } : {}) })
    this.k.account.switched(provider, next, hit, o.reason)
    // Chats held for the old account's Keychain prompt run on the new one (KERNEL-618).
    if (provider === 'claude') this.k.account.keychainDone()
    if (provider === 'codex') this.codexModels = undefined
    this.k.team.forgetOffers(provider)
    this.sessions.restartProvider(provider, keep ? { moved: true } : {})
    this.k.account.applyLimits(this.store.meta<RateLimit[]>('limits') ?? [])
    // The account menu shows the new account, and the plan defaults follow its plan (KERNEL-225).
    if (provider === 'claude') await this.k.account.accountChanged()
    this.sessions.drainWaiting()
    await this.warnMissing(provider, to)
    const accounts = await this.list()
    if (!this.stopped) {
      bus.push({ type: 'accounts', accounts })
      // Who switched and why, for the renderer's notice with Undo (KERNEL-694).
      if (to !== from) bus.push({ type: 'accountSwitched', provider, from, to, reason: o.reason ?? 'user', ...(hit ? { limit: hit.type } : {}) })
    }
    return accounts
  }

  /** What an account is called, by its id in `accounts.*`: its nickname or email, or the CLI login's, undefined or `cli` (KERNEL-568). */
  label(provider: Provider, accountId?: string): string {
    const file = this.load()[provider]
    if (!accountId || accountId === CLI_ACCOUNT) return file.cli?.label ?? file.cli?.email ?? OWN_LOGIN[provider]
    return this.stored(provider, accountId)?.label ?? 'another account'
  }

  /** A Claude login's claude.ai organization, `cli` for the CLI's own, as Kernel last read it (KERNEL-616, KERNEL-618). */
  private orgOf(id: string): string | undefined {
    const file = this.load().claude
    return id === CLI_ACCOUNT ? file.cli?.orgId : file.accounts.find((a) => a.id === id)?.orgId
  }

  /**
   * The provider's other accounts signed in to the same claude.ai organization as `id`, which can share its limits, or
   * undefined (KERNEL-618). Codex says no workspace, so it has none.
   */
  private sameOrg(provider: Provider, id: string): string[] | undefined {
    const org = provider === 'claude' ? this.orgOf(id) : undefined
    if (!org) return undefined
    const peers = [CLI_ACCOUNT, ...this.load().claude.accounts.map((a) => a.id)].filter((x) => x !== id && this.orgOf(x) === org)
    return peers.length ? peers : undefined
  }

  /**
   * The account Kernel moves `provider` to when the one in use hits its limit (KERNEL-568): a signed-in subscription account
   * with no rejected 5-hour or weekly window in `limits`, the lowest 5-hour use first and an account never read last. Never
   * an API key account, which bills per token, and never the one in use. Sign-ins are as Kernel last read them. One in the
   * same organization counts only by its own windows, and one waiting on a Keychain prompt not at all (`switchChoices`,
   * KERNEL-618).
   */
  spareAccount(provider: Provider, limits: RateLimit[], now = Date.now()): string | undefined { return this.spares(provider, limits, now)[0] }

  /**
   * The account a switch at a limit moves `provider` to (KERNEL-616): `spareAccount`'s pick, unless it doesn't offer a model
   * agents on the provider start on and another account with room does. Each account's models are read once per login. An
   * account Kernel can't read counts as offering them. When none with room offers them all, the pick stands.
   */
  async spareFor(provider: Provider, limits: RateLimit[], now = Date.now()): Promise<string | undefined> {
    const ids = this.spares(provider, limits, now)
    const need = [...this.pinned(provider).keys()].map(bareModel)
    if (ids.length < 2 || !need.length) return ids[0]
    for (const id of ids) {
      const offered = await this.offeredOn(provider, id)
      if (!offered || need.every((m) => offered.includes(m))) return id
    }
    return ids[0]
  }

  /**
   * Every account `spareAccount` could pick, best first. One that is the login in use (`sameLogin`) never is, since it
   * shares that login's limits whatever its own windows say (KERNEL-701).
   */
  private spares(provider: Provider, limits: RateLimit[], now: number): string[] {
    const file = this.load()[provider]
    const active = file.active ?? CLI_ACCOUNT
    const inUse = file.active ? this.stored(provider, file.active) : file.cli
    const accounts = [{ id: CLI_ACCOUNT, signedIn: file.cli?.signedIn !== false, login: file.cli }, ...file.accounts.filter((a) => a.auth !== 'apiKey').map((a) => ({ id: a.id, signedIn: this.storedSignedIn(provider, a), login: a }))]
      .filter((a) => a.id === active || !sameLogin(inUse, a.login))
      .map(({ login: _, ...a }) => ({ ...a, provider, active: a.id === active, auth: 'subscription' as const, sameOrg: this.sameOrg(provider, a.id), keychainWait: this.keychain.has(a.id) }))
    return switchChoices(provider, accounts, limits, now).room.map((a) => a.id)
  }

  /**
   * Why the provider is on `accountId`, for the note a chat gets after it moved there (KERNEL-568, KERNEL-842): "Work hit its
   * 5-hour limit" when the provider's last switch, to this account, left Work at its limit. Undefined otherwise.
   */
  switchReason(provider: Provider, accountId: string): string | undefined {
    const s = this.switches.get(provider)
    return s?.to === accountId && s.limit ? `${this.label(provider, s.from)} hit its ${LIMIT_NAME[s.limit]}` : undefined
  }

  /** An account's email as Kernel last read it, by its id in `accounts.*`, undefined or `cli` for the CLI's own login (KERNEL-842). */
  emailOf(provider: Provider, accountId?: string): string | undefined {
    const file = this.load()[provider]
    return !accountId || accountId === CLI_ACCOUNT ? file.cli?.email : this.stored(provider, accountId)?.email
  }

  /**
   * Sign out: the CLI login signs the CLI out. An added login signs out of its own folder or home only, so the CLI's own
   * login stays signed in (KERNEL-567). A token or key account forgets its credential. Each stays listed, signed out.
   */
  async signOut(provider: Provider, accountId: string): Promise<AccountProfile[]> {
    const a = accountId === CLI_ACCOUNT ? undefined : this.stored(provider, accountId)
    if (accountId !== CLI_ACCOUNT && !a) throw new Error('That account is no longer in Kernel.')
    if (a?.auth === 'apiKey') await this.saveKey(a.id, undefined)
    else if (provider === 'claude') {
      const bin = this.mustBinary(provider)
      if (!a) await claudeSignOut(bin)
      else if (a.home) await logoutClaude(bin, a.home)
      else await this.saveToken(a.id, undefined)
    } else await withCodex(this.mustBinary(provider), a ? this.codexHome(a.id) : undefined, (rpc) => rpc.request('account/logout'))
    // The user signed it out, so no notice says so.
    if (a?.auth !== 'apiKey' && (provider === 'codex' || !a || a.home)) await this.noteLogin(provider, a?.id, { signedIn: false }, { quiet: true, push: false })
    const accounts = await this.list()
    if (!this.stopped) bus.push({ type: 'accounts', accounts })
    return accounts
  }

  /**
   * Removes an added account and its credential. The provider moves back to the CLI login when it was the active one. A
   * Claude login signs out of its folder first, and of the path it signed in with when the data folder moved since, so no
   * Keychain item is left behind. Its folder then goes without following a link into `~/.claude` (KERNEL-560).
   */
  async remove(provider: Provider, accountId: string): Promise<AccountProfile[]> {
    if (accountId === CLI_ACCOUNT) throw new Error("The CLI's own login can't be removed. Sign out of it instead.")
    const file = this.load()
    const a = this.stored(provider, accountId)
    if (!a) throw new Error('That account is no longer in Kernel.')
    const key = a.auth === 'apiKey'
    if (file[provider].active === accountId) await this.switchTo(provider, CLI_ACCOUNT)
    file[provider].accounts = file[provider].accounts.filter((x) => x.id !== accountId)
    await this.save()
    // Chats it held move to the account in use, and their idle processes end before its folder goes (KERNEL-843).
    this.sessions.restartProvider(provider, { account: accountId })
    await Promise.allSettled([...(this.reading.get(accountId) ?? [])])
    if (key) await this.saveKey(accountId, undefined)
    else if (provider === 'claude') await this.saveToken(accountId, undefined)
    if (provider === 'claude' && a.home) {
      const bin = this.binary('claude').path
      const home = this.claudeHome(accountId)
      if (bin) for (const at of new Set([a.home, home])) await logoutClaude(bin, at).catch(() => undefined)
      await removeClaudeHome(home)
    }
    if (provider === 'codex') await removeTree(this.codexHome(accountId)!)
    this.mcpSignIns.delete(accountId)
    this.offered.delete(`${provider}:${accountId}`)
    const accounts = await this.list()
    if (!this.stopped) bus.push({ type: 'accounts', accounts })
    return accounts
  }

  /**
   * Rename: any account's nickname, the CLI's own login's included, kept in `accounts.json` (KERNEL-567). An empty one goes
   * back to the account's email, or keeps the name it has when there is no email to go back to.
   */
  async rename(provider: Provider, accountId: string, label: string): Promise<AccountProfile[]> {
    const name = label.trim()
    const file = this.load()
    if (accountId === CLI_ACCOUNT) {
      const cli = (file[provider].cli ??= {})
      if (name) cli.label = name
      else delete cli.label
    } else {
      const a = this.stored(provider, accountId)
      if (!a) throw new Error('That account is no longer in Kernel.')
      a.label = name || a.email || a.label
    }
    await this.save()
    // The account menu names an added Claude account in use by its nickname.
    if (provider === 'claude' && accountId !== CLI_ACCOUNT && this.active('claude') === accountId) await this.k.account.accountChanged()
    const accounts = await this.list()
    if (!this.stopped) bus.push({ type: 'accounts', accounts })
    return accounts
  }

  /**
   * Run login, or Sign in again on an account's row: the provider's own sign-in for `accountId`, the active account by
   * default. An added Claude account logs in fully in its folder, and a legacy token account moves to one that way
   * (KERNEL-567). An API key account signs in again with a new key instead. Sign in again onto a login another added
   * account has is refused (`refuseTwin`). Run login onto one is not: the CLI's own login folds into its row (KERNEL-701).
   */
  async signIn(provider: Provider, accountId?: string): Promise<ProviderStatus> {
    const id = accountId === undefined ? this.active(provider) : accountId === CLI_ACCOUNT ? undefined : accountId
    if (id && !this.stored(provider, id)) throw new Error('That account is no longer in Kernel.')
    if (id && this.auth(provider, id) === 'apiKey') throw new Error('This account runs on an API key. Add a new key to sign it in again.')
    if (this.adding.has(provider)) throw new Error('A sign-in is already open. Finish or cancel it first.')
    if (provider === 'codex') {
      const home = id ? this.codexHome(id) : undefined
      if (home) await this.linkCodexHome(home)
      const who = await this.codexSignIn(home)
      if (id && await this.alreadyIn('codex', who, { except: id, cli: false })) {
        await this.refuseTwin('codex', id, () => withCodex(this.mustBinary('codex'), home, (rpc) => rpc.request('account/logout')))
      }
      await this.noteLogin('codex', id, { signedIn: true, ...who }, { push: false })
      this.step({ provider, step: 'done' })
    } else if (id) await this.signInClaude(id)
    else await exec(this.mustBinary('claude'), ['auth', 'login'], { timeoutMs: 5 * 60_000 })
    void this.pushAccounts()
    return this.status(provider)
  }

  /**
   * Sign in again for an added Claude account: a full login in its folder (KERNEL-567). A legacy token account moves over
   * this way and keeps its id and nickname, and then its token goes. A folder that moved with the data folder signs in at
   * the new path, and the old path's Keychain item goes (KERNEL-560).
   */
  private async signInClaude(id: string) {
    const home = this.claudeHome(id)
    let who: ClaudeLogin
    try { who = await this.claudeLogin(home) } catch (e) {
      this.step({ provider: 'claude', step: 'failed', error: (e as Error).message })
      throw e
    }
    const a = this.stored('claude', id)
    if (!a) throw new Error('That account is no longer in Kernel.')
    if (await this.alreadyIn('claude', who, { except: id, cli: false })) {
      await this.refuseTwin('claude', id, async () => {
        const bin = this.binary('claude').path
        if (bin) await logoutClaude(bin, home)
        // A legacy token account had no folder before this sign-in, so the new one goes and its token stays.
        if (!a.home) await removeClaudeHome(home)
      })
    }
    const old = a.home
    a.home = home
    await this.noteLogin('claude', id, who, { push: false })
    await this.save()
    await this.saveToken(id, undefined)
    const bin = this.binary('claude').path
    if (bin && old && old !== home) void logoutClaude(bin, old).catch(() => undefined)
    this.step({ provider: 'claude', step: 'done' })
    // Idle processes on the old token end, so the next turn runs on the login, chats kept on the account included (KERNEL-843).
    this.sessions.restartProvider('claude', { account: id })
    if (this.active('claude') === id) await this.k.account.accountChanged()
  }

  /**
   * Sign in again on account `id` signed in to a login another added account has (KERNEL-701). The new sign-in signs out of
   * the account's folder or home (`signOut`), as Add account's does, so the row keeps its email and reads as signed out,
   * with no notice since the user did it. The sign-in is refused.
   */
  private async refuseTwin(provider: Provider, id: string, signOut: () => Promise<unknown>): Promise<never> {
    await signOut().catch(() => undefined)
    const a = this.stored(provider, id)
    if (a && (provider === 'codex' || a.home)) await this.noteLogin(provider, id, { signedIn: false }, { quiet: true, push: false })
    this.step({ provider, step: 'failed', error: ALREADY_IN })
    void this.pushAccounts()
    throw new Error(ALREADY_IN)
  }

  // ---------- MCP sign-ins (KERNEL-616)

  /**
   * Shares the user-added MCP servers' sign-ins among every Claude login (`shareMcpSignIns`): the CLI's own, and each added
   * login whose folder still matches the path it signed in with. At most once every SHARE_EVERY_MS unless `force`. A server
   * a login got leaves that account's `mcpSignIns`. Without a Keychain (tests that don't pass one) nothing is shared.
   */
  private shareMcp(o: { force?: boolean } = {}) {
    const keychain = this.o.keychain
    if (!keychain || this.stopped || (!o.force && Date.now() - this.sharedAt < SHARE_EVERY_MS)) return
    this.sharedAt = Date.now()
    const logins: { id: string; item: string; dir: string; store?: string }[] = [{ id: CLI_ACCOUNT, item: credentialsItem(process.env), dir: this.claudeRoot(), store: credentialsDir(process.env, this.home) }]
    // A login waiting on a Keychain prompt would hold the main process up to its read's timeout (KERNEL-618).
    for (const a of this.load().claude.accounts) if (a.home && !this.moved(a) && !this.keychain.has(a.id)) logins.push({ id: a.id, item: credentialsItem(accountEnv(a.home)), dir: a.home })
    let got: Map<string, string[]>
    try { got = shareMcpSignIns(keychain, logins) } catch { return }
    let changed = false
    for (const l of logins) {
      const servers = got.get(l.dir) ?? []
      const list = this.mcpSignIns.get(l.id)
      if (!list?.some((s) => servers.includes(s.server))) continue
      this.mcpSignIns.set(l.id, list.filter((s) => !servers.includes(s.server)))
      changed = true
    }
    if (changed) void this.pushAccounts()
  }

  /**
   * The folder of a Claude login whose MCP servers Kernel checks and signs in: undefined for the CLI's own, an added login's
   * folder otherwise. A key account has no login of its own, so its processes use the CLI's sign-ins.
   */
  private mcpHome(accountId: string): string | undefined {
    if (accountId === CLI_ACCOUNT) return undefined
    const a = this.stored('claude', accountId)
    if (!a) throw new Error('That account is no longer in Kernel.')
    if (a.auth === 'apiKey') throw new Error("This account's MCP servers use Claude Code's own login. Check them there.")
    if (!a.home || this.moved(a)) throw new Error('Sign this account in again first.')
    return a.home
  }

  /** A Claude process's environment on a login, as its sessions get it, for the MCP check and sign-in. */
  private mcpEnv(accountId: string, home: string | undefined): Record<string, string> {
    return sessionEnv(process.env, this.claudeEnv(home ? accountId : CLI_ACCOUNT))
  }

  /**
   * Which MCP servers need a sign-in on a Claude login (`accounts.checkMcp`). The sign-ins are shared first, then Claude Code
   * starts on the login in the home folder, lists its servers and stops, sending no message. What is left is a claude.ai
   * connector, or a server no login has signed in to.
   */
  async checkMcp(accountId: string): Promise<AccountProfile[]> {
    await this.mcpServersOn('claude', accountId)
    return this.pushList()
  }

  /**
   * Every MCP server on an account with its state there, `cli` for the CLI's own login (`mcp.accounts`, KERNEL-626). Claude
   * checks as `checkMcp` does, and the servers needing a sign-in land on the account's `mcpSignIns` too. Codex lists the
   * servers in the account's home, which shares `config.toml` and the sign-ins with every Codex account (KERNEL-626.md).
   */
  async mcpServersOn(provider: Provider, accountId: string): Promise<McpAccountServer[]> {
    if (provider === 'claude') {
      const home = this.mcpHome(accountId)
      this.shareMcp({ force: true })
      const list = await probeClaudeMcp(this.home, { env: this.mcpEnv(accountId, home), executable: claudeExecutable(this.settings.providers?.claude) })
      this.mcpSignIns.set(accountId, list.filter((s) => s.status === 'needs-auth').map((s) => ({ server: s.name, connector: isConnector(s.name) || (s.source ?? s.scope) === 'claudeai' })))
      return claudeAccountServers(list)
    }
    const home = this.codexMcpHome(accountId)
    const off = (await codexServers(home ?? this.codexRoot())).filter((s) => !s.on).map((s) => s.name)
    const { servers, startup } = await readCodexMcp(this.mustBinary('codex'), home, { cwd: this.home })
    return codexAccountServers(servers, off, startup)
  }

  /** A Codex account's home for its MCP servers: undefined for the CLI's own, which is `~/.codex`. */
  private codexMcpHome(accountId: string): string | undefined {
    const id = accountId === CLI_ACCOUNT ? undefined : accountId
    if (id && !this.stored('codex', id)) throw new Error('That account is no longer in Kernel.')
    return id ? this.codexHome(id) : undefined
  }

  /** The MCP servers that need a sign-in on a Claude login as Kernel knows now, after any sign-in since its check (KERNEL-626). */
  mcpSignInsOn(accountId: string): McpSignIn[] | undefined { return this.mcpSignIns.get(accountId) }

  /**
   * A Claude login's `mcpSignIns` for its row, without the servers that don't warn (KERNEL-646): ones ignored on it, and ones
   * switched off in every room (`Mcp.roomOff`).
   */
  private loudSignIns(accountId: string): McpSignIn[] | undefined {
    const list = this.mcpSignIns.get(accountId)
    if (!list) return undefined
    const ignored = new Set(this.mcpIgnored('claude', accountId))
    const roomOff = this.k.mcp.roomOff()
    return list.filter((s) => !ignored.has(s.server) && !roomOff(s.server))
  }

  /** The MCP servers ignored on an account, `cli` for the CLI's own login (`accounts.mcpIgnore`, KERNEL-646). */
  mcpIgnored(provider: Provider, accountId: string): string[] {
    const file = this.load()[provider]
    return (accountId === CLI_ACCOUNT ? file.cli?.mcpIgnored : this.stored(provider, accountId)?.mcpIgnored) ?? []
  }

  /** Ignores one MCP server on an account, or stops, in `accounts.json` (KERNEL-646). The rows are told, since their warning can change. */
  async setMcpIgnored(provider: Provider, accountId: string, server: string, ignored: boolean) {
    const name = server.trim()
    if (!name) throw new Error('Name the MCP server to ignore.')
    await this.writeMcpIgnored(provider, accountId, (list) => {
      const rest = list.filter((s) => s !== name)
      return ignored ? [...rest, name] : rest
    })
  }

  /** Ignores several MCP servers on an account in one write to `accounts.json`, for Set up this account (KERNEL-660). */
  async ignoreMcp(provider: Provider, accountId: string, servers: string[]) {
    const names = servers.map((s) => s.trim()).filter(Boolean)
    await this.writeMcpIgnored(provider, accountId, (list) => [...new Set([...list, ...names])])
  }

  private async writeMcpIgnored(provider: Provider, accountId: string, change: (list: string[]) => string[]) {
    const file = this.load()
    const at = accountId === CLI_ACCOUNT ? (file[provider].cli ??= {}) : this.stored(provider, accountId)
    if (!at) throw new Error('That account is no longer in Kernel.')
    const next = change(at.mcpIgnored ?? []).sort()
    if (next.length) at.mcpIgnored = next
    else delete at.mcpIgnored
    await this.save()
    void this.pushAccounts()
  }

  /**
   * Signs one MCP server in on an account (`accounts.mcpSignIn`), one sign-in at a time per provider like Add account. On
   * Claude: `claude mcp login` in its folder, which opens the browser. A user-added server's new sign-in is shared with every
   * login at once. A claude.ai connector finishes on claude.ai and loads from the account's next session, so it stays listed
   * until the next check. On Codex: `mcpCodexSignIn`. Either way the account is checked again after (`Mcp.signedIn`, KERNEL-660).
   */
  async mcpSignIn(provider: Provider, accountId: string, server: string): Promise<AccountProfile[]> {
    const name = server.trim()
    if (!name) throw new Error('Name the MCP server to sign in to.')
    if (provider === 'codex') return this.mcpCodexSignIn(accountId, name)
    const home = this.mcpHome(accountId)
    if (this.adding.has('claude')) throw new Error('A sign-in is already open. Finish or cancel it first.')
    const bin = this.mustBinary('claude')
    const connector = isConnector(name)
    const step = (s: Pick<McpSignInStep, 'step' | 'url' | 'error'>) => { if (!this.stopped) bus.push({ type: 'account.mcpSignIn', signIn: { accountId, server: name, ...(connector ? { connector } : {}), ...s } }) }
    const run = loginMcp(bin, name, { env: this.mcpEnv(accountId, home), cwd: this.home, timeoutMs: SIGN_IN_MS, onLink: (url) => step({ step: 'browser', url }) })
    this.adding.set('claude', { cancel: run.cancel })
    try { await run.done } catch (e) {
      step({ step: 'failed', error: (e as Error).message })
      throw e
    } finally { this.adding.delete('claude') }
    step({ step: 'done' })
    if (!connector) {
      const list = this.mcpSignIns.get(accountId)
      if (list) this.mcpSignIns.set(accountId, list.filter((s) => s.server !== name))
      this.shareMcp({ force: true })
    }
    this.k.mcp.signedIn('claude', accountId, name)
    return this.pushList()
  }

  /**
   * Signs one MCP server in on a Codex account through Codex's own MCP OAuth in its home (`loginCodexMcp`, KERNEL-646). Kernel
   * opens the page Codex gives. Codex keeps the token where every Codex account reads it (KERNEL-646.md), so the server is
   * ready on each of them, which `Mcp.signedIn` records until their next check, and checks this account again (KERNEL-660).
   */
  private async mcpCodexSignIn(accountId: string, name: string): Promise<AccountProfile[]> {
    const home = this.codexMcpHome(accountId)
    if (this.adding.has('codex')) throw new Error('A sign-in is already open. Finish or cancel it first.')
    const step = (s: Pick<McpSignInStep, 'step' | 'url' | 'error'>) => { if (!this.stopped) bus.push({ type: 'account.mcpSignIn', signIn: { provider: 'codex', accountId, server: name, ...s } }) }
    const run = loginCodexMcp(this.mustBinary('codex'), home, name, { timeoutMs: SIGN_IN_MS, onLink: (url) => { step({ step: 'browser', url }); void this.o.openExternal?.(url) } })
    this.adding.set('codex', { cancel: run.cancel })
    try { await run.done } catch (e) {
      step({ step: 'failed', error: (e as Error).message })
      throw e
    } finally { this.adding.delete('codex') }
    step({ step: 'done' })
    this.k.mcp.signedIn('codex', accountId, name)
    return this.pushList()
  }

  // ---------- Keychain prompts (KERNEL-618)

  /**
   * Whether the Claude account in use waits on a Keychain prompt (`keychainCheck`), for a session Claude Code refused as
   * signed out. Undefined at once when it can't: only an added login can, and only on a Kernel given a Keychain to read.
   */
  keychainWaiting(): Promise<'prompt' | 'later' | undefined> | undefined {
    const id = this.active('claude')
    const a = id ? this.stored('claude', id) : undefined
    return a?.home && !this.moved(a) && this.o.keychain?.access ? this.keychainCheck(a) : undefined
  }

  /**
   * Whether an added login's Keychain item waits on a macOS prompt, which Claude Code reads as signed out (KERNEL-618). Kernel
   * reads the item itself, through `/usr/bin/security` as the CLI does. A read that hasn't finished within `keychainMs.wait`
   * waits on a prompt, and Kernel keeps it up to `keychainMs.prompt` for someone to allow it. Resolves `prompt` while it is
   * up, `later` for `keychainMs.retry` after one nobody allowed, when no new prompt shows, and undefined when the item
   * reads, or there is none. The first wait saves one Inbox notice a day. One check runs per login at a time.
   */
  private keychainCheck(a: StoredAccount): Promise<'prompt' | 'later' | undefined> {
    const running = this.checking.get(a.id)
    if (running) return running
    const check = this.checkKeychain(a).finally(() => this.checking.delete(a.id))
    this.checking.set(a.id, check)
    return check
  }

  private async checkKeychain(a: StoredAccount): Promise<'prompt' | 'later' | undefined> {
    const keychain = this.o.keychain
    if (!keychain?.access || !a.home || this.moved(a) || this.stopped) return undefined
    const had = this.keychain.get(a.id)
    if (had?.prompt) return 'prompt'
    if (had?.endedAt && Date.now() - had.endedAt < this.keychainMs.retry) return 'later'
    const read = keychain.access(credentialsItem(accountEnv(a.home)), this.keychainMs.prompt).catch(() => 'denied' as const)
    let timer: NodeJS.Timeout | undefined
    const first = await Promise.race([read, new Promise<'waiting'>((resolve) => { timer = setTimeout(() => resolve('waiting'), this.keychainMs.wait) })])
    clearTimeout(timer)
    if (this.stopped) return undefined
    if (first !== 'waiting') { this.keychainRead(a.id); return undefined }
    const wait = { prompt: read.then((r) => r === 'ok') }
    this.keychain.set(a.id, wait)
    void wait.prompt.then((allowed) => this.keychainDone(a.id, wait, allowed))
    const name = a.label
    const title = `${name} is waiting for Keychain access`
    const day = new Date().toISOString().slice(0, 10)
    this.notifications.notice({
      id: `n-keychain-claude-${a.id}-${day}`, title, heading: title, sub: 'Allow it in the macOS prompt to use this account.',
      body: `macOS is asking whether Claude Code can read ${name}'s login from your Keychain. Click Always Allow in that prompt to use ${name} again. Kernel keeps ${name} signed in meanwhile.`
    })
    void this.pushAccounts()
    return 'prompt'
  }

  /** A login's Keychain item read, so it no longer waits on a prompt. One whose prompt is still up waits for it to end. */
  private keychainRead(id: string) {
    if (this.keychain.get(id)?.prompt || !this.keychain.delete(id)) return
    void this.pushAccounts()
  }

  /**
   * The read that kept a login's prompt up ended: someone allowed it, or nobody did in time. Allowed, the login is read again.
   * Either way Claude's chats stop waiting on it (`Account.keychainDone`), so none waits on a prompt forever.
   */
  private keychainDone(id: string, wait: { prompt?: Promise<boolean> }, allowed: boolean) {
    if (this.keychain.get(id) !== wait || this.stopped) return
    if (allowed) this.keychain.delete(id)
    else this.keychain.set(id, { endedAt: Date.now() })
    void (async () => {
      const a = this.stored('claude', id)
      if (allowed && a) await this.readClaudeLogin(a).catch(() => undefined)
      if (this.stopped) return
      this.k.account.keychainDone(allowed && id === this.active('claude'))
      void this.pushAccounts()
    })()
  }

  // ---------- models an account offers (KERNEL-616)

  /**
   * Reads the models an account offers, `cli` for the CLI's own login: Claude Code's initialize answer on it, which sends
   * no message, or Codex's `model/list` in its home. Ids are kept bare. A Claude row counts by its own id, the model id it
   * resolves to and the model its alias names. Tests swap it, so none starts a CLI.
   */
  readModels = async (provider: Provider, accountId: string): Promise<string[]> => {
    if (provider === 'claude') {
      const rows = await claudeModels(this.home, { env: this.claudeEnv(accountId), bin: claudeExecutable(this.settings.providers?.claude) })
      return rows.flatMap((m) => [m.value, m.resolvedModel, MODELS.find((x) => x.id.split('-')[1] === bareModel(m.value))?.id]).filter((id): id is string => !!id).map(bareModel)
    }
    const id = accountId === CLI_ACCOUNT ? undefined : accountId
    return (await readCodexModels(this.mustBinary('codex'), id ? this.codexHome(id) : undefined, id ? this.apiKey('codex', id) : undefined)).map((m) => bareModel(m.id))
  }

  /** What an account's models follow: its email and plan. Undefined while it reads signed out. */
  private loginKey(provider: Provider, accountId: string): string | undefined {
    const file = this.load()[provider]
    if (accountId === CLI_ACCOUNT) return file.cli?.signedIn === false ? undefined : `${file.cli?.email ?? ''}`
    const a = this.stored(provider, accountId)
    return !a || a.signedIn === false ? undefined : `${a.email ?? ''}|${a.plan ?? ''}|${a.auth ?? ''}`
  }

  /**
   * The models an account offers, read once per login (`loginKey`), so a new plan reads them again. Undefined when Kernel
   * can't tell: the app didn't ask for pin checks (tests), the account reads signed out, or the read failed or found none.
   */
  private async offeredOn(provider: Provider, accountId: string): Promise<string[] | undefined> {
    if (!this.o.checkPins) return undefined
    const login = this.loginKey(provider, accountId)
    if (login === undefined) return undefined
    const had = this.offered.get(`${provider}:${accountId}`)
    if (had?.login === login) return had.ids
    const ids = await this.readModels(provider, accountId).catch(() => [] as string[])
    if (!ids.length || this.stopped) return undefined
    this.offered.set(`${provider}:${accountId}`, { login, ids })
    return ids
  }

  /**
   * The models agents on `provider` start on, by their role's default or their file's pin (`Team.pickFor`, KERNEL-550), each
   * with the names of the agents on it, across the open rooms whose team Kernel has read. Before any is read, the roles'
   * own defaults, named by role.
   */
  private pinned(provider: Provider): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    const add = (model: string, name: string) => out.set(model, (out.get(model) ?? new Set()).add(name))
    let read = false
    for (const r of this.store.rooms()) {
      if (r.archived) continue
      for (const a of this.k.team.agentsSync(r.id)) {
        read = true
        const pick = this.k.team.pickFor(a)
        if (pick.provider === provider && pick.model) add(pick.model, a.name)
      }
    }
    if (!read) for (const [role, pick] of Object.entries(this.settings.models.roles) as [Role, { provider: Provider; model: string }][]) if (pick.provider === provider && pick.model) add(pick.model, ROLE_NAMES[role])
    return out
  }

  /** The models agents on `provider` start on that the account doesn't offer, by what Kernel last read of it, or `offered`. */
  private missing(provider: Provider, accountId: string, offered?: string[]): MissingModel[] | undefined {
    const had = this.offered.get(`${provider}:${accountId}`)
    const ids = offered ?? (had && had.login === this.loginKey(provider, accountId) ? had.ids : undefined)
    if (!ids?.length) return undefined
    const out = [...this.pinned(provider)].filter(([model]) => !ids.includes(bareModel(model)))
      .map(([model, names]) => ({ model, label: MODELS.find((m) => m.id === model)?.label ?? model, agents: [...names].sort() }))
    return out.length ? out : undefined
  }

  /**
   * After a switch: when agents start on a model the account doesn't offer, one Inbox notice a day names the models and the
   * agents, before their next turns fail there. The account's row says the same (`missingModels`).
   */
  private async warnMissing(provider: Provider, accountId: string) {
    const missing = this.missing(provider, accountId, await this.offeredOn(provider, accountId))
    if (!missing || this.stopped) return
    const name = this.label(provider, accountId)
    const models = joinLabels(missing.map((m) => m.label))
    const agents = joinLabels([...new Set(missing.flatMap((m) => m.agents))].sort())
    const title = `${name} doesn't offer ${models}`
    const day = new Date().toISOString().slice(0, 10)
    this.notifications.notice({
      id: `n-models-${provider}-${accountId}-${missing.map((m) => m.model).join('+')}-${day}`, title, heading: title,
      sub: `${agents} can't run on it. Pick another model in Settings, Models.`,
      body: `${name} doesn't offer ${models}, so ${agents} can't run on it. Pick another model for them in Settings, Models, or switch to another account.`
    })
  }

  handlers() {
    return {
      'providers.status': async ({ provider }) => this.status(provider),
      'providers.setPath': async ({ provider, path, useSystem }) => this.setPath(provider, { path, useSystem }),
      'providers.signIn': async ({ provider, accountId }) => this.signIn(provider, accountId),
      'providers.openConfig': async ({ provider }) => { await this.o.openFile?.(this.configFile(provider)); return { ok: true as const } },
      'accounts.list': async () => this.list(),
      'accounts.add': async ({ provider }) => this.add(provider),
      'accounts.addKey': async (req) => this.addKey(req.provider, req),
      'accounts.code': async ({ provider, code }) => { this.sendCode(provider, code); return { ok: true as const } },
      'accounts.cancelAdd': async ({ provider }) => { this.cancelAdd(provider); return { ok: true as const } },
      'accounts.switch': async ({ provider, accountId, reason, move }) => {
        // `move` comes from the renderer: anything but keep, all or none is refused before anything switches.
        if (move !== undefined && !MOVES.includes(move)) throw new Error(`A switch moves chats by keep or all, not ${JSON.stringify(move)}.`)
        return this.switchTo(provider, accountId, { reason, move })
      },
      'accounts.signOut': async ({ provider, accountId }) => this.signOut(provider, accountId),
      'accounts.remove': async ({ provider, accountId }) => this.remove(provider, accountId),
      'accounts.rename': async ({ provider, accountId, label }) => this.rename(provider, accountId, label),
      'accounts.checkMcp': async ({ accountId }) => this.checkMcp(accountId),
      'accounts.mcpSignIn': async ({ provider, accountId, server }) => this.mcpSignIn(provider, accountId, server),
      'models.list': async ({ provider }) => this.models(provider)
    } satisfies Partial<Handlers>
  }
}
