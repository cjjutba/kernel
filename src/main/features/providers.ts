import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EFFORT_LABELS, EFFORTS, MODELS, PROVIDERS, type AccountAddStep, type AccountProfile, type Effort, type Provider, type ProviderBinary, type ProviderModel, type ProviderStatus, type RateLimit } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { signOut as claudeSignOut } from '../services/account'
import { exec } from '../services/exec'
import { planName } from '../services/preflight'
import { resolveBinary } from '../services/providers/binary'
import { codexPlan, readCodexAccount, readCodexModels, withCodex } from '../services/providers/codex/client'
import type { Rpc } from '../services/providers/codex/rpc'
import type { AccountLoginCompletedNotification } from '../services/providers/codex/protocol/v2/AccountLoginCompletedNotification'
import type { LoginAccountResponse } from '../services/providers/codex/protocol/v2/LoginAccountResponse'
import type { ThreadForkResponse } from '../services/providers/codex/protocol/v2/ThreadForkResponse'
import { Feature } from './feature'

/** "codex-cli 0.153.4" or "2.1.292 (Claude Code)" to the version alone. */
export const versionOf = (out: string) => /(\d+\.\d+\.\d+)/.exec(out)?.[1]

/** An account Kernel added. Its credential lives apart: Claude's token in `claude-tokens.json`, Codex's `auth.json` in its home. */
interface StoredAccount { id: string; label: string; email?: string; plan?: string; createdAt: number }
/** Each provider's added accounts and the one it runs on. No `active` is the CLI's own login. */
type AccountsFile = Record<Provider, { active?: string; accounts: StoredAccount[] }>

/** The id the CLI's own login goes by in `accounts.*`. */
export const CLI_ACCOUNT = 'cli'

