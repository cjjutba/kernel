import type { AccountProfile, AgentDef, AgentReach, AgentWarning, McpAccount, McpAccountServer, McpConnect, McpServer, McpSignInAll, Provider } from '@shared/types'
import { mcpCounts, mcpNeedsYou } from '@shared/mcpCounts'
import type { Handlers } from '../kernel'
import { bus } from '../bus'
import { mcpWarnings, serverReach } from '../services/agentTools'
import { buildEnv, withoutClaudeNames } from '../services/env'
import { CONNECT_URL, discoverMcp, toolServerName, withMissing, withStatus, type McpReport } from '../services/mcp'
import { claudeExecutable } from '../services/providers/binary'
import { mcpReports, probeClaudeMcp, sessionEnv } from '../services/providers/claude'
import { aliasesInProject, disabledInProject } from '../services/settings'
import { Feature } from './feature'

/**
 * The MCP servers each project's agents can reach, and how each is doing (KERNEL-464). Kernel finds them in the files Claude
 * Code and Codex read, and hears their status from a probe of the project and from every session. Nothing is saved: a status
 * is as good as the last report, and the next probe or session brings a new one.
 */
export class Mcp extends Feature {
  /** The last report on each server, by project, then provider, then the server's name. */
  private readonly reports = new Map<string, Map<Provider, Map<string, McpReport>>>()
  /** Projects a probe has listed Claude's servers for, so a server it didn't list is missing. */
  private readonly probed = new Set<string>()
  /** Projects the first `mcp.list` started a probe for, so a probe that fails isn't started again by every list. */
  private readonly asked = new Set<string>()
  private readonly probes = new Map<string, Promise<void>>()
  /** What `mcp.accounts` last found on each account, by `provider:id` (KERNEL-626). */
  private readonly onAccounts = new Map<string, Omit<McpAccount, 'label' | 'needsYou' | 'ready'>>()
  /** Account checks running, by `provider:id`, so two calls share one. */
  private readonly checks = new Map<string, Promise<void>>()
  /** A check asked for while one runs, by `provider:id`, which runs once it ends so it sees what changed meanwhile (KERNEL-660). */
  private readonly again = new Map<string, Promise<void>>()
  /** When `mcp.recheck` last checked, for its throttle (KERNEL-660). */
  private recheckedAt = 0
  /** Added accounts the after-add notice went out for, so it goes once. */
  private readonly announced = new Set<string>()
  /** Sign in to all while it runs, by provider. One runs at a time per provider, as one sign-in does. */
  private readonly signingIn = new Map<Provider, { canceled: boolean }>()
  /** When a Codex server last signed in from Kernel, by name. Codex shares the token, so it is ready on every Codex account checked before (KERNEL-646). */
  private readonly codexSignedIn = new Map<string, number>()

  /** The project's servers for one provider, with the last status each had. */
  async servers(projectId: string, provider: Provider = 'claude'): Promise<McpServer[]> {
    const { path } = this.mustProject(projectId)
    const off = disabledInProject(path).mcp
    return withStatus(await this.discover(path, off), this.known(projectId, provider), off, provider)
  }

  /** Every report the project holds for one provider. */
  known(projectId: string, provider: Provider): McpReport[] { return [...(this.reports.get(projectId)?.get(provider)?.values() ?? [])] }

  /**
   * A session's report. It adds to what the project knows and never takes a server away, since a session may not list one
   * yet (claude.ai's connectors join late) or at all (one the project switched off). Returns what the project holds now.
   */
  reported(projectId: string, provider: Provider, list: McpReport[]): McpReport[] {
    this.merge(projectId, provider, list, false)
    return this.known(projectId, provider)
  }

