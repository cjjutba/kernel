import type { AccountProfile, AgentDef, AgentReach, AgentWarning, McpAccount, McpServer, McpSignInAll, Provider } from '@shared/types'
import type { Handlers } from '../kernel'
import { bus } from '../bus'
import { mcpWarnings, serverReach } from '../services/agentTools'
import { buildEnv, withoutClaudeNames } from '../services/env'
import { discoverMcp, withMissing, withStatus, type McpReport } from '../services/mcp'
import { claudeExecutable } from '../services/providers/binary'
import { mcpReports, probeClaudeMcp, sessionEnv } from '../services/providers/claude'
import { aliasesInRoom, disabledInRoom } from '../services/settings'
import { Feature } from './feature'

/**
 * The MCP servers each room's agents can reach, and how each is doing (KERNEL-464). Kernel finds them in the files Claude
 * Code and Codex read, and hears their status from a probe of the room and from every session. Nothing is saved: a status
 * is as good as the last report, and the next probe or session brings a new one.
 */
export class Mcp extends Feature {
  /** The last report on each server, by room, then provider, then the server's name. */
  private readonly reports = new Map<string, Map<Provider, Map<string, McpReport>>>()
  /** Rooms a probe has listed Claude's servers for, so a server it didn't list is missing. */
  private readonly probed = new Set<string>()
  /** Rooms the first `mcp.list` started a probe for, so a probe that fails isn't started again by every list. */
  private readonly asked = new Set<string>()
  private readonly probes = new Map<string, Promise<void>>()
  /** What `mcp.accounts` last found on each account, by `provider:id` (KERNEL-626). */
  private readonly onAccounts = new Map<string, Omit<McpAccount, 'label'>>()
  /** Account checks running, by `provider:id`, so two calls share one. */
  private readonly checks = new Map<string, Promise<void>>()
  /** Added accounts the after-add notice went out for, so it goes once. */
  private readonly announced = new Set<string>()
  /** Sign in to all while it runs. One runs at a time, as one sign-in does. */
  private signingIn?: { canceled: boolean }

  /** The room's servers for one provider, with the last status each had. */
  async servers(roomId: string, provider: Provider = 'claude'): Promise<McpServer[]> {
    const { path } = this.mustRoom(roomId)
    const off = disabledInRoom(path).mcp
    return withStatus(await this.discover(path, off), this.known(roomId, provider), off, provider)
  }

  /** Every report the room holds for one provider. */
  known(roomId: string, provider: Provider): McpReport[] { return [...(this.reports.get(roomId)?.get(provider)?.values() ?? [])] }

  /**
   * A session's report. It adds to what the room knows and never takes a server away, since a session may not list one
   * yet (claude.ai's connectors join late) or at all (one the room switched off). Returns what the room holds now.
   */
  reported(roomId: string, provider: Provider, list: McpReport[]): McpReport[] {
    this.merge(roomId, provider, list, false)
    return this.known(roomId, provider)
  }

  /**
   * Checks the room's Claude servers now: Claude Code starts in the room's folder with what a session there gets from the
   * room's settings, lists the servers with their status and stops (`probeClaudeMcp`). The list replaces what the room
   * knew of Claude's servers, so one taken out of a file goes. One probe runs per room at a time.
   */
  probe(roomId: string): Promise<void> {
    const running = this.probes.get(roomId)
    if (running) return running
    const p = (async () => {
      const { path } = this.mustRoom(roomId)
      const base = buildEnv({ base: process.env, app: withoutClaudeNames(this.envStore.values()), room: withoutClaudeNames(this.envStore.values(roomId)), kernel: {} })
      const list = await probeClaudeMcp(path, { env: sessionEnv(base, this.k.providers.claudeEnv()), executable: claudeExecutable(this.settings.providers?.claude), denied: disabledInRoom(path).mcp })
      this.probed.add(roomId)
      this.merge(roomId, 'claude', mcpReports(list), true)
    })().finally(() => this.probes.delete(roomId))
    this.probes.set(roomId, p)
    return p
  }