/** How long a sign-in in the browser may take before Kernel gives up on it. */
const SIGN_IN_MS = 15 * 60_000

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
  /** The sign-in Add account or Run login is waiting on, per provider, so Cancel can stop it. */
  private adding = new Map<Provider, { cancel: () => void }>()

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
      return (await readCodexModels(bin, this.codexHome())).map((m) => ({
        provider: 'codex' as const, id: m.id, label: m.displayName, description: m.description, isDefault: m.isDefault,
        efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort).filter(known),
        defaultEffort: known(m.defaultReasoningEffort) ? m.defaultReasoningEffort : 'medium'
      }))
    })().catch((e) => { this.codexModels = undefined; throw e })
    return this.codexModels
  }

  /** Fork chat on Codex: a new thread with the old one's turns, through `lastTurnId` when given. Returns the new thread's id. */
  async forkCodex(threadId: string, cwd: string, lastTurnId?: string): Promise<string> {
    const r = await withCodex(this.mustBinary('codex'), this.codexHome(), (rpc) => rpc.request<ThreadForkResponse>('thread/fork', { threadId, cwd, ...(lastTurnId ? { lastTurnId } : {}) }), { cwd })
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

  /** Who an account is signed in as, read through `bin`. An API key login reads as signed out, since Kernel never bills one (D-018). */
  private async identity(provider: Provider, accountId: string | undefined, bin: string): Promise<Pick<ProviderStatus, 'signedIn' | 'loginMethod' | 'plan' | 'email' | 'error'>> {
    if (provider === 'claude') {
      const env = this.claudeEnv(accountId)
      const a = await exec(bin, ['auth', 'status'], { timeoutMs: 15_000, ...(Object.keys(env).length ? { env: { ...process.env, ...env } } : {}) })
      let s: { loggedIn?: boolean; email?: unknown; subscriptionType?: unknown } = {}
      try { s = JSON.parse(a.stdout) } catch { /* not signed in, or an older CLI */ }
      if (!s.loggedIn) return { signedIn: false }
      return { signedIn: true, loginMethod: 'Claude account', plan: planName(s.subscriptionType), email: typeof s.email === 'string' ? s.email : undefined }
    }
    const { account } = await readCodexAccount(bin, this.codexHome(accountId))
    if (account?.type !== 'chatgpt') return { signedIn: false, ...(account ? { error: 'Codex is signed in with an API key. Kernel runs agents on your ChatGPT plan, so sign in with ChatGPT.' } : {}) }
    return { signedIn: true, loginMethod: 'ChatGPT', plan: codexPlan(account.planType), email: account.email ?? undefined }
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

  private load(): AccountsFile {
    if (this.accounts) return this.accounts
    const empty: AccountsFile = { claude: { accounts: [] }, codex: { accounts: [] } }
    try {
      const saved = JSON.parse(readFileSync(this.accountsFile, 'utf8')) as Partial<AccountsFile>
      for (const p of ['claude', 'codex'] as const) {
        const list = Array.isArray(saved[p]?.accounts) ? saved[p]!.accounts.filter((a) => typeof a?.id === 'string' && typeof a.label === 'string') : []
        empty[p] = { accounts: list, ...(list.some((a) => a.id === saved[p]?.active) ? { active: saved[p]!.active } : {}) }
      }
    } catch { /* none yet */ }
    this.accounts = empty
    return empty
  }

  private async save() { await writeFile(this.accountsFile, JSON.stringify(this.load(), null, 2)) }

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

  /** What a Claude process adds to its environment for an account, the active one by default: its token. Nothing for the CLI login. */
  claudeEnv(accountId = this.active('claude')): Record<string, string> {
    if (!accountId) return {}
    const token = this.tokens()[accountId]
    if (!token || !this.o.cipher) return {}
    try { return { CLAUDE_CODE_OAUTH_TOKEN: this.o.cipher.decrypt(token) } } catch { return {} }
  }

  private tokens(): Record<string, string> {
    try { return JSON.parse(readFileSync(this.tokensFile, 'utf8')) as Record<string, string> } catch { return {} }
  }

  private async saveToken(id: string, token: string | undefined) {
    const all = this.tokens()
    if (token === undefined) delete all[id]
    else {
      if (!this.o.cipher) throw new Error("Kernel can't keep the token safe on this Mac, so it can't add the account.")
      all[id] = this.o.cipher.encrypt(token)
    }
    await writeFile(this.tokensFile, JSON.stringify(all, null, 2), { mode: 0o600 })
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
      const own = provider === 'claude' ? 'Claude Code’s own login' : 'Codex’s own login'
      out.push({ id: CLI_ACCOUNT, provider, label: cli.email ?? own, email: cli.email, plan: cli.plan, cli: true, active: !file[provider].active, signedIn: cli.signedIn })
      for (const a of file[provider].accounts) {
        const signedIn = provider === 'claude' ? !!this.tokens()[a.id] : existsSync(join(this.codexHome(a.id)!, 'auth.json'))
        out.push({ id: a.id, provider, label: a.label, email: a.email, plan: a.plan, cli: false, active: file[provider].active === a.id, signedIn })
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

  /**
   * Add account (KERNEL-406). Codex signs in with ChatGPT in a new home of its own. Claude runs `claude setup-token`. The
   * new account is added but not used until the user switches to it: switching is always a click.
   */
  async add(provider: Provider, label?: string): Promise<AccountProfile> {
    if (this.adding.has(provider)) throw new Error('A sign-in is already open. Finish or cancel it first.')
    if (provider === 'claude') throw new Error('Adding a Claude account is not ready yet.')
    const id = randomUUID()
    const home = this.codexHome(id)!
    await this.linkCodexHome(home)
    try {
      const who = await this.codexSignIn(home)
      const stored: StoredAccount = { id, label: label?.trim() || who.email || 'ChatGPT account', email: who.email, plan: who.plan, createdAt: Date.now() }
      this.load().codex.accounts.push(stored)
      await this.save()
      const profile: AccountProfile = { id, provider, label: stored.label, email: who.email, plan: who.plan, cli: false, active: false, signedIn: true }
      this.step({ provider, step: 'done', account: profile })
      void this.pushAccounts()
      return profile
    } catch (e) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined)
      this.step({ provider, step: 'failed', error: (e as Error).message })
      throw e
    }
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
   * no longer does.
   */
  async switchTo(provider: Provider, accountId: string): Promise<AccountProfile[]> {
    const file = this.load()
    const next = accountId === CLI_ACCOUNT ? undefined : file[provider].accounts.find((a) => a.id === accountId)?.id
    if (accountId !== CLI_ACCOUNT && !next) throw new Error('That account is no longer in Kernel.')
    if (provider === 'codex' && next) await this.linkCodexHome(this.codexHome(next)!)
    file[provider].active = next
    await this.save()
    if (provider === 'codex') this.codexModels = undefined
    this.sessions.restartProvider(provider)
    this.k.account.applyLimits(this.store.meta<RateLimit[]>('limits') ?? [])
    this.sessions.drainWaiting()
    const accounts = await this.list()
    if (!this.stopped) bus.push({ type: 'accounts', accounts })
    return accounts
  }

  /** Sign out: the CLI login signs the CLI out; an added account forgets its credential and stays listed, signed out. */
  async signOut(provider: Provider, accountId: string): Promise<AccountProfile[]> {
    const bin = this.mustBinary(provider)
    if (provider === 'claude') {
      if (accountId === CLI_ACCOUNT) await claudeSignOut(bin)
      else await this.saveToken(accountId, undefined)
    } else await withCodex(bin, accountId === CLI_ACCOUNT ? undefined : this.codexHome(accountId), (rpc) => rpc.request('account/logout'))
    const accounts = await this.list()
    if (!this.stopped) bus.push({ type: 'accounts', accounts })
    return accounts
  }

  /** Removes an added account and its credential. The provider moves back to the CLI login when it was the active one. */
  async remove(provider: Provider, accountId: string): Promise<AccountProfile[]> {
    if (accountId === CLI_ACCOUNT) throw new Error("The CLI's own login can't be removed. Sign out of it instead.")
    const file = this.load()
    if (!file[provider].accounts.some((a) => a.id === accountId)) throw new Error('That account is no longer in Kernel.')
    if (file[provider].active === accountId) await this.switchTo(provider, CLI_ACCOUNT)
    file[provider].accounts = file[provider].accounts.filter((a) => a.id !== accountId)
    await this.save()
    if (provider === 'claude') await this.saveToken(accountId, undefined)
    else await rm(this.codexHome(accountId)!, { recursive: true, force: true })
    const accounts = await this.list()
    if (!this.stopped) bus.push({ type: 'accounts', accounts })
    return accounts
  }

  /** Run login: the provider's own sign-in for the active account. */
  async signIn(provider: Provider): Promise<ProviderStatus> {
    if (provider === 'codex') {
      const id = this.active('codex')
      if (id) await this.linkCodexHome(this.codexHome(id)!)
      await this.codexSignIn(this.codexHome(id))
      this.step({ provider, step: 'done' })
    } else {
      if (this.active('claude')) throw new Error('Signing in again to an added Claude account is not ready yet.')
      await exec(this.mustBinary('claude'), ['auth', 'login'], { timeoutMs: 5 * 60_000 })
    }
    void this.pushAccounts()
    return this.status(provider)
  }

  handlers() {
    return {
      'providers.status': async ({ provider }) => this.status(provider),
      'providers.setPath': async ({ provider, path, useSystem }) => this.setPath(provider, { path, useSystem }),
      'providers.signIn': async ({ provider }) => this.signIn(provider),
      'providers.openConfig': async ({ provider }) => { await this.o.openFile?.(this.configFile(provider)); return { ok: true as const } },
      'accounts.list': async () => this.list(),
      'accounts.add': async ({ provider, label }) => this.add(provider, label),
      'accounts.code': async () => { throw new Error('No sign-in is waiting for a code.') },
      'accounts.cancelAdd': async ({ provider }) => { this.cancelAdd(provider); return { ok: true as const } },
      'accounts.switch': async ({ provider, accountId }) => this.switchTo(provider, accountId),
      'accounts.signOut': async ({ provider, accountId }) => this.signOut(provider, accountId),
      'accounts.remove': async ({ provider, accountId }) => this.remove(provider, accountId),
      'models.list': async ({ provider }) => this.models(provider)
    } satisfies Partial<Handlers>
  }
}