  /**
   * Checks the project's Claude servers now: Claude Code starts in the project's folder with what a session there gets from the
   * project's settings, lists the servers with their status and stops (`probeClaudeMcp`). The list replaces what the project
   * knew of Claude's servers, so one taken out of a file goes. One probe runs per project at a time.
   */
  probe(projectId: string): Promise<void> {
    const running = this.probes.get(projectId)
    if (running) return running
    const p = (async () => {
      const { path } = this.mustProject(projectId)
      const base = buildEnv({ base: process.env, app: withoutClaudeNames(this.envStore.values()), project: withoutClaudeNames(this.envStore.values(projectId)), kernel: {} })
      const list = await probeClaudeMcp(path, { env: sessionEnv(base, this.k.providers.claudeEnv()), executable: claudeExecutable(this.settings.providers?.claude), denied: disabledInProject(path).mcp })
      this.probed.add(projectId)
      this.merge(projectId, 'claude', mcpReports(list), true)
    })().finally(() => this.probes.delete(projectId))
    this.probes.set(projectId, p)
    return p
  }

  /**
   * What an agent's tools line needs from the project's servers, on the provider it runs on, as Team warnings. Codex's list
   * is its config. Claude's is only whole once a probe listed it, since claude.ai's connectors are in no file.
   */
  async warnings(projectId: string, agent: AgentDef): Promise<AgentWarning[]> {
    const { servers, aliases, complete } = await this.forAgent(projectId, agent)
    return mcpWarnings(agent.tools, servers, { aliases, complete })
  }

  /**
   * The servers an agent can reach in the project and the ones its tools line names that it can't use, for the new agent card
   * and create_agent's result (KERNEL-476). For a Claude agent in a project no probe has listed yet, it starts one, so a server no
   * file names can be told apart from a claude.ai connector. `wait` waits for that probe, and without it the answer is
   * what the project knows now.
   */
  async reach(projectId: string, agent: AgentDef, o: { wait?: boolean } = {}): Promise<AgentReach> {
    if (this.k.team.pickFor(agent).provider === 'claude' && !this.probed.has(projectId)) {
      const checked = this.probe(projectId).catch(() => undefined)
      if (o.wait) await checked
    }
    const { servers, aliases, complete } = await this.forAgent(projectId, agent)
    return serverReach(agent.tools, servers, { disallowed: agent.disallowedTools, aliases, complete })
  }

  /** The project's servers on the provider an agent runs on, with the project's aliases and whether the list is whole. */
  private async forAgent(projectId: string, agent: AgentDef) {
    const provider = this.k.team.pickFor(agent).provider
    const servers = await this.servers(projectId, provider)
    return { servers, aliases: aliasesInProject(this.mustProject(projectId).path), complete: provider === 'codex' || this.probed.has(projectId) }
  }

  private discover(root: string, off: string[]) {
    return discoverMcp(root, this.home, off, { codexHome: this.k.providers.codexHome() })
  }

  /** Takes in a report, and tells the renderer when the project's servers for that provider changed. */
  private merge(projectId: string, provider: Provider, list: McpReport[], replace: boolean) {
    const project = this.reports.get(projectId) ?? new Map<Provider, Map<string, McpReport>>()
    const before = project.get(provider) ?? new Map<string, McpReport>()
    const next = new Map(replace ? [] : before)
    for (const r of list) next.set(r.name, r)
    project.set(provider, next)
    this.reports.set(projectId, project)
    const shape = (m: Map<string, McpReport>) => JSON.stringify([...m.values()].sort((a, b) => a.name.localeCompare(b.name)))
    if (shape(before) === shape(next)) return
    void this.servers(projectId, provider).then((servers) => bus.push({ type: 'mcp', projectId, provider, servers })).catch(() => undefined)
  }

  // ---------- every account's servers (KERNEL-626)

