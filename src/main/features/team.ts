import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { AgentChangePr, AgentDef, AgentDraft, AgentEdit, AgentScope, AgentStatus, Provider, Role, RoleModel, RosterAdvice, TeamConfig, TeamPatch, TeamTemplate, Workspace } from '@shared/types'
import { rolePick } from '@shared/rolePick'
import { isReviewer, KERNEL_LEAD, KERNEL_REVIEWER, NO_REVIEWER } from '@shared/team'
import { countRange } from '@shared/telemetry'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { createAgent, draftAgent, loadAgents, loadPersonalAgents, teamFiles, watchAgents, watchPersonalAgents, watchTeamSettings } from '../services/agents'
import { builtinFile, loadBuiltins, type Builtins } from '../services/builtins'
import { loadPluginAgents } from '../services/pluginAgents'
import { agentFiles, copyAgentFiles, seatStarterTeam, STARTER_IDS } from '../services/rooms'
import { loadRepoSettings, saveTeamSettings } from '../services/settings'
import { adviseRoster, resolveTeam, takesTasksByDefault, type Resolved } from '../services/teamResolve'
import { Feature } from './feature'

/**
 * The provider and model an agent file's `model:` pins it to, as its chats start on them, or undefined without a pin.
 * `inherit` and an id Kernel can't place pin nothing, since the agent follows its role then (KERNEL-406).
 */
const pinOf = (a: AgentDef) => { const pick = rolePick(a, { provider: 'claude', model: '', effort: 'high' }); return pick.model ? pick : undefined }

/**
 * Each room's team: the agent files in .claude/agents, their statuses, and hiring and retiring (KERNEL-326). Who leads,
 * who reviews and who takes tasks come from the files, the room's `[team]` settings and Kernel's own Rowan (KERNEL-397,
 * KERNEL-553). The user's own agents in ~/.claude/agents and Claude Code's plugin agents join every room (KERNEL-463).
 */
export class Team extends Feature {
  readonly agentCache = new Map<string, AgentDef[]>()
  /**
   * Each room's built-in Lead as last resolved, so a workspace on it still finds its agent once the room has its own, and
   * Kernel's Theo for review workspaces from before KERNEL-553.
   */
  private builtins = new Map<string, Builtins>()
  /** Rooms whose last list sent to the renderer had Kernel's Theo in it. */
  private listsTheo = new Set<string>()
  private agentWatchers = new Map<string, () => void>()
  readonly statuses = new Map<string, Record<string, AgentStatus>>()
  /** The shape last reported for each room, so `team.resolved` goes out once per change. */
  private shapes = new Map<string, string>()
  /** Plugin agents, as Claude Code listed them once this launch (KERNEL-463). Unset until the list comes back. */
  private plugins?: AgentDef[]
  /** Claude Code's plugin list, asked once a launch. Settles when it comes back or fails. */
  private pluginsAsk?: Promise<void>
  /** The watcher on ~/.claude/agents for Settings, Agents, from its first list on (KERNEL-640). */
  private globalWatcher?: () => void
  /** The last `globalAgents` list pushed, so a change that changes nothing isn't sent again. */
  private globalSent?: string
  /** Pushes run one after another, so a slow read can't send an older list after a newer one. */
  private globalPush = Promise.resolve()
  /**
   * What each provider offers, as last asked. A sign-in check takes a CLI start, so a team read doesn't ask again until
   * something real changes it: a sign-in or sign-out, another executable, Codex's model list (`forgetOffers`, KERNEL-634).
   */
  private offers = new Map<Provider, Promise<string[] | 'signed-out' | undefined>>()

  stop() {
    for (const close of this.agentWatchers.values()) close()
    this.agentWatchers.clear()
    this.globalWatcher?.()
    this.globalWatcher = undefined
  }

  /** A removed room's team: its watcher, the cached agents, their statuses and the user's own changes to them. */
  forgetRoom(roomId: string) {
    void this.k.agentChanges.forgetRoom(roomId).catch(() => undefined)
    this.agentWatchers.get(roomId)?.()
    this.agentWatchers.delete(roomId)
    this.agentCache.delete(roomId)
    this.builtins.delete(roomId)
    this.listsTheo.delete(roomId)
    this.statuses.delete(roomId)
    this.shapes.delete(roomId)
  }

  onStatus(e: Extract<PushEvent, { type: 'agent.status' }>) {
    this.statuses.set(e.roomId, { ...(this.statuses.get(e.roomId) ?? {}), [e.agentId]: e.status })
    // A room's first review on `kernel-reviewer` started, so the renderer needs Theo's name for it now (KERNEL-553).
    if (e.agentId === KERNEL_REVIEWER && !this.listsTheo.has(e.roomId) && this.agentCache.has(e.roomId)) {
      const list = this.listed(e.roomId, this.agentsSync(e.roomId))
      if (this.listsTheo.has(e.roomId)) bus.push({ type: 'agents', roomId: e.roomId, agents: list })
    }
  }