  /**
   * What an agent's tools line needs from the room's servers, on the provider it runs on, as Team warnings. Codex's list
   * is its config. Claude's is only whole once a probe listed it, since claude.ai's connectors are in no file.
   */
  async warnings(roomId: string, agent: AgentDef): Promise<AgentWarning[]> {
    const { servers, aliases, complete } = await this.forAgent(roomId, agent)
    return mcpWarnings(agent.tools, servers, { aliases, complete })
  }

  /**
   * The servers an agent can reach in the room and the ones its tools line names that it can't use, for the new agent card
   * and create_agent's result (KERNEL-476). For a Claude agent in a room no probe has listed yet, it starts one, so a server no
   * file names can be told apart from a claude.ai connector. `wait` waits for that probe, and without it the answer is
   * what the room knows now.
   */
  async reach(roomId: string, agent: AgentDef, o: { wait?: boolean } = {}): Promise<AgentReach> {
    if (this.k.team.pickFor(agent).provider === 'claude' && !this.probed.has(roomId)) {
      const checked = this.probe(roomId).catch(() => undefined)
      if (o.wait) await checked
    }
    const { servers, aliases, complete } = await this.forAgent(roomId, agent)
    return serverReach(agent.tools, servers, { disallowed: agent.disallowedTools, aliases, complete })
  }

  /** The room's servers on the provider an agent runs on, with the room's aliases and whether the list is whole. */
  private async forAgent(roomId: string, agent: AgentDef) {
    const provider = this.k.team.pickFor(agent).provider
    const servers = await this.servers(roomId, provider)
    return { servers, aliases: aliasesInRoom(this.mustRoom(roomId).path), complete: provider === 'codex' || this.probed.has(roomId) }
  }

  private discover(root: string, off: string[]) {
    return discoverMcp(root, this.home, off, { codexHome: this.k.providers.codexHome() })
  }