  /**
   * Every signed-in subscription account's MCP servers (`mcp.accounts`). An account Kernel hasn't checked is checked now,
   * and `refresh` checks the ones it names again: every account, or only `provider`'s, or only `accountId`. Accounts are
   * checked side by side. Pushes `mcp.accounts` when any was checked.
   */
  async accounts(o: { refresh?: boolean; provider?: Provider; accountId?: string } = {}): Promise<McpAccount[]> {
    const rows = await this.mcpRows()
    const named = (a: AccountProfile) => (!o.provider || o.provider === a.provider) && (!o.accountId || o.accountId === a.id)
    const due = rows.filter((a) => !this.onAccounts.has(`${a.provider}:${a.id}`) || (o.refresh && named(a)))
    await Promise.all(due.map((a) => this.checkAccount(a.provider, a.id)))
    const out = this.view(rows)
    if (due.length && !this.stopped) bus.push({ type: 'mcp.accounts', accounts: out })
    return out
  }

  /** The accounts `mcp.accounts` covers: signed-in subscription logins. A legacy token account has no login to check. */
  private async mcpRows(): Promise<AccountProfile[]> {
    return (await this.k.providers.list()).filter((a) => a.auth === 'subscription' && a.signedIn && !a.legacyToken)
  }

  /**
   * Checks one account's servers. A check that fails keeps its reason and no servers. Two calls share a running check, unless
   * `fresh`, which runs one more after it, since a sign-in that finished meanwhile may not be in it (KERNEL-660). `checkedAt`
   * is when the check started, so a sign-in during it counts as newer. `Providers.shareMcp` asks for one on each login a
   * sign-in was copied to (KERNEL-935).
   */
  checkAccount(provider: Provider, accountId: string, o: { fresh?: boolean } = {}): Promise<void> {
    // A queued re-check outlives a Kernel that stopped meanwhile, and would start a Claude Code query after it.
    if (this.stopped) return Promise.resolve()
    const key = `${provider}:${accountId}`
    const running = this.checks.get(key)
    if (running && !o.fresh) return running
    if (running) {
      const queued = this.again.get(key)
      if (queued) return queued
      const next = running.then(() => { this.again.delete(key); return this.checkAccount(provider, accountId) })
      this.again.set(key, next)
      return next
    }
    const p = (async () => {
      const startedAt = Date.now()
      try {
        const servers = await this.k.providers.mcpServersOn(provider, accountId)
        this.onAccounts.set(key, { provider, accountId, checkedAt: startedAt, servers })
      } catch (e) {
        this.onAccounts.set(key, { provider, accountId, error: (e as Error).message, servers: [] })
      }
    })().finally(() => this.checks.delete(key))
    this.checks.set(key, p)
    return p
  }

  /**
   * What Kernel knows of each account in `rows`, in their order, with every server of its provider (`withMissing`). A Claude
   * server a sign-in landed on since the check, here or copied from another login, reads `checking` until the next check, since
   * only Claude Code can say it works (KERNEL-935). A Codex server signed in from Kernel since the account's check is ready,
   * since Codex shares the token (KERNEL-646). Then the quiet ones:
   * a server ignored on the account reads `ignored`, and one switched off in every project carries `projectOff`. Last the counts,
   * and the Codex accounts whose servers read the same (`sharedWith`, KERNEL-660).
   */
  private view(rows: AccountProfile[]): McpAccount[] {
    const ready = (s: McpAccountServer): McpAccountServer => ({ name: s.name, kind: s.kind, connector: s.connector, state: 'ready' })
    const projectOff = this.projectOff()
    const out = withMissing(rows.map((a): Omit<McpAccount, 'needsYou' | 'ready'> => {
      const base = { provider: a.provider, accountId: a.id, label: a.label, ...(a.email ? { email: a.email } : {}) }
      const had = this.onAccounts.get(`${a.provider}:${a.id}`)
      if (!had) return { ...base, servers: [] }
      if (a.provider === 'claude') {
        const checking = new Set(this.k.providers.mcpCheckingOn(a.id))
        return { ...had, ...base, servers: had.servers.map((s) => (checking.has(s.name) ? { name: s.name, kind: s.kind, connector: s.connector, state: 'checking' } : s)) }
      }
      const signedIn = (s: McpAccountServer) => (this.codexSignedIn.get(s.name) ?? 0) > (had.checkedAt ?? 0)
      const servers = had.servers.map((s) => (s.state === 'needs-sign-in' && signedIn(s) ? ready(s) : s))
      return { ...had, ...base, servers }
    })).map((a) => {
      const ignored = new Set(this.k.providers.mcpIgnored(a.provider, a.accountId))
      const servers = a.servers.map((s): McpAccountServer => {
        const off = projectOff(s.name) ? { projectOff: true } : {}
        return ignored.has(s.name) ? { name: s.name, kind: s.kind, connector: s.connector, state: 'ignored', ...off } : { ...s, ...off }
      })
      return { ...a, servers, ...mcpCounts(servers) }
    })
    return withShared(out)
  }