  /**
   * The team as the renderer gets it. The renderer names each workspace's agent from this list, so while the room has a
   * workspace on `kernel-reviewer` it also holds Kernel's Theo, marked retired so no team view shows it. A review Theo ran
   * before KERNEL-553 keeps Theo's name, as Kernel's code reviews on that id do (KERNEL-553).
   */
  listed(roomId: string, list: AgentDef[]): AgentDef[] {
    const theo = this.builtins.get(roomId)?.theo
    const on = !!theo && !list.some((a) => a.id === KERNEL_REVIEWER) && this.store.workspaces(roomId).some((w) => w.agentId === KERNEL_REVIEWER)
    if (on) this.listsTheo.add(roomId)
    else this.listsTheo.delete(roomId)
    return on ? [...list, { ...theo, retired: true, reviewer: false, member: false }] : list
  }

  /**
   * Empty room: write a team into .claude/agents and seat it. Refuses a room that already has agents. The starter templates
   * seat starter files only: Kernel's own Rowan leads (KERNEL-397). The full team has Theo to review (KERNEL-553).
   */
  private async seedAgents(roomId: string, template: TeamTemplate): Promise<AgentDef[]> {
    const room = this.mustRoom(roomId)
    if ((await agentFiles(room.path)).length) throw new Error('This room already has agents.')
    if (template.kind === 'copy') {
      const from = this.mustRoom(template.fromRoomId)
      if (from.id === room.id) throw new Error('Pick a different room to copy from.')
      if (!(await copyAgentFiles(from.path, room.path))) throw new Error(`${from.name} has no agents to copy.`)
    } else {
      if (!this.o.starterDir) throw new Error('No starter team found. Add agent files to .claude/agents.')
      await seatStarterTeam(this.o.starterDir, room.path, template.kind === 'pair' ? ['kai'] : [...STARTER_IDS])
    }
    const list = await this.agents(roomId)
    bus.push({ type: 'agents', roomId, agents: this.listed(roomId, list) })
    for (const a of list) bus.push({ type: 'agent.status', roomId, agentId: a.id, status: room.paused ? 'paused' : 'idle' })
    return list
  }

  /** The room's team as Kernel resolves it now (KERNEL-397). Every caller reads the team through here or `agentsSync`. */
  async agents(roomId: string): Promise<AgentDef[]> {
    const r = await this.resolve(roomId)
    this.watchTeam(roomId)
    return r.agents
  }

  private async resolve(roomId: string, config?: TeamConfig): Promise<Resolved & { builtins: Builtins }> {
    const room = this.mustRoom(roomId)
    void this.askPlugins()
    const plugins = this.plugins
    const [files, repo] = await Promise.all([this.ownFiles(roomId, plugins), loadRepoSettings(room.path)])
    const builtins = await loadBuiltins(this.o.starterDir, files)
    // A config passed in is a choice being weighed, read as it is. The saved one gets the agents the user joined themselves.
    const resolved = resolveTeam({ files, config: config ?? await this.ownRoster(roomId, repo.team), builtins })
    if (config) return { ...resolved, builtins }
    // Only here does Kernel know who is signed in, so the pure `resolveTeam` leaves pinned models alone (KERNEL-550).
    const r = { ...resolved, agents: await this.flagPins(resolved.agents) }
    this.agentCache.set(roomId, r.agents)
    this.builtins.set(roomId, builtins)
    this.adoptLead(roomId, r.agents.find((a) => a.lead))
    this.report(roomId, r)
    // The plugin list came back while this ran, so the room reads it now.
    if (plugins !== this.plugins) this.reload(roomId, { quiet: true })
    return { ...r, builtins }
  }

  /**
   * Flags each agent whose file pins a model it can't run on (KERNEL-550): `model-unavailable` while the pin's provider is
   * signed out, `model-unknown` while it is signed in but doesn't offer the model (KERNEL-634). Only the providers the pins
   * name are asked, so a team without a pin starts neither CLI. When Kernel can't tell, it flags nothing.
   */
  private async flagPins(agents: AgentDef[]): Promise<AgentDef[]> {
    const pins = new Map(agents.flatMap((a) => { const pin = pinOf(a); return pin ? [[a.id, pin] as const] : [] }))
    if (!this.o.checkPins || !pins.size) return agents
    const providers = [...new Set([...pins.values()].map((p) => p.provider))]
    const offered = new Map(await Promise.all(providers.map(async (p) => [p, await this.offered(p)] as const)))
    return agents.map((a) => {
      const pin = pins.get(a.id)
      const models = pin && offered.get(pin.provider)
      if (!pin || !models || (models !== 'signed-out' && models.includes(pin.model))) return a
      return { ...a, warnings: [...(a.warnings ?? []), { kind: models === 'signed-out' ? 'model-unavailable' as const : 'model-unknown' as const }] }
    })
  }