  /** Takes in a report, and tells the renderer when the room's servers for that provider changed. */
  private merge(roomId: string, provider: Provider, list: McpReport[], replace: boolean) {
    const room = this.reports.get(roomId) ?? new Map<Provider, Map<string, McpReport>>()
    const before = room.get(provider) ?? new Map<string, McpReport>()
    const next = new Map(replace ? [] : before)
    for (const r of list) next.set(r.name, r)
    room.set(provider, next)
    this.reports.set(roomId, room)
    const shape = (m: Map<string, McpReport>) => JSON.stringify([...m.values()].sort((a, b) => a.name.localeCompare(b.name)))
    if (shape(before) === shape(next)) return
    void this.servers(roomId, provider).then((servers) => bus.push({ type: 'mcp', roomId, provider, servers })).catch(() => undefined)
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

  /** Checks one account's servers. A check that fails keeps its reason and no servers. */
  private checkAccount(provider: Provider, accountId: string): Promise<void> {
    const key = `${provider}:${accountId}`
    const running = this.checks.get(key)
    if (running) return running
    const p = (async () => {
      try {
        const servers = await this.k.providers.mcpServersOn(provider, accountId)
        this.onAccounts.set(key, { provider, accountId, checkedAt: Date.now(), servers })
      } catch (e) {
        this.onAccounts.set(key, { provider, accountId, error: (e as Error).message, servers: [] })
      }
    })().finally(() => this.checks.delete(key))
    this.checks.set(key, p)
    return p
  }

  /**
   * What Kernel knows of each account in `rows`, in their order. A Claude server that needed a sign-in and is off the account's
   * `mcpSignIns` since got one, here or shared from another login, so it is ready.
   */
  private view(rows: AccountProfile[]): McpAccount[] {
    return withMissing(rows.map((a): McpAccount => {
      const had = this.onAccounts.get(`${a.provider}:${a.id}`)
      if (!had) return { provider: a.provider, accountId: a.id, label: a.label, servers: [] }
      const left = a.provider === 'claude' ? this.k.providers.mcpSignInsOn(a.id) : undefined
      const servers = had.servers.map((s) => (s.state === 'needs-sign-in' && left && !left.some((x) => x.server === s.name) ? { name: s.name, connector: s.connector, state: 'ready' as const } : s))
      return { ...had, label: a.label, servers }
    }))
  }

  /** Tells every window what `mcp.accounts` knows now, without checking anything. `Providers.mcpSignIn` calls it after a sign-in. */
  async pushAccounts() {
    const rows = await this.mcpRows().catch(() => undefined)
    if (rows && !this.stopped) bus.push({ type: 'mcp.accounts', accounts: this.view(rows) })
  }

  /**
   * An account was just added (`Providers.add`): its first check, then one `account.mcpNeeded` push when servers need a
   * sign-in there. Only Claude: Codex shares its servers and their sign-ins with every Codex account, so a new one needs
   * nothing the others don't (KERNEL-626.md). The app turns it on (`checkMcpOnAdd`).
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
    const servers = a?.servers.filter((s) => s.state === 'needs-sign-in').map((s) => s.name) ?? []
    if (!a || !servers.length) return
    const n = servers.length
    bus.push({ type: 'account.mcpNeeded', needed: { provider, accountId, servers, title: `${n} MCP server${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a sign-in on ${a.label}` } })
  }

  /**
   * Sign in to all (`accounts.mcpSignInAll`): every server that needs a sign-in on a Claude account, one after another,
   * through `Providers.mcpSignIn`. The account is checked first when `mcp.accounts` hasn't. A server a sign-in shared from
   * another login already covered is counted done without a sign-in. A failed sign-in goes on the list and the queue moves
   * on. `cancelSignInAll` ends it before the next server.
   */
  async signInAll(accountId: string): Promise<McpSignInAll> {
    if (this.signingIn) throw new Error('Sign in to all is already running. Finish or cancel it first.')
    const state = { canceled: false }
    this.signingIn = state
    const run: McpSignInAll = { accountId, servers: [], done: [], failed: [] }
    const push = () => { if (!this.stopped) bus.push({ type: 'account.mcpSignInAll', run: { ...run, servers: [...run.servers], done: [...run.done], failed: [...run.failed] } }) }
    try {
      if (!this.onAccounts.has(`claude:${accountId}`)) await this.checkAccount('claude', accountId)
      const had = this.onAccounts.get(`claude:${accountId}`)
      if (had?.error) throw new Error(had.error)
      const row = (await this.mcpRows()).find((a) => a.provider === 'claude' && a.id === accountId)
      if (!row) throw new Error('That account is no longer in Kernel.')
      run.servers = this.view([row])[0].servers.filter((s) => s.state === 'needs-sign-in').map((s) => s.name)
      push()
      for (const server of run.servers) {
        if (state.canceled) break
        if (!this.k.providers.mcpSignInsOn(accountId)?.some((s) => s.server === server)) { run.done.push(server); continue }
        run.current = server
        push()
        try {
          await this.k.providers.mcpSignIn(accountId, server)
          run.done.push(server)
        } catch (e) {
          if (state.canceled) break
          run.failed.push({ server, error: (e as Error).message })
        }
      }
    } finally { this.signingIn = undefined }
    delete run.current
    run.finished = true
    if (state.canceled) run.canceled = true
    push()
    return run
  }

  /** Cancel on Sign in to all: no server after the one signing in now starts. */
  cancelSignInAll() { if (this.signingIn) this.signingIn.canceled = true }

  handlers() {
    return {
      'mcp.list': async ({ roomId, provider = 'claude', probe }) => {
        if (!roomId) return (await this.discover(this.home, [])).filter((s) => (s.provider ?? 'claude') === provider)
        this.mustRoom(roomId)
        // The first list for a room checks it, and the answer comes as an `mcp` push. `probe` waits for a fresh one.
        if (provider === 'claude' && (probe || !this.asked.has(roomId))) {
          this.asked.add(roomId)
          const checked = this.probe(roomId).catch(() => undefined)
          if (probe) await checked
        }
        return this.servers(roomId, provider)
      },
      'mcp.accounts': async (req) => this.accounts(req ?? {}),
      'accounts.mcpSignInAll': async ({ accountId }) => this.signInAll(accountId)
    } satisfies Partial<Handlers>
  }
}
