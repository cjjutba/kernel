import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EFFORT_LABELS, EFFORTS, MODELS, PROVIDERS, type AccountAddStep, type AccountAuth, type AccountProfile, type ClaudePlan, type Effort, type Provider, type ProviderBinary, type ProviderModel, type ProviderStatus, type RateLimit, type SwitchReason } from '@shared/types'
import { limitProvider } from '@shared/providers'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { signOut as claudeSignOut, type ReadAccount } from '../services/account'
import { exec } from '../services/exec'
import { blockingLimit } from '../services/health'
import { LIMIT_NAME, type LimitPatch } from '../services/providers/limits'
import type { UsageRead } from '../services/sessions'
import { planOf } from '../services/settings'
import { checkApiKey } from '../services/providers/apiKeys'
import { claudeExecutable, resolveBinary } from '../services/providers/binary'
import { claudeStatus, copyClaudeConfig, linkClaudeHome, loginEnv, logoutClaude, removeClaudeHome, type ClaudeLogin } from '../services/providers/claudeHome'
import { loginClaude } from '../services/providers/claudeToken'
import { probeClaudeUsage, sessionEnv } from '../services/providers/claude'
import { codexPlan, readCodexAccount, readCodexModels, withCodex } from '../services/providers/codex/client'
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
  createdAt: number
}
/** The CLI's own login as `accounts.json` keeps it: its nickname, its last email, and what Kernel last read of its sign-in (KERNEL-567). */
interface StoredCli { label?: string; email?: string; signedIn?: boolean }
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
  /** Usage reads running, by account id, which Remove waits for so none writes to a folder it deleted. */
  private reading = new Map<string, Set<Promise<void>>>()
  /**
   * Each provider's last switch, by account id, for the note a chat gets when its next turn starts on the new account
   * (KERNEL-568). `limit` is the window the account it left had hit, when the banner or Kernel moved it off a limit.
   */
  private switches = new Map<Provider, { to: string; from: string; limit?: RateLimit['type'] }>()

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
   * Before each Claude process on an added login: what `~/.claude` gained since is linked in, and the shared `.claude.json`
   * keys are copied (KERNEL-560). A failure leaves the folder as it was, and the login still runs.
   */
  private readyClaudeHome(home: string) {
    try { linkClaudeHome(home, this.claudeRoot()) } catch { /* ~/.claude can't be read: the account runs on what it has */ }
    try { copyClaudeConfig(home, this.claudeConfig()) } catch { /* the same */ }
  }

  /**
   * What a Claude process adds to its environment for an account, the active one by default: an added login's folder as
   * CLAUDE_CONFIG_DIR, readied first (KERNEL-567), a legacy token, or an API key account's key (KERNEL-523). Nothing for
   * the CLI login. A folder that moved is passed as it signed in, so its sessions fail as signed out rather than run on
   * another login.
   */
  claudeEnv(accountId = this.active('claude')): Record<string, string> {
    const a = accountId ? this.stored('claude', accountId) : undefined
    if (!a) return {}
    if (a.auth === 'apiKey') {
      const key = this.apiKey('claude', a.id)
      return key ? { ANTHROPIC_API_KEY: key } : {}
    }
    if (a.home) {
      if (!this.moved(a)) this.readyClaudeHome(a.home)
      return { CLAUDE_CONFIG_DIR: a.home }
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
   * (`noteLogin`). A folder that moved reads as signed out. Undefined when Claude Code didn't answer.
   */
  private async readClaudeLogin(a: StoredAccount): Promise<ClaudeLogin | undefined> {
    const bin = this.binary('claude').path
    if (!bin || !a.home) return undefined
    let who: ClaudeLogin | undefined = { signedIn: false }
    if (!this.moved(a)) {
      this.readyClaudeHome(a.home)
      who = await claudeStatus(bin, loginEnv(a.home))
    }
    if (who) await this.noteLogin('claude', a.id, who)
    return who
  }

  /**
   * What a read found about a login, `id` undefined for the CLI's own (KERNEL-567): an added one keeps its email and plan,
   * and a name that was its email follows a new one. Each change is saved and tells every window, and a login going from
   * signed in to signed out saves one Inbox notice, unless the user signed it out (`quiet`).
   */
  private async noteLogin(provider: Provider, id: string | undefined, who: { signedIn: boolean; email?: string; plan?: string; subscriptionType?: string }, o: { quiet?: boolean; push?: boolean } = {}) {
    const file = this.load()
    const a = id ? this.stored(provider, id) : undefined
    if ((id && !a) || this.stopped) return
    const rec: StoredCli | StoredAccount = a ?? (file[provider].cli ??= {})
    const was = rec.signedIn
    let changed = was !== who.signedIn
    rec.signedIn = who.signedIn
    if (who.signedIn && who.email && rec.email !== who.email && !a) { rec.email = who.email; changed = true }
    let planChanged = false
    if (who.signedIn && a) {
      const tier = provider === 'claude' ? planOf(who.subscriptionType) : 'unknown'
      const next = { email: who.email ?? a.email, plan: who.plan ?? a.plan, claudePlan: tier === 'unknown' ? a.claudePlan : tier }
      const label = a.label === a.email && next.email ? next.email : a.label
      planChanged = next.claudePlan !== a.claudePlan
      if (next.email !== a.email || next.plan !== a.plan || planChanged || label !== a.label) { Object.assign(a, next, { label }); changed = true }
    }
    if (!changed) return
    await this.save()
    if (was === true && !who.signedIn && !o.quiet) {
      const name = a?.label ?? file[provider].cli?.label ?? file[provider].cli?.email ?? OWN_LOGIN[provider]
      // One a day at most: a session the server refuses while `auth status` still reads signed in goes round every 10 seconds.
      const day = new Date().toISOString().slice(0, 10)
      this.notifications.notice({ id: `n-signed-out-${provider}-${id ?? CLI_ACCOUNT}-${day}`, title: `${name} is signed out`, sub: 'Sign in again in Settings, Providers.', heading: `${name} is signed out`, body: `${name} is signed out. Sign in again in Settings, Providers.` })
    }
    // The plan defaults follow the plan of the account in use (KERNEL-225).
    if (planChanged && provider === 'claude' && id === this.active('claude')) void this.k.account.accountChanged().catch(() => undefined)
    if (o.push !== false) void this.pushAccounts()
  }

  /**
   * A session on the provider's active added account was refused. An added login reads as signed out until a read of it
   * says otherwise (KERNEL-567). A token or API key stays signed out until a new one replaces it, or the 10-second sign-in
   * check would lift the hold at once.
   */
  credentialRefused(provider: Provider) {
    const id = this.active(provider)
    const a = id ? this.stored(provider, id) : undefined
    if (!a) return
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

  /** Every account of both providers, each provider's CLI login first. */
  async list(): Promise<AccountProfile[]> {
    const file = this.load()
    const out: AccountProfile[] = []
    for (const { id: provider } of PROVIDERS) {
      const bin = this.binary(provider).path
      const cli = bin ? await this.identity(provider, undefined, bin) : { signedIn: false }
      const saved = file[provider].cli
      out.push({ id: CLI_ACCOUNT, provider, label: saved?.label ?? cli.email ?? saved?.email ?? OWN_LOGIN[provider], email: cli.email, plan: cli.plan, cli: true, auth: 'subscription', active: !file[provider].active, signedIn: cli.signedIn })
      for (const a of file[provider].accounts) {
        const key = a.auth === 'apiKey'
        const legacy = provider === 'claude' && !key && !a.home
        const signedIn = key ? this.keySignedIn(a.id) : legacy ? this.tokenSignedIn(a.id)
          : provider === 'claude' ? a.signedIn !== false && !this.moved(a)
            : a.signedIn !== false && existsSync(join(this.codexHome(a.id)!, 'auth.json'))
        out.push({ id: a.id, provider, label: a.label, email: a.email, plan: a.plan, cli: false, auth: key ? 'apiKey' : 'subscription', active: file[provider].active === a.id, signedIn, ...(legacy ? { usageFromTurns: true, legacyToken: true } : {}) })
      }
    }
    return out
  }

  /** Tells every window the accounts changed. */
  async pushAccounts() {
    const accounts = await this.list().catch(() => undefined)
    if (accounts && !this.stopped) bus.push({ type: 'accounts', accounts })
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
   * Settings, Providers opens (`usage.get`), every 10 minutes while agents work, and when the account in use nears or hits
   * a limit (`Account.applyLimits`). An account read in the last minute isn't read again unless `force`, so a read that is
   * already running isn't doubled.
   */
  async readUsage(o: { force?: boolean; provider?: Provider } = {}): Promise<RateLimit[]> {
    if (this.stopped) return []
    const now = Date.now()
    const key = (r: UsageRead) => `${r.provider}:${r.accountId ?? CLI_ACCOUNT}`
    const reads = this.usageReads({ probe: true, check: true, provider: o.provider }).filter((r) => o.force || now - (this.usageReadAt.get(key(r)) ?? 0) >= USAGE_FRESH_MS)
    for (const r of reads) this.usageReadAt.set(key(r), now)
    return this.sessions.usage(reads)
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
   * user turned that on (KERNEL-568).
   */
  async add(provider: Provider): Promise<AccountProfile> {
    if (this.adding.has(provider)) throw new Error('A sign-in is already open. Finish or cancel it first.')
    const id = randomUUID()
    const profile = provider === 'claude' ? await this.addClaude(id) : await this.addCodex(id)
    this.step({ provider, step: 'done', account: profile })
    void this.pushAccounts()
    // Its windows, so its row has them before it runs a turn.
    void this.readUsage({ provider }).catch(() => undefined)
    return profile
  }

  private async addCodex(id: string): Promise<AccountProfile> {
    const home = this.codexHome(id)!
    await this.linkCodexHome(home)
    try {
      const who = await this.codexSignIn(home)
      const stored: StoredAccount = { id, label: who.email || 'ChatGPT account', email: who.email, plan: who.plan, signedIn: true, createdAt: Date.now() }
      this.load().codex.accounts.push(stored)
      await this.save()
      return { id, provider: 'codex', label: stored.label, email: who.email, plan: who.plan, cli: false, auth: 'subscription', active: false, signedIn: true }
    } catch (e) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined)
      this.step({ provider: 'codex', step: 'failed', error: (e as Error).message })
      throw e
    }
  }

  /** A full Claude login in the new account's folder. Never `claude setup-token` (KERNEL-567). */
  private async addClaude(id: string): Promise<AccountProfile> {
    const home = this.claudeHome(id)
    try {
      const who = await this.claudeLogin(home)
      const tier = planOf(who.subscriptionType)
      const stored: StoredAccount = { id, label: who.email ?? 'Claude account', email: who.email, plan: who.plan, ...(tier !== 'unknown' ? { claudePlan: tier } : {}), home, signedIn: true, createdAt: Date.now() }
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
    if (active) {
      // Idle processes on the old key end, and the next sign-in check lifts the hold its refusal put on.
      this.sessions.restartProvider(provider)
      if (provider === 'claude') await this.k.account.accountChanged()
    }
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
      env: sessionEnv(process.env, { CLAUDE_CONFIG_DIR: home }), cwd: this.home, timeoutMs: SIGN_IN_MS,
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
  cancelAdd(provider: Provider) { this.adding.get(provider)?.cancel() }

  /**
   * Use: the provider runs on this account from its next turn. A running turn finishes on the account it started on, and
   * idle processes end now (`restartProvider`). A limit on the account switched to holds its chats; one on the old account
   * no longer does. `reason` says who switched (KERNEL-568). From the limit banner or by Kernel at a limit, the account it
   * left had hit a window: the chats' next turns say so, and its reset sends a notification. `from` is the account it
   * left, the one in use by default.
   */
  async switchTo(provider: Provider, accountId: string, o: { reason?: SwitchReason; from?: string } = {}): Promise<AccountProfile[]> {
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
    if (to !== from) this.switches.set(provider, { to, from, ...(hit ? { limit: hit.type } : {}) })
    this.k.account.switched(provider, next, hit)
    if (provider === 'codex') this.codexModels = undefined
    this.sessions.restartProvider(provider)
    this.k.account.applyLimits(this.store.meta<RateLimit[]>('limits') ?? [])
    // The account menu shows the new account, and the plan defaults follow its plan (KERNEL-225).
    if (provider === 'claude') await this.k.account.accountChanged()
    this.sessions.drainWaiting()
    const accounts = await this.list()
    if (!this.stopped) bus.push({ type: 'accounts', accounts })
    return accounts
  }

  /** What an account is called, by its id in `accounts.*`: its nickname or email, or the CLI login's, undefined or `cli` (KERNEL-568). */
  label(provider: Provider, accountId?: string): string {
    const file = this.load()[provider]
    if (!accountId || accountId === CLI_ACCOUNT) return file.cli?.label ?? file.cli?.email ?? OWN_LOGIN[provider]
    return this.stored(provider, accountId)?.label ?? 'another account'
  }

  /**
   * The account Kernel moves `provider` to when the one in use hits its limit (KERNEL-568): a signed-in subscription account
   * with no rejected 5-hour or weekly window in `limits`, the lowest 5-hour use first and an account never read last. Never
   * an API key account, which bills per token, and never the one in use. Sign-ins are as Kernel last read them.
   */
  spareAccount(provider: Provider, limits: RateLimit[], now = Date.now()): string | undefined {
    const file = this.load()[provider]
    const signedIn = (a: StoredAccount) => a.auth !== 'apiKey' && (provider === 'codex' ? a.signedIn !== false && existsSync(join(this.codexHome(a.id)!, 'auth.json'))
      : a.home ? a.signedIn !== false && !this.moved(a) : this.tokenSignedIn(a.id))
    const ids = [...(file.cli?.signedIn !== false ? [CLI_ACCOUNT] : []), ...file.accounts.filter(signedIn).map((a) => a.id)].filter((id) => id !== (file.active ?? CLI_ACCOUNT))
    const of = (id: string) => limits.filter((l) => limitProvider(l) === provider && (l.accountId ?? CLI_ACCOUNT) === id)
    const used = (id: string) => of(id).find((l) => l.type === 'five_hour')?.utilization ?? Infinity
    return ids.filter((id) => !blockingLimit(of(id), now)).sort((a, b) => used(a) - used(b))[0]
  }

  /**
   * The note a chat gets when its turn starts on another account than its last one (KERNEL-568): "Now on Personal", with
   * "(Work hit its 5-hour limit)" after it when the provider's last switch, to this account, left Work at its limit.
   */
  switchNote(provider: Provider, accountId: string): string {
    const s = this.switches.get(provider)
    const why = s?.to === accountId && s.limit ? ` (${this.label(provider, s.from)} hit its ${LIMIT_NAME[s.limit]})` : ''
    return `Now on ${this.label(provider, accountId)}${why}`
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
    await Promise.allSettled([...(this.reading.get(accountId) ?? [])])
    if (key) await this.saveKey(accountId, undefined)
    else if (provider === 'claude') await this.saveToken(accountId, undefined)
    if (provider === 'claude' && a.home) {
      const bin = this.binary('claude').path
      const home = this.claudeHome(accountId)
      if (bin) for (const at of new Set([a.home, home])) await logoutClaude(bin, at).catch(() => undefined)
      await removeClaudeHome(home)
    }
    if (provider === 'codex') await rm(this.codexHome(accountId)!, { recursive: true, force: true })
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
   * (KERNEL-567). An API key account signs in again with a new key instead.
   */
  async signIn(provider: Provider, accountId?: string): Promise<ProviderStatus> {
    const id = accountId === undefined ? this.active(provider) : accountId === CLI_ACCOUNT ? undefined : accountId
    if (id && !this.stored(provider, id)) throw new Error('That account is no longer in Kernel.')
    if (id && this.auth(provider, id) === 'apiKey') throw new Error('This account runs on an API key. Add a new key to sign it in again.')
    if (this.adding.has(provider)) throw new Error('A sign-in is already open. Finish or cancel it first.')
    if (provider === 'codex') {
      if (id) await this.linkCodexHome(this.codexHome(id)!)
      const who = await this.codexSignIn(id ? this.codexHome(id) : undefined)
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
    const old = a.home
    a.home = home
    await this.noteLogin('claude', id, who, { push: false })
    await this.save()
    await this.saveToken(id, undefined)
    const bin = this.binary('claude').path
    if (bin && old && old !== home) void logoutClaude(bin, old).catch(() => undefined)
    this.step({ provider: 'claude', step: 'done' })
    if (this.active('claude') === id) {
      // Idle processes on the old token end, so the next turn runs on the login.
      this.sessions.restartProvider('claude')
      await this.k.account.accountChanged()
    }
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
      'accounts.switch': async ({ provider, accountId, reason }) => this.switchTo(provider, accountId, { reason }),
      'accounts.signOut': async ({ provider, accountId }) => this.signOut(provider, accountId),
      'accounts.remove': async ({ provider, accountId }) => this.remove(provider, accountId),
      'accounts.rename': async ({ provider, accountId, label }) => this.rename(provider, accountId, label),
      'models.list': async ({ provider }) => this.models(provider)
    } satisfies Partial<Handlers>
  }
}