  /** The models a provider offers now: Claude's MODELS or Codex's `model/list`, `signed-out` while it is, undefined when Kernel can't tell. */
  private offered(provider: Provider): Promise<string[] | 'signed-out' | undefined> {
    const known = this.offers.get(provider)
    if (known) return known
    const ask = (async () => {
      const signedIn = await this.k.providers.signedIn(provider).catch(() => undefined)
      if (!signedIn) return signedIn === false ? 'signed-out' as const : undefined
      return (await this.k.providers.models(provider).catch(() => undefined))?.map((m) => m.id)
    })()
    this.offers.set(provider, ask)
    // Not knowing isn't kept, so the next read asks again.
    void ask.then((r) => { if (r === undefined && this.offers.get(provider) === ask) this.offers.delete(provider) })
    return ask
  }

  /** A provider's sign-in, executable or model list changed, so the next team read asks it again. Without one, every provider. */
  forgetOffers(provider?: Provider) {
    if (provider) this.offers.delete(provider)
    else this.offers.clear()
  }

  /** Whether Room setup asks for a roster, and who Kernel would pick, from every agent file whatever `[team] roster` says (KERNEL-465). */
  async rosterOf(roomId: string): Promise<RosterAdvice> {
    const team = (await loadRepoSettings(this.mustRoom(roomId).path)).team
    return adviseRoster((await this.resolve(roomId, { ...team, roster: undefined })).agents, team)
  }

  /** A new or restored agent joins the room's roster, when it has one, so it doesn't land off the team (KERNEL-465). */
  async joinRoster(roomId: string, agentId: string) {
    const room = this.mustRoom(roomId)
    const roster = (await loadRepoSettings(room.path)).team?.roster
    if (roster?.length && !roster.includes(agentId)) await saveTeamSettings(room.path, { roster: [...roster, agentId] })
  }

  /** The room's agent files with the user's own changes on this Mac laid over them, and the ones they retired left out (KERNEL-466). */
  private async ownFiles(roomId: string, plugins = this.plugins): Promise<AgentDef[]> {
    return this.k.agentChanges.apply(roomId, await this.loadTeamFiles(this.mustRoom(roomId).path, plugins))
  }

  /** `[team]` with the agents the user hired or brought back for themselves added to a roster, so it doesn't leave them out (KERNEL-466). */
  private async ownRoster(roomId: string, config: TeamConfig | undefined): Promise<TeamConfig | undefined> {
    if (!config?.roster?.length) return config
    const joined = (await this.k.agentChanges.joinedHere(roomId)).filter((id) => !config.roster!.includes(id))
    return joined.length ? { ...config, roster: [...config.roster, ...joined] } : config
  }

  /** Team's retired list: the files in .claude/retired-agents, and the agents the user retired on this Mac (KERNEL-466). */
  private async retiredOf(roomId: string): Promise<AgentDef[]> {
    const path = this.mustRoom(roomId).path
    const here = await this.k.agentChanges.retiredHere(roomId, await this.loadTeamFiles(path))
    const files = await loadAgents(path, { retired: true })
    return [...here, ...files.filter((a) => !here.some((h) => h.id === a.id))]
  }

  /** The room's own agent files, the user's personal ones and plugin agents, as `resolveTeam` takes them (KERNEL-463). */
  private async loadTeamFiles(repoPath: string, plugins = this.plugins): Promise<AgentDef[]> {
    const [project, personal] = await Promise.all([loadAgents(repoPath), loadPersonalAgents(this.home)])
    return teamFiles(project, personal, plugins)
  }

  /**
   * Asks Claude Code for its plugin agents, once a launch and only when the app passes `claudeAgents`. The first team reads
   * go ahead without them, and every room read so far reads again when the list comes back. A failed ask leaves no plugin
   * agents until the next launch, so a Mac without Claude Code doesn't start a process at every read.
   */
  private askPlugins(): Promise<void> {
    const ask = this.o.claudeAgents
    if (!ask) return Promise.resolve()
    return (this.pluginsAsk ??= (async () => {
      const list = await ask(this.home)
      this.plugins = await loadPluginAgents(list, this.home)
      if (this.stopped) return
      for (const roomId of this.agentCache.keys()) this.reload(roomId, { quiet: true })
      if (this.globalWatcher) this.pushGlobal()
    })().catch((err) => { this.plugins = []; console.warn('[kernel] could not list plugin agents', err) }))
  }

  /**
   * Settings, Agents with no room open (KERNEL-640): the agents that join every room, the user's own then plugin agents, read
   * as a room reads them. The first list waits for Claude Code's plugin list, and starts watching ~/.claude/agents so the page
   * hears of a change as `globalAgents`.
   */
  async globalAgents(): Promise<AgentDef[]> {
    await this.askPlugins()
    if (!this.globalWatcher && !this.stopped) this.globalWatcher = watchPersonalAgents(this.home, () => this.pushGlobal())
    return teamFiles([], await loadPersonalAgents(this.home), this.plugins)
  }