  /**
   * Whether a server is switched off in every project Kernel has open, by its name or the name its tools carry (KERNEL-646). Such
   * a server never runs, so it doesn't warn. With no project open, none is.
   */
  projectOff(): (server: string) => boolean {
    const projects = this.store.projects().filter((r) => !r.archived)
    if (!projects.length) return () => false
    const lists = projects.map((r) => { try { return new Set(disabledInProject(r.path).mcp.map(toolServerName)) } catch { return new Set<string>() } })
    return (server) => lists.every((off) => off.has(toolServerName(server)))
  }

  /**
   * A server just signed in from Kernel (`Providers.mcpSignIn`). Codex's is kept, since Claude's read `checking` until the
   * check (`Providers.mcpCheckingOn`, KERNEL-935). Every window hears at once, and again once the account is checked again,
   * with what Claude Code said (KERNEL-660).
   */
  signedIn(provider: Provider, accountId: string, server: string) {
    if (provider === 'codex') this.codexSignedIn.set(server, Date.now())
    void this.pushAccounts()
    if (!this.stopped) void this.checkAccount(provider, accountId, { fresh: true }).then(() => this.pushAccounts())
  }

  /**
   * Re-check on return (`mcp.recheck`, KERNEL-660): when Kernel's window gets focus, the accounts with something pending,
   * servers that need the user or a check that failed, are checked again side by side. At most once every RECHECK_MS, and
   * a call inside that only answers with what Kernel knows.
   */
  async recheck(): Promise<McpAccount[]> {
    const rows = await this.mcpRows()
    if (Date.now() - this.recheckedAt < RECHECK_MS) return this.view(rows)
    this.recheckedAt = Date.now()
    const pending = this.view(rows).filter((a) => a.error || a.needsYou > 0)
    await Promise.all(pending.map((a) => this.checkAccount(a.provider, a.accountId, { fresh: true })))
    const out = this.view(rows)
    if (pending.length && !this.stopped) bus.push({ type: 'mcp.accounts', accounts: out })
    return out
  }

  /** Tells every window what `mcp.accounts` knows now, without checking anything. `Providers.mcpSignIn` calls it after a sign-in. */
  async pushAccounts() {
    const rows = await this.mcpRows().catch(() => undefined)
    if (rows && !this.stopped) bus.push({ type: 'mcp.accounts', accounts: this.view(rows) })
  }

  /**
   * An account was just added (`Providers.add`): its first check, then one `account.mcpNeeded` push when servers need a
   * sign-in there, the ignored ones and ones switched off in every project left out. Only Claude: Codex shares its servers and
   * their sign-ins with every Codex account, so a new one needs nothing the others don't (KERNEL-626.md). The app turns it
   * on (`checkMcpOnAdd`).
   */
  async accountAdded(provider: Provider, accountId: string): Promise<void> {
    if (!this.o.checkMcpOnAdd || provider !== 'claude' || this.stopped || this.announced.has(accountId)) return
    this.announced.add(accountId)
    await this.checkAccount(provider, accountId)
    const rows = await this.mcpRows()
    if (this.stopped) return
    const out = this.view(rows)
    bus.push({ type: 'mcp.accounts', accounts: out })
    const a = out.find((x) => x.provider === provider && x.accountId === accountId)
    const servers = a ? waiting(a) : []
    if (!a || !servers.length) return
    const n = servers.length
    bus.push({ type: 'account.mcpNeeded', needed: { provider, accountId, servers, title: `${n} MCP server${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a sign-in on ${a.label}` } })
  }

