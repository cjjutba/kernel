import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { AgentDef, AgentDraft, AgentEdit, AgentStatus, Role, RoleModel, TeamConfig, TeamPatch, TeamTemplate, Workspace } from '@shared/types'
import { providerOf } from '@shared/providers'
import { MODELS } from '@shared/types'
import { isReviewer, KERNEL_LEAD, KERNEL_REVIEWER, NO_REVIEWER } from '@shared/team'
import { countRange } from '@shared/telemetry'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { createAgent, draftAgent, loadAgents, loadPersonalAgents, restoreAgent, retireAgent, teamFiles, updateAgent, watchAgents, watchPersonalAgents, watchTeamSettings } from '../services/agents'
import { canOpenPr } from '../services/agentTools'
import { builtinFile, loadBuiltins, type Builtins } from '../services/builtins'
import { loadPluginAgents } from '../services/pluginAgents'
import { agentFiles, copyAgentFiles, seatStarterTeam, STARTER_IDS } from '../services/rooms'
import { loadRepoSettings, saveTeamSettings } from '../services/settings'
import { resolveTeam, type Resolved } from '../services/teamResolve'
import { Feature } from './feature'

/** A model id that is Codex's (gpt-6-astra, o4-mini, codex-mini), for an agent file without `provider:` (KERNEL-406). */
const CODEX_MODEL = /^(gpt-|o\d|codex-)/i

/**
 * Why Kernel won't edit or retire an agent whose file isn't in the room's repo, or nothing when it is (KERNEL-463). A personal
 * file is every room's, and a plugin's files are Claude Code's to change.
 */
function notInRepo(a: AgentDef, change: 'edit' | 'retire'): string | undefined {
  if (a.origin === 'personal') return `${a.name}'s file is in ~/.claude/agents, which every room shares. ${change === 'edit' ? 'Edit it there.' : `Move it out of that folder to retire ${a.name} in every room.`}`
  if (a.origin !== 'plugin') return undefined
  const plugin = a.id.slice(0, a.id.indexOf(':'))
  return change === 'edit' ? `${a.name} comes from the ${plugin} plugin, and Kernel doesn't change a plugin's files.` : `${a.name} comes from the ${plugin} plugin. Turn the plugin off in Claude Code to remove it.`
}

/**
 * Each room's team: the agent files in .claude/agents, their statuses, and hiring and retiring (KERNEL-326). Who leads,
 * who reviews and who takes tasks come from the files, the room's `[team]` settings and Kernel's own Rowan and Theo
 * (KERNEL-397). The user's own agents in ~/.claude/agents and Claude Code's plugin agents join every room (KERNEL-463).
 */
export class Team extends Feature {
  readonly agentCache = new Map<string, AgentDef[]>()
  /** Each room's built-in Lead and reviewer as last resolved, so a workspace on one still finds its agent once the room has its own. */
  private builtins = new Map<string, Builtins>()
  private agentWatchers = new Map<string, () => void>()
  readonly statuses = new Map<string, Record<string, AgentStatus>>()
  /** The shape last reported for each room, so `team.resolved` goes out once per change. */
  private shapes = new Map<string, string>()
  /** Plugin agents, as Claude Code listed them once this launch (KERNEL-463). Unset until the list comes back. */
  private plugins?: AgentDef[]
  private pluginsAsked = false

  stop() {
    for (const close of this.agentWatchers.values()) close()
    this.agentWatchers.clear()
  }

  /** A removed room's team: its watcher, the cached agents and their statuses. */
  forgetRoom(roomId: string) {
    this.agentWatchers.get(roomId)?.()
    this.agentWatchers.delete(roomId)
    this.agentCache.delete(roomId)
    this.builtins.delete(roomId)
    this.statuses.delete(roomId)
    this.shapes.delete(roomId)
  }

  onStatus(e: Extract<PushEvent, { type: 'agent.status' }>) {
    this.statuses.set(e.roomId, { ...(this.statuses.get(e.roomId) ?? {}), [e.agentId]: e.status })
  }