  private pushGlobal() {
    this.globalPush = this.globalPush.then(async () => {
      const agents = await this.globalAgents()
      const sent = JSON.stringify(agents)
      if (this.stopped || sent === this.globalSent) return
      this.globalSent = sent
      bus.push({ type: 'globalAgents', agents })
    }).catch(() => undefined)
  }

  /**
   * Settings, Agents > Save changes, with or without a room (KERNEL-640): rewrites a personal agent's file, then every room
   * Kernel has read reads its team again, so the edit shows there and the agent's next turn uses it.
   */
  private async saveGlobal(agentId: string, patch: AgentEdit): Promise<AgentDef> {
    const agent = (await this.globalAgents()).find((a) => a.id === agentId)
    if (!agent) throw new Error(`${agentId} is not in ~/.claude/agents.`)
    await this.k.agentChanges.editOwn(agent, patch)
    this.pushGlobal()
    await Promise.all([...this.agentCache.keys()].map((roomId) => this.reread(roomId).catch(() => undefined)))
    return (await this.globalAgents()).find((a) => a.id === agentId) ?? agent
  }

  /**
   * Settings, Agents > New agent with no room: the file goes to ~/.claude/agents, the page hears of it as `globalAgents`, and
   * every room Kernel has read reads its team again, as after a save.
   */
  private async hireGlobal(draft: AgentDraft, scope: AgentScope = 'me'): Promise<AgentDef> {
    const agent = await this.k.agentChanges.hireOwn(draft, scope)
    this.pushGlobal()
    await Promise.all([...this.agentCache.keys()].map((roomId) => this.reread(roomId).catch(() => undefined)))
    return (await this.globalAgents()).find((a) => a.id === agent.id) ?? agent
  }

  /** The Lead changed (Settings, a file, an upgrade): its workspace and chats go to the new Lead, which starts fresh (KERNEL-397). */
  private adoptLead(roomId: string, lead: AgentDef | undefined) {
    const moved = lead ? this.k.lead.adoptLeadWorkspace(roomId, lead.id) : undefined
    if (moved) this.sessions.restartIdle([moved.id])
  }

  /** `team.resolved` once per change in the room's shape, and one `agent.warning` per kind of warning it has. */
  private report(roomId: string, r: Resolved) {
    const files = r.agents.filter((a) => !a.builtIn)
    const kinds = [...new Set(r.agents.flatMap((a) => a.warnings ?? []).map((w) => w.kind))].sort()
    const event = {
      name: 'team.resolved' as const, leadFrom: r.leadFrom, reviewerFrom: r.reviewerFrom, agents: countRange(files.length),
      helpers: countRange(files.filter((a) => !a.lead && !a.member).length), warnings: countRange(r.agents.reduce((n, a) => n + (a.warnings?.length ?? 0), 0))
    }
    const shape = JSON.stringify([event, kinds])
    if (this.shapes.get(roomId) === shape) return
    this.shapes.set(roomId, shape)
    bus.track(event)
    for (const kind of kinds) bus.track({ name: 'agent.warning', kind })
  }

  /**
   * Files in .claude/agents or ~/.claude/agents, or the room's `[team]` settings, changed from outside Kernel (or from here).
   * Reload, and tell the renderer when the team differs.
   */
  private watchTeam(roomId: string) {
    if (this.agentWatchers.has(roomId)) return
    const room = this.store.room(roomId)
    if (!room) return
    const reload = () => this.reload(roomId)
    const files = watchAgents(room.path, reload)
    const personal = watchPersonalAgents(this.home, reload)
    const settings = watchTeamSettings(room.path, reload)
    this.agentWatchers.set(roomId, () => { files(); personal(); settings() })
  }

  /**
   * Reads the room's team again and tells the renderer when it differs. With `quiet`, plugin agents that show up don't walk
   * in: they were there all along, and Kernel only just heard of them.
   */
  private reload(roomId: string, o: { quiet?: boolean } = {}) {
    void this.reread(roomId, o).catch(() => undefined)
  }

  private async reread(roomId: string, o: { quiet?: boolean } = {}) {
    if (!this.store.room(roomId)) return
    const was = this.agentCache.get(roomId)
    const before = JSON.stringify(was)
    const list = await this.agents(roomId)
    if (JSON.stringify(list) === before) return
    this.changed(roomId, list, o.quiet ? [...(was ?? []), ...list.filter((a) => a.origin === 'plugin' && !was?.some((w) => w.id === a.id))] : was)
  }

