import type { AgentDef, AgentReach, AgentWarning, McpServer, Provider } from '@shared/types'
import type { Handlers } from '../kernel'
import { bus } from '../bus'
import { mcpWarnings, serverReach } from '../services/agentTools'
import { buildEnv, withoutClaudeNames } from '../services/env'
import { discoverMcp, withStatus, type McpReport } from '../services/mcp'
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
   * The servers an agent can reach in the room and the ones its tools line names that it can't use, for the hire card and
   * hire_agent's result (KERNEL-476). For a Claude agent in a room no probe has listed yet, it starts one, so a server no
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
      }
    } satisfies Partial<Handlers>
  }
}