  /**
   * Sign in to all: every server that needs a sign-in on an account, one after another, through `Providers.mcpSignIn`, the
   * ignored ones and ones switched off in every project left out. Codex since KERNEL-646.
   */
  signInAll(provider: Provider, accountId: string): Promise<McpSignInAll> {
    return this.queue(provider, accountId, async (a) => ({ steps: waiting(a).map((server) => ({ server })) }))
  }

  /**
   * Set up this account (`accounts.mcpSetUp`, KERNEL-660). Of the servers that need the user there (`mcpNeedsYou`), the ones
   * not in `include` are ignored on the account in one write. The rest go in `include`'s order: one needing a sign-in joins
   * the queue, and the claude.ai connectors not set up there become one `account.mcpConnect` step at the first one's turn.
   * A failed server, or one Kernel can't set up, is left for the re-check.
   */
  setUp(provider: Provider, accountId: string, include: string[]): Promise<McpSignInAll> {
    return this.queue(provider, accountId, async (a) => {
      const needs = new Map(a.servers.filter(mcpNeedsYou).map((s) => [s.name, s]))
      const ticked = new Set(include)
      const ignored = [...needs.keys()].filter((name) => !ticked.has(name))
      if (ignored.length) await this.k.providers.ignoreMcp(provider, accountId, ignored)
      const connectors = [...ticked].filter((name) => needs.get(name)?.state === 'not-set-up' && needs.get(name)?.kind === 'connector')
      const connect: McpConnect | undefined = connectors.length ? { provider, accountId, ...(a.email ? { email: a.email } : {}), url: CONNECT_URL, servers: connectors } : undefined
      const steps: Step[] = []
      for (const name of ticked) {
        if (needs.get(name)?.state === 'needs-sign-in') steps.push({ server: name })
        else if (connect && name === connectors[0]) steps.push({ connect })
      }
      return { steps, ignored }
    })
  }

  /**
   * Works through an account's servers one after another (`signInAll`, `setUp`): `plan` picks the steps from the account as
   * `mcp.accounts` has it, which is checked first when it hasn't been. A sign-in goes through `Providers.mcpSignIn`, and a server
   * a sign-in from another login or one before it already covered counts as done without one. A failed sign-in goes on the
   * list and the queue moves on. A connectors step is pushed as `account.mcpConnect`. `cancelSignInAll` ends it before the
   * next step. One runs at a time per provider, as one sign-in does. Progress goes out as `account.mcpSignInAll`.
   */
  private async queue(provider: Provider, accountId: string, plan: (a: McpAccount) => Promise<{ steps: Step[]; ignored?: string[] }>): Promise<McpSignInAll> {
    if (this.signingIn.has(provider)) throw new Error('Sign in to all is already running. Finish or cancel it first.')
    const state = { canceled: false }
    this.signingIn.set(provider, state)
    const run: McpSignInAll = { ...(provider === 'codex' ? { provider } : {}), accountId, servers: [], done: [], failed: [] }
    const push = () => { if (!this.stopped) bus.push({ type: 'account.mcpSignInAll', run: { ...run, servers: [...run.servers], done: [...run.done], failed: [...run.failed] } }) }
    const key = `${provider}:${accountId}`
    try {
      if (!this.onAccounts.has(key)) await this.checkAccount(provider, accountId)
      const had = this.onAccounts.get(key)
      if (had?.error) throw new Error(had.error)
      // The whole view, so the account has every server of its provider (`withMissing`).
      const account = this.view(await this.mcpRows()).find((a) => a.provider === provider && a.accountId === accountId)
      if (!account) throw new Error('That account is no longer in Kernel.')
      const { steps, ignored } = await plan(account)
      if (ignored?.length) run.ignored = ignored
      run.servers = steps.flatMap((s) => ('server' in s ? [s.server] : []))
      push()
      for (const step of steps) {
        if (state.canceled) break
        if ('connect' in step) {
          run.connect = step.connect
          if (!this.stopped) bus.push({ type: 'account.mcpConnect', connect: step.connect })
          push()
          continue
        }
        const server = step.server
        const covered = provider === 'claude' ? !this.k.providers.mcpSignInsOn(accountId)?.some((s) => s.server === server) : (this.codexSignedIn.get(server) ?? 0) > (had?.checkedAt ?? 0)
        if (covered) { run.done.push(server); continue }
        run.current = server
        push()
        try {
          await this.k.providers.mcpSignIn(provider, accountId, server)
          run.done.push(server)
        } catch (e) {
          if (state.canceled) break
          run.failed.push({ server, error: (e as Error).message })
        }
      }
    } finally { this.signingIn.delete(provider) }
    delete run.current
    run.finished = true
    if (state.canceled) run.canceled = true
    push()
    return run
  }