  /** The team changed: the renderer hears, and agents whose definition changed start fresh at their next turn. */
  private changed(roomId: string, list: AgentDef[], was?: AgentDef[]) {
    this.announceTeam(roomId, list, was)
    const before = new Map((was ?? []).map((a) => [a.id, JSON.stringify(a)]))
    const moved = new Set(list.filter((a) => before.has(a.id) && before.get(a.id) !== JSON.stringify(a)).map((a) => a.id))
    const open = this.store.workspaces(roomId).filter((w) => w.status !== 'archived' && moved.has(w.agentId))
    if (open.length) this.sessions.restartIdle(open.map((w) => w.id))
  }

  /** `was` is the team before the change: whoever is new walks in. Leave it out to announce no one. */
  announceTeam(roomId: string, list: AgentDef[], was?: AgentDef[]) {
    const had = new Set((was ?? list).map((a) => a.id))
    const room = this.mustRoom(roomId)
    const known = this.statuses.get(roomId) ?? {}
    bus.push({ type: 'agents', roomId, agents: this.listed(roomId, list) })
    for (const a of list) {
      if (known[a.id]) continue
      bus.push({ type: 'agent.status', roomId, agentId: a.id, status: room.paused ? 'paused' : 'idle' })
      // A new agent file, from create_agent, New agent or a file added outside Kernel, walks in from the door (FloorHired.png).
      // Kernel's own Rowan has no file to come from.
      if (!a.retired && !a.builtIn && !had.has(a.id)) bus.activity({ kind: 'agent.joined', roomId, agentId: a.id, text: 'joined from', object: a.file })
    }
  }

  /**
   * AgentProfile > Save changes. For me, the next turn uses the new model, effort and tools, and the repo's file stays as it is.
   * For the team, a pull request changes the file and the agent stays as it is until that merges (KERNEL-466).
   */
  private async saveAgentEdit(roomId: string, agentId: string, patch: AgentEdit, scope: AgentScope = 'me'): Promise<AgentDef & { pr?: AgentChangePr }> {
    const was = this.agentCache.get(roomId)
    const agent = (await this.agents(roomId)).find((a) => a.id === agentId) ?? this.agentOf(roomId, agentId)
    if (agent?.builtIn) throw new Error("This is Kernel's own agent. Customize it to edit a copy in .claude/agents.")
    if (!agent) throw new Error(`${agentId} is not in .claude/agents.`)
    const pr = await this.k.agentChanges.edit(roomId, agent, patch, scope)
    if (pr) return { ...agent, pr }
    const list = await this.agents(roomId)
    this.changed(roomId, list, was)
    return list.find((a) => a.id === agentId) ?? agent
  }