  /**
   * Empty room: write a team into .claude/agents and seat it. Refuses a room that already has agents. The starter templates
   * seat teammates only: Kernel's own Rowan and Theo lead and review (KERNEL-397).
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
    bus.push({ type: 'agents', roomId, agents: list })
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
    this.askPlugins()
    const plugins = this.plugins
    const [files, repo] = await Promise.all([this.loadTeamFiles(room.path, plugins), loadRepoSettings(room.path)])
    const builtins = await loadBuiltins(this.o.starterDir, files)
    const r = resolveTeam({ files, config: config ?? repo.team, builtins })
    if (config) return { ...r, builtins }
    this.agentCache.set(roomId, r.agents)
    this.builtins.set(roomId, builtins)
    this.adoptLead(roomId, r.agents.find((a) => a.lead))
    this.report(roomId, r)
    // The plugin list came back while this ran, so the room reads it now.
    if (plugins !== this.plugins) this.reload(roomId, { quiet: true })
    return { ...r, builtins }
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
  private askPlugins() {
    const ask = this.o.claudeAgents
    if (!ask || this.pluginsAsked) return
    this.pluginsAsked = true
    void (async () => {
      const list = await ask(this.home)
      this.plugins = await loadPluginAgents(list, this.home)
      if (!this.stopped) for (const roomId of this.agentCache.keys()) this.reload(roomId, { quiet: true })
    })().catch((err) => { this.plugins = []; console.warn('[kernel] could not list plugin agents', err) })
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
    void (async () => {
      if (!this.store.room(roomId)) return
      const was = this.agentCache.get(roomId)
      const before = JSON.stringify(was)
      const list = await this.agents(roomId)
      if (JSON.stringify(list) === before) return
      this.changed(roomId, list, o.quiet ? [...(was ?? []), ...list.filter((a) => a.origin === 'plugin' && !was?.some((w) => w.id === a.id))] : was)
    })().catch(() => undefined)
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
    bus.push({ type: 'agents', roomId, agents: list })
    for (const a of list) {
      if (known[a.id]) continue
      bus.push({ type: 'agent.status', roomId, agentId: a.id, status: room.paused ? 'paused' : 'idle' })
      // A new agent file, from hire_agent, New agent or a file added outside Kernel, walks in from the door (FloorHired.png).
      // Kernel's own Rowan and Theo have no file to come from.
      if (!a.retired && !a.builtIn && !had.has(a.id)) bus.activity({ kind: 'agent.joined', roomId, agentId: a.id, text: 'joined from', object: a.file })
    }
  }

  /** AgentProfile > Save changes. Rewrites the file and reloads the room's team, so the next turn uses the new model, effort and tools. */
  private async saveAgentEdit(roomId: string, agentId: string, patch: AgentEdit): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    const agent = this.agentOf(roomId, agentId)
    if (agent?.builtIn) throw new Error("This is Kernel's own agent. Customize it to edit a copy in .claude/agents.")
    const elsewhere = agent && notInRepo(agent, 'edit')
    if (elsewhere) throw new Error(elsewhere)
    const was = this.agentCache.get(roomId)
    const saved = await updateAgent(room.path, agentId, patch)
    const list = await this.agents(roomId)
    this.changed(roomId, list, was)
    return list.find((a) => a.id === saved.id) ?? saved
  }

  /** New agent > Create agent. The file joins .claude/agents and the agent takes a desk (the next free one, or the end of `room.desks`). */
  private async hireFromDraft(roomId: string, draft: AgentDraft): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    const was = this.agentCache.get(roomId) ?? await this.agents(roomId)
    const def = await createAgent(room.path, draft)
    if (room.desks && !room.desks.includes(def.id)) await this.k.rooms.updateRoom(roomId, { desks: [...room.desks, def.id] })
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list, was)
    return list.find((a) => a.id === def.id) ?? def
  }

  /**
   * Retire: the file moves to .claude/retired-agents (D-003), open workspaces go to `handoffTo`, else the Lead, and a retired
   * reviewer's reviews to whoever reviews next, and the desk frees up. A turn already running keeps its own copy of
   * the agent and finishes. The Lead cannot be retired, because nobody would plan, and Kernel's own agents have no file.
   */
  private async retire(roomId: string, agentId: string, handoffTo?: string): Promise<void> {
    const room = this.mustRoom(roomId)
    const team = await this.agents(roomId)
    const agent = team.find((a) => a.id === agentId)
    if (!agent) throw new Error(`${agentId} is not on this team.`)
    if (agent.builtIn) throw new Error(`${agent.name} is Kernel's own ${agent.lead ? 'Lead' : 'reviewer'}. Pick another one in Settings, Agents instead.`)
    if (agent.lead) throw new Error(`${agent.name} leads this room. Pick another Lead in Settings, Agents first.`)
    const elsewhere = notInRepo(agent, 'retire')
    if (elsewhere) throw new Error(elsewhere)
    await retireAgent(room.path, agentId)
    const list = await this.agents(roomId)
    const chosen = list.find((a) => a.id === (handoffTo ?? '') && a.id !== agentId)
    const reviewer = isReviewer(agent) ? list.find(isReviewer) : undefined
    const lead = list.find((a) => a.lead)
    for (const ws of this.store.workspaces(roomId)) {
      const heir = chosen ?? (ws.reviewOf && reviewer ? reviewer : lead)
      if (ws.agentId === agentId && ws.status !== 'archived' && heir) this.saveWs({ ...ws, agentId: heir.id })
    }
    if (room.desks?.includes(agentId)) await this.k.rooms.updateRoom(roomId, { desks: room.desks.filter((d) => d !== agentId) })
    const statuses = this.statuses.get(roomId)
    if (statuses) delete statuses[agentId]
    this.announceTeam(roomId, list, team)
    bus.activity({ kind: 'agent.retired', roomId, agentId, actor: 'you', text: 'retired', object: agent.name })
  }

  /**
   * Settings, Agents and Room setup: who leads, who reviews and who takes tasks (KERNEL-397). The change goes to `[team]` in
   * the shared settings.toml, holding only what differs from what Kernel works out from the files, so a team that agrees
   * with Kernel writes nothing. `members` and `helpers` may list every agent; only the exceptions are kept.
   */
  private async setTeam(roomId: string, patch: TeamPatch, from?: 'setup' | 'settings'): Promise<AgentDef[]> {
    const room = this.mustRoom(roomId)
    const [files, repo] = await Promise.all([this.loadTeamFiles(room.path), loadRepoSettings(room.path)])
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
    // A choice Kernel would make anyway is left out, so the file only holds what the team decided.
    if (want.lead && (await this.resolve(roomId, { ...want, lead: undefined })).agents.find((a) => a.lead)?.id === want.lead) delete want.lead
    if (want.reviewer && ((await this.resolve(roomId, { ...want, reviewer: undefined })).agents.find((a) => a.reviewer)?.id ?? NO_REVIEWER) === want.reviewer) delete want.reviewer
    const opens = (id: string) => { const a = files.find((f) => f.id === id); return canOpenPr(a?.tools, a?.disallowedTools) }
    want.members = want.members?.filter((id) => ids.has(id) && !opens(id))
    want.helpers = want.helpers?.filter((id) => ids.has(id) && opens(id))
    const next: TeamPatch = {}
    for (const k of ['lead', 'reviewer', 'members', 'helpers'] as const) {
      const value = Array.isArray(want[k]) && !(want[k] as string[]).length ? undefined : want[k]
      if (JSON.stringify(value ?? null) !== JSON.stringify(repo.team?.[k] ?? null)) (next as Record<string, unknown>)[k] = value ?? null
    }
    if (Object.keys(next).length) await saveTeamSettings(room.path, next)
    if (from === 'setup') bus.track({ name: 'setup.team_review', choice: Object.keys(next).length ? 'changed' : 'kept' })
    const was = this.agentCache.get(roomId)
    const list = await this.agents(roomId)
    this.changed(roomId, list, was)
    return list
  }

  /**
   * Customize on a built-in agent's profile: Kernel's Rowan or Theo becomes a file in .claude/agents the user can edit, named
   * `rowan.md` or `theo.md` when free (KERNEL-397). The copy keeps the built-in's instructions and leaves its model to
   * Settings, Models as before. `[team]` and the open workspaces follow it.
   */
  private async customize(roomId: string, agentId: string): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    const agent = this.agentOf(roomId, agentId) ?? (await this.agents(roomId)).find((a) => a.id === agentId)
    if (!agent?.builtIn) throw new Error(`${agent?.name ?? agentId} already has a file in .claude/agents.`)
    if (!this.o.starterDir) throw new Error("Kernel's own agents aren't available in this build.")
    const which = agent.builtIn
    // A personal agent's name counts too, so the copy doesn't hide it in this room.
    const files = await this.loadTeamFiles(room.path)
    const free = async (id: string) => !files.some((a) => a.id === id) && !(await readFile(join(room.path, '.claude', 'agents', `${id}.md`)).then(() => true, () => false))
    const names = which === 'lead' ? ['rowan', 'lead', 'rowan-lead'] : ['theo', 'reviewer', 'theo-reviewer']
    let id: string | undefined
    for (const n of names) if (await free(n)) { id = n; break }
    if (!id) throw new Error(`.claude/agents already has ${names.map((n) => `${n}.md`).join(', ')}. Rename one first.`)
    const src = await readFile(builtinFile(this.o.starterDir, which), 'utf8')
    const end = src.indexOf('\n---', 3)
    const head = src.slice(0, end).replace(/^name:.*$/m, `name: ${id}`).replace(/^model:.*\n/m, '')
    const text = `${head}\n---\n${agent.prompt.trim()}\n`
    const was = await this.agents(roomId)
    await createAgent(room.path, { id, name: id, description: agent.description, model: '', tools: agent.tools ?? [], text, file: `.claude/agents/${id}.md` })
    const key = which === 'lead' ? 'lead' : 'reviewer'
    const repo = await loadRepoSettings(room.path)
    if (repo.team?.[key] === agent.id) await saveTeamSettings(room.path, { [key]: id })
    const moved = this.store.workspaces(roomId).filter((w) => w.agentId === agent.id && w.status !== 'archived')
    for (const ws of moved) this.saveWs({ ...ws, agentId: id })
    if (moved.length) this.sessions.restartIdle(moved.map((w) => w.id))
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list, was)
    bus.track({ name: 'builtin.customized', which })
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
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list, was)
    const def = list.find((a) => a.id === id)
    if (!def) throw new Error(`${id} could not be added.`)
    return def
  }

  private async restore(roomId: string, agentId: string): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    await restoreAgent(room.path, agentId)
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list)
    const def = list.find((a) => a.id === agentId)
    if (!def) throw new Error(`${agentId} could not be restored.`)
    return def
  }

  agentsSync(roomId: string) { return this.agentCache.get(roomId) ?? [] }

  /**
   * The agent a workspace runs, by id: the team's, else Kernel's own Rowan or Theo for a workspace made while they led or
   * reviewed, so it keeps its prompt and tools after the room gets its own (KERNEL-397).
   */
  agentOf(roomId: string, agentId: string): AgentDef | undefined {
    const b = this.builtins.get(roomId)
    return this.agentsSync(roomId).find((a) => a.id === agentId) ?? (agentId === KERNEL_LEAD ? b?.lead : agentId === KERNEL_REVIEWER ? b?.reviewer : undefined)
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
  pickFor(agent: AgentDef): RoleModel {
    const role = this.roleModel(agent)
    const pinned = agent.model?.trim()
    const alias = pinned && MODELS.find((x) => x.id === pinned || x.id.split('-')[1] === pinned.toLowerCase())?.id
    // `inherit`, or a model Kernel can't place, follows the role, as it always did.
    const provider = agent.provider ?? (alias || pinned?.startsWith('claude-') ? 'claude' : pinned && CODEX_MODEL.test(pinned) ? providerOf(pinned) : undefined)
    if (!pinned || !provider) return { ...role, effort: agent.effort ?? role.effort }
    return { provider, model: provider === 'claude' ? alias || pinned : pinned, effort: agent.effort ?? role.effort }
  }

  /** The role Settings, Models and effort reads for this agent. */
  roleOf(agent: AgentDef): Role {
    if (agent.lead) return 'lead'
    if (isReviewer(agent)) return 'reviewer'
    if (/qa/i.test(agent.role)) return 'qa'
    return 'engineers'
  }

  /** The agent's role default from Settings, Models and effort (KERNEL-406). */
  roleModel(agent: AgentDef): RoleModel { return this.settings.models.roles[this.roleOf(agent)] }

  handlers() {
    return {
      'agents.seed': async ({ roomId, template }) => this.seedAgents(roomId, template),
      'agents.list': async ({ roomId, retired }) => (retired ? loadAgents(this.mustRoom(roomId).path, { retired: true }) : this.agents(roomId)),
      'agents.save': async ({ roomId, agentId, patch }) => this.saveAgentEdit(roomId, agentId, patch),
      'agents.draft': async ({ description, name, model }) => draftAgent({ description, name, model }),
      'agents.create': async ({ roomId, draft }) => this.hireFromDraft(roomId, draft),
      'agents.retire': async ({ roomId, agentId, handoffTo }) => { await this.retire(roomId, agentId, handoffTo); return { ok: true } },
      'agents.restore': async ({ roomId, agentId }) => this.restore(roomId, agentId),
      'agents.status': async ({ roomId }) => this.statusOf(roomId),
      'agents.setTeam': async ({ roomId, team, from }) => this.setTeam(roomId, team, from),
      'agents.customize': async ({ roomId, agentId }) => this.customize(roomId, agentId),
      'agents.addStarter': async ({ roomId, id }) => this.addStarter(roomId, id)
    } satisfies Partial<Handlers>
  }
}