  /** Cancel on Sign in to all: no server after the one signing in now starts. */
  cancelSignInAll(provider: Provider) { const run = this.signingIn.get(provider); if (run) run.canceled = true }

  /** `accounts.mcpIgnore`: kept on the account, then `mcp.accounts` as it reads now, pushed too (KERNEL-646). */
  async ignore(provider: Provider, accountId: string, server: string, ignored: boolean): Promise<McpAccount[]> {
    await this.k.providers.setMcpIgnored(provider, accountId, server, ignored)
    const out = this.view(await this.mcpRows())
    if (!this.stopped) bus.push({ type: 'mcp.accounts', accounts: out })
    return out
  }

  handlers() {
    return {
      'mcp.list': async ({ projectId, provider = 'claude', probe }) => {
        if (!projectId) return (await this.discover(this.home, [])).filter((s) => (s.provider ?? 'claude') === provider)
        this.mustProject(projectId)
        // The first list for a project checks it, and the answer comes as an `mcp` push. `probe` waits for a fresh one.
        if (provider === 'claude' && (probe || !this.asked.has(projectId))) {
          this.asked.add(projectId)
          const checked = this.probe(projectId).catch(() => undefined)
          if (probe) await checked
        }
        return this.servers(projectId, provider)
      },
      'mcp.accounts': async (req) => this.accounts(req ?? {}),
      'accounts.mcpIgnore': async ({ provider, accountId, server, ignored }) => this.ignore(provider, accountId, server, ignored),
      'accounts.mcpSetUp': async ({ provider, accountId, include }) => this.setUp(provider, accountId, include),
      'mcp.recheck': async () => this.recheck()
    } satisfies Partial<Handlers>
  }
}

/** The servers on an account that need a sign-in and warn: not ignored, which `view` already made `ignored`, and not off in every project. */
const waiting = (a: McpAccount) => a.servers.filter((s) => s.state === 'needs-sign-in' && !s.projectOff).map((s) => s.name)

/** How often `mcp.recheck` checks at most (KERNEL-660). */
const RECHECK_MS = 10_000

/** One step of `Mcp.queue`: a server to sign in to, or the claude.ai connectors to add in one go. */
type Step = { server: string } | { connect: McpConnect }

/**
 * Each Codex account with the ids of the other Codex accounts whose servers read the same, name for name and state for state
 * (KERNEL-660). Codex keeps MCP sign-ins in one store for every Codex account, so those show as one. Accounts not checked, or
 * whose check failed, match none.
 */
function withShared(accounts: McpAccount[]): McpAccount[] {
  const shape = (a: McpAccount) => (a.provider === 'codex' && a.checkedAt !== undefined && !a.error ? JSON.stringify(a.servers.map((s) => [s.name, s.state])) : undefined)
  const shapes = accounts.map(shape)
  return accounts.map((a, i) => {
    const same = shapes[i] === undefined ? [] : accounts.filter((b, j) => j !== i && shapes[j] === shapes[i]).map((b) => b.accountId)
    return same.length ? { ...a, sharedWith: same } : a
  })
}