  /**
   * New agent > Create agent. For me, the file goes to ~/.claude/agents and the agent takes a desk (the next free one, or the end
   * of `room.desks`). For the team, a pull request adds it to .claude/agents, and it joins once that merges (KERNEL-466).
   */
  private async hireFromDraft(roomId: string, draft: AgentDraft, scope: AgentScope = 'me'): Promise<AgentDef & { pr?: AgentChangePr }> {
    const room = this.mustRoom(roomId)
    const was = this.agentCache.get(roomId) ?? await this.agents(roomId)
    const { agent, pr } = await this.k.agentChanges.hire(roomId, draft, scope)
    if (pr) return { ...agent, pr }
    if (room.desks && !room.desks.includes(agent.id)) await this.k.rooms.updateRoom(roomId, { desks: [...room.desks, agent.id] })
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list, was)
    return list.find((a) => a.id === agent.id) ?? agent
  }

  /**
   * Retire: the agent leaves the team on this Mac, and for the team a pull request moves its file to .claude/retired-agents
   * (D-003, KERNEL-466). Open workspaces go to `handoffTo`, else the Lead, and a retired reviewer's reviews to whoever reviews
   * next, else Kernel's code review (KERNEL-553), and the desk frees up. A turn already running keeps its own copy of the
   * agent and finishes. The Lead cannot be retired, because nobody would plan, and Kernel's own Rowan has no file.
   */
  private async retire(roomId: string, agentId: string, handoffTo?: string, scope: AgentScope = 'me'): Promise<AgentChangePr | undefined> {
    const room = this.mustRoom(roomId)
    const team = await this.agents(roomId)
    const agent = team.find((a) => a.id === agentId)
    if (!agent) throw new Error(`${agentId} is not on this team.`)
    if (agent.builtIn) throw new Error(`${agent.name} is Kernel's own Lead. Pick another one in Settings, ${room.name}, Agents instead.`)
    if (agent.lead) throw new Error(`${agent.name} leads this room. Pick another Lead in Settings, ${room.name}, Agents first.`)
    const pr = await this.k.agentChanges.retire(roomId, agent, scope)
    const list = await this.agents(roomId)
    const chosen = list.find((a) => a.id === (handoffTo ?? '') && a.id !== agentId)
    const reviewer = isReviewer(agent) ? list.find(isReviewer)?.id ?? KERNEL_REVIEWER : undefined
    const lead = list.find((a) => a.lead)?.id
    for (const ws of this.store.workspaces(roomId)) {
      const heir = chosen?.id ?? (ws.reviewOf && reviewer ? reviewer : lead)
      if (ws.agentId === agentId && ws.status !== 'archived' && heir) this.saveWs({ ...ws, agentId: heir })
    }
    if (room.desks?.includes(agentId)) await this.k.rooms.updateRoom(roomId, { desks: room.desks.filter((d) => d !== agentId) })
    const statuses = this.statuses.get(roomId)
    if (statuses) delete statuses[agentId]
    this.announceTeam(roomId, list, team)
    bus.activity({ kind: 'agent.retired', roomId, agentId, actor: 'you', text: 'retired', object: agent.name })
    return pr
  }

  /**
   * Settings, Agents and Room setup: who leads, who reviews and who takes tasks (KERNEL-397). The change goes to `[team]` in
   * the shared settings.toml, holding only what differs from what Kernel works out from the files, so a team that agrees
   * with Kernel writes nothing. `members` and `helpers` may list every agent; only the exceptions are kept. `roster` keeps
   * the agents it lists that have a file (KERNEL-465).
   */
  private async setTeam(roomId: string, patch: TeamPatch, from?: 'setup' | 'settings'): Promise<AgentDef[]> {
    const room = this.mustRoom(roomId)
    const [files, repo] = await Promise.all([this.ownFiles(roomId), loadRepoSettings(room.path)])
    const ids = new Set(files.map((a) => a.id))
    const want: TeamConfig = { ...repo.team }
    for (const [k, v] of Object.entries(patch) as [keyof TeamConfig, TeamPatch[keyof TeamConfig]][]) {
      if (v === undefined) continue
      if (v === null) delete want[k]
      else (want as Record<string, unknown>)[k] = v
    }
    if (want.lead && want.lead !== KERNEL_LEAD && !ids.has(want.lead)) throw new Error(`${want.lead} is not on this team.`)
    if (want.reviewer && want.reviewer !== KERNEL_REVIEWER && want.reviewer !== NO_REVIEWER && !ids.has(want.reviewer)) throw new Error(`${want.reviewer} is not on this team.`)
    if (want.reviewer && want.reviewer === want.lead) throw new Error("The Lead can't also review. Pick another reviewer.")
    // A teammate's open work would run as the Lead's, with the Lead's tools and none of its updates.
    const busy = want.lead && want.lead !== repo.team?.lead ? this.store.workspaces(roomId).filter((w) => w.agentId === want.lead && !w.lead && w.status !== 'archived').length : 0
    if (busy) throw new Error(`${files.find((a) => a.id === want.lead)?.name ?? want.lead} has ${busy === 1 ? 'an open workspace' : `${busy} open workspaces`}. Archive ${busy === 1 ? 'it' : 'them'} first, or pick another Lead.`)
    want.roster = want.roster && [...new Set(want.roster)].filter((id) => ids.has(id))
    // An agent the roster leaves off can't keep its open work: those workspaces would have no agent to run. A Lead's own
    // workspace goes to the new Lead.
    if (want.roster?.length) {
      const kept = new Set((await this.resolve(roomId, want)).agents.map((a) => a.id))
      const open = (id: string) => this.store.workspaces(roomId).some((w) => w.agentId === id && !w.lead && w.status !== 'archived')
      const left = files.filter((a) => !kept.has(a.id) && open(a.id)).map((a) => a.name)
      const who = left.length > 1 ? `${left.slice(0, -1).join(', ')} and ${left[left.length - 1]}` : left[0]
      if (left.length) throw new Error(`${who} ${left.length === 1 ? 'has' : 'have'} open work. Archive it first, or keep ${left.length === 1 ? who : 'them'} on the team.`)
    }
    // A choice Kernel would make anyway is left out, so the file only holds what the team decided.
    if (want.lead && (await this.resolve(roomId, { ...want, lead: undefined })).agents.find((a) => a.lead)?.id === want.lead) delete want.lead
    // With no reviewer agent, Kernel's code review runs (KERNEL-553), so `none` is a choice and `kernel-reviewer` isn't.
    if (want.reviewer && ((await this.resolve(roomId, { ...want, reviewer: undefined })).agents.find((a) => a.reviewer)?.id ?? KERNEL_REVIEWER) === want.reviewer) delete want.reviewer
    const byDefault = (id: string) => { const a = files.find((f) => f.id === id); return !!a && takesTasksByDefault(a) }
    want.members = want.members?.filter((id) => ids.has(id) && !byDefault(id))
    want.helpers = want.helpers?.filter((id) => ids.has(id) && byDefault(id))
    const next: TeamPatch = {}
    for (const k of ['lead', 'reviewer', 'members', 'helpers', 'roster'] as const) {
      const value = Array.isArray(want[k]) && !(want[k] as string[]).length ? undefined : want[k]
      if (JSON.stringify(value ?? null) !== JSON.stringify(repo.team?.[k] ?? null)) (next as Record<string, unknown>)[k] = value ?? null
    }
    if (Object.keys(next).length) await saveTeamSettings(room.path, next)
    // A roster the user picks is the team they want here, over the agents they joined for themselves before (KERNEL-466).
    if ('roster' in next) await this.k.agentChanges.clearJoined(roomId)
    if (from === 'setup') bus.track({ name: 'setup.team_review', choice: Object.keys(next).length ? 'changed' : 'kept' })
    const was = this.agentCache.get(roomId)
    const list = await this.agents(roomId)
    this.changed(roomId, list, was)
    return list
  }

  /**
   * Customize on Kernel's Rowan's profile: Rowan becomes a file in .claude/agents the user can edit, named `rowan.md` when
   * free (KERNEL-397). The copy keeps the built-in's instructions and leaves its model to Settings, Models as before. `[team]`
   * and the open workspaces follow it. Theo is a starter now, added from Team, so Kernel's Theo has nothing to customize
   * (KERNEL-553).
   */
  private async customize(roomId: string, agentId: string): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    const agent = this.agentOf(roomId, agentId) ?? (await this.agents(roomId)).find((a) => a.id === agentId)
    if (!agent?.builtIn) throw new Error(`${agent?.name ?? agentId} already has a file in .claude/agents.`)
    if (agent.builtIn !== 'lead') throw new Error("Only Kernel's Rowan can be customized. Theo is a starter agent now, so add Theo from Team.")
    if (!this.o.starterDir) throw new Error("Kernel's own agents aren't available in this build.")
    // A personal agent's name counts too, so the copy doesn't hide it in this room.
    const files = await this.loadTeamFiles(room.path)
    const free = async (id: string) => !files.some((a) => a.id === id) && !(await readFile(join(room.path, '.claude', 'agents', `${id}.md`)).then(() => true, () => false))
    const names = ['rowan', 'lead', 'rowan-lead']
    let id: string | undefined
    for (const n of names) if (await free(n)) { id = n; break }
    if (!id) throw new Error(`.claude/agents already has ${names.map((n) => `${n}.md`).join(', ')}. Rename one first.`)
    const src = await readFile(builtinFile(this.o.starterDir), 'utf8')
    const end = src.indexOf('\n---', 3)
    const head = src.slice(0, end).replace(/^name:.*$/m, `name: ${id}`).replace(/^model:.*\n/m, '')
    const text = `${head}\n---\n${agent.prompt.trim()}\n`
    const was = await this.agents(roomId)
    await createAgent(room.path, { id, text })
    const repo = await loadRepoSettings(room.path)
    if (repo.team?.lead === agent.id) await saveTeamSettings(room.path, { lead: id })
    const moved = this.store.workspaces(roomId).filter((w) => w.agentId === agent.id && w.status !== 'archived')
    for (const ws of moved) this.saveWs({ ...ws, agentId: id })
    if (moved.length) this.sessions.restartIdle(moved.map((w) => w.id))
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list, was)
    bus.track({ name: 'builtin.customized', which: 'lead' })
    const def = list.find((a) => a.id === id)
    if (!def) throw new Error(`${id} could not be added.`)
    return def
  }

  /** Team > Add a starter agent: one of Kernel's starter teammates joins a team that already has agents (KERNEL-397). */
  private async addStarter(roomId: string, id: string): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    if (!this.o.starterDir) throw new Error('No starter team found. Add agent files to .claude/agents.')
    if (!(STARTER_IDS as readonly string[]).includes(id)) throw new Error(`${id} isn't one of Kernel's starter agents.`)
    const was = await this.agents(roomId)
    if (was.some((a) => a.id === id)) throw new Error(`${was.find((a) => a.id === id)!.name} is already on the team.`)
    if (!(await seatStarterTeam(this.o.starterDir, room.path, [id])).length) throw new Error(`.claude/agents already has a file named ${id}.md.`)
    await this.joinRoster(roomId, id)
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list, was)
    const def = list.find((a) => a.id === id)
    if (!def) throw new Error(`${id} could not be added.`)
    return def
  }

  /**
   * Restore: an agent retired on this Mac comes back. A file the team retired comes back to ~/.claude/agents for me, or in a
   * pull request for the team (KERNEL-466). Either way it joins the room's roster, when it has one (KERNEL-465).
   */
  private async restore(roomId: string, agentId: string, scope: AgentScope = 'me'): Promise<AgentDef & { pr?: AgentChangePr }> {
    const { agent, pr } = await this.k.agentChanges.restore(roomId, agentId, scope)
    if (agent && pr) return { ...agent, pr }
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list)
    const def = list.find((a) => a.id === agentId) ?? agent
    if (!def) throw new Error(`${agentId} could not be restored.`)
    return def
  }

  agentsSync(roomId: string) { return this.agentCache.get(roomId) ?? [] }

  /**
   * The agent a workspace runs, by id: the team's, else Kernel's own Rowan for a workspace made while it led, so it keeps its
   * prompt and tools after the room gets its own (KERNEL-397). `kernel-reviewer` is Kernel's Theo, so a review workspace from
   * before KERNEL-553 still runs Theo and shows Theo's name. A review chat Kernel started runs its kind's prompt instead (KERNEL-549).
   */
  agentOf(roomId: string, agentId: string): AgentDef | undefined {
    const b = this.builtins.get(roomId)
    return this.agentsSync(roomId).find((a) => a.id === agentId) ?? (agentId === KERNEL_LEAD ? b?.lead : agentId === KERNEL_REVIEWER ? b?.theo : undefined)
  }

  /** The room's reviewer, if it has one. */
  reviewerOf(roomId: string): AgentDef | undefined { return this.agentsSync(roomId).find(isReviewer) }
  /**
   * The Lead's own workspace, archived or not (KERNEL-353): History and comments on an archived Lead's files ask too. The shared
   * `isLeadWorkspace` is the same check for open workspaces.
   */
  isLeadWorkspace(ws: Workspace) { return !!ws.lead && !!this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.lead }

  statusOf(roomId: string): Record<string, AgentStatus> {
    const s = { ...(this.statuses.get(roomId) ?? {}) }
    for (const a of this.agentsSync(roomId)) s[a.id] ??= this.mustRoom(roomId).paused ? 'paused' : 'idle'
    return s
  }

  /** The model an agent's chats start on: its file's `model:`, else its role's default. */
  modelFor(agent: AgentDef): string { return this.pickFor(agent).model }

  /**
   * The provider, model and effort an agent's chats start on (KERNEL-406). The agent file's `model:` pins the agent, on its
   * `provider:` or the one the model id belongs to, with the file's `effort:` or the role's. Otherwise it is the role's
   * default from Settings, Models and effort, with the file's `effort:` when it has one.
   */
  pickFor(agent: AgentDef): RoleModel { return rolePick(agent, this.roleModel(agent)) }

  /** The role Settings, Models and effort reads for this agent. */
  roleOf(agent: AgentDef): Role {
    if (agent.lead) return 'lead'
    if (isReviewer(agent)) return 'reviewer'
    if (/qa/i.test(agent.role)) return 'qa'
    return 'engineers'
  }

  /**
   * The role Settings, Models reads for a chat in `ws` run by `agent` (feat-compact-window-per-role-with-plan). A review
   * workspace is the reviewer's whichever agent runs it, as `Reviews.modelFor` has it. A chat with no agent is the Lead's in
   * a Lead workspace and an engineer's anywhere else.
   */
  roleFor(ws: Workspace, agent: AgentDef | undefined): Role {
    if (ws.reviewOf) return 'reviewer'
    if (agent) return this.roleOf(agent)
    return ws.lead ? 'lead' : 'engineers'
  }

  /** The agent's role default from Settings, Models and effort (KERNEL-406). */
  roleModel(agent: AgentDef): RoleModel { return this.settings.models.roles[this.roleOf(agent)] }

  handlers() {
    return {
      'agents.seed': async ({ roomId, template }) => this.listed(roomId, await this.seedAgents(roomId, template)),
      'agents.list': async ({ roomId, retired }) => (retired ? this.retiredOf(roomId) : this.listed(roomId, await this.agents(roomId))),
      'agents.save': async ({ roomId, agentId, patch, scope }) => this.saveAgentEdit(roomId, agentId, patch, scope),
      'agents.draft': async ({ description, name, model }) => draftAgent({ description, name, model }),
      'agents.create': async ({ roomId, draft, scope }) => (roomId ? this.hireFromDraft(roomId, draft, scope) : this.hireGlobal(draft, scope)),
      'agents.retire': async ({ roomId, agentId, handoffTo, scope }) => {
        const pr = await this.retire(roomId, agentId, handoffTo, scope)
        return { ok: true as const, ...(pr ? { pr } : {}) }
      },
      'agents.restore': async ({ roomId, agentId, scope }) => this.restore(roomId, agentId, scope),
      'agents.status': async ({ roomId }) => this.statusOf(roomId),
      'agents.setTeam': async ({ roomId, team, from }) => this.listed(roomId, await this.setTeam(roomId, team, from)),
      'agents.customize': async ({ roomId, agentId }) => this.customize(roomId, agentId),
      'agents.addStarter': async ({ roomId, id }) => this.addStarter(roomId, id),
      'agents.listGlobal': async () => this.globalAgents(),
      'agents.saveGlobal': async ({ agentId, patch }) => this.saveGlobal(agentId, patch)
    } satisfies Partial<Handlers>
  }
}
