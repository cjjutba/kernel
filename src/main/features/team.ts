import type { PushEvent } from '@shared/ipc'
import type { AgentDef, AgentDraft, AgentEdit, AgentStatus, ModelId, TeamTemplate, Workspace } from '@shared/types'
import { MODELS } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { createAgent, draftAgent, loadAgents, restoreAgent, retireAgent, updateAgent, watchAgents } from '../services/agents'
import { agentFiles, copyAgentFiles, seatStarterTeam } from '../services/rooms'
import { Feature } from './feature'

/** Each room's team: the agent files in .claude/agents, their statuses, and hiring and retiring (KERNEL-326). */
export class Team extends Feature {
  readonly agentCache = new Map<string, AgentDef[]>()
  private agentWatchers = new Map<string, () => void>()
  readonly statuses = new Map<string, Record<string, AgentStatus>>()

  stop() {
    for (const close of this.agentWatchers.values()) close()
    this.agentWatchers.clear()
  }

  /** A removed room's team: its watcher, the cached agents and their statuses. */
  forgetRoom(roomId: string) {
    this.agentWatchers.get(roomId)?.()
    this.agentWatchers.delete(roomId)
    this.agentCache.delete(roomId)
    this.statuses.delete(roomId)
  }

  onStatus(e: Extract<PushEvent, { type: 'agent.status' }>) {
    this.statuses.set(e.roomId, { ...(this.statuses.get(e.roomId) ?? {}), [e.agentId]: e.status })
  }

  /** Empty room: write a team into .claude/agents and seat it. Refuses a room that already has agents. */
  private async seedAgents(roomId: string, template: TeamTemplate): Promise<AgentDef[]> {
    const room = this.mustRoom(roomId)
    if ((await agentFiles(room.path)).length) throw new Error('This room already has agents.')
    if (template.kind === 'copy') {
      const from = this.mustRoom(template.fromRoomId)
      if (from.id === room.id) throw new Error('Pick a different room to copy from.')
      if (!(await copyAgentFiles(from.path, room.path))) throw new Error(`${from.name} has no agents to copy.`)
    } else {
      if (!this.o.starterDir) throw new Error('No starter team found. Add agent files to .claude/agents.')
      await seatStarterTeam(this.o.starterDir, room.path, template.kind === 'pair' ? ['kai'] : ['kai', 'noor', 'ivy', 'theo'])
    }
    const list = await this.agents(roomId)
    bus.push({ type: 'agents', roomId, agents: list })
    for (const a of list) bus.push({ type: 'agent.status', roomId, agentId: a.id, status: room.paused ? 'paused' : 'idle' })
    return list
  }

  async agents(roomId: string): Promise<AgentDef[]> {
    const room = this.mustRoom(roomId)
    const list = await loadAgents(room.path)
    this.agentCache.set(roomId, list)
    this.watchTeam(roomId)
    return list
  }

  /** Files in .claude/agents changed from outside Kernel (or from here). Reload, and tell the renderer when the team differs. */
  private watchTeam(roomId: string) {
    if (this.agentWatchers.has(roomId)) return
    const room = this.store.room(roomId)
    if (!room) return
    this.agentWatchers.set(roomId, watchAgents(room.path, () => {
      void (async () => {
        if (!this.store.room(roomId)) return
        const was = this.agentCache.get(roomId)
        const before = JSON.stringify(was)
        const list = await this.agents(roomId)
        if (JSON.stringify(list) !== before) this.announceTeam(roomId, list, was)
      })().catch(() => undefined)
    }))
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
      if (!a.retired && !had.has(a.id)) bus.activity({ kind: 'agent.joined', roomId, agentId: a.id, text: 'joined from', object: a.file })
    }
  }

  /** AgentProfile > Save changes. Rewrites the file and reloads the room's team, so the next turn uses the new model, effort and tools. */
  private async saveAgentEdit(roomId: string, agentId: string, patch: AgentEdit): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    const saved = await updateAgent(room.path, agentId, patch)
    this.announceTeam(roomId, await this.agents(roomId))
    return saved
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
   * Retire: the file moves to .claude/retired-agents (D-003), open workspaces go to `handoffTo` or the Lead, and the desk frees up.
   * A turn already running keeps its own copy of the agent and finishes. The Lead cannot be retired, because nobody would plan.
   */
  private async retire(roomId: string, agentId: string, handoffTo?: string): Promise<void> {
    const room = this.mustRoom(roomId)
    const team = await this.agents(roomId)
    const agent = team.find((a) => a.id === agentId)
    if (!agent) throw new Error(`${agentId} is not on this team.`)
    if (agent.lead) throw new Error(`${agent.name} leads this room. Mark another agent with "lead: true" first.`)
    const heir = team.find((a) => a.id === (handoffTo ?? '') && a.id !== agentId) ?? team.find((a) => a.lead)
    await retireAgent(room.path, agentId)
    for (const ws of this.store.workspaces(roomId)) {
      if (ws.agentId === agentId && ws.status !== 'archived' && heir) this.saveWs({ ...ws, agentId: heir.id })
    }
    if (room.desks?.includes(agentId)) await this.k.rooms.updateRoom(roomId, { desks: room.desks.filter((d) => d !== agentId) })
    const statuses = this.statuses.get(roomId)
    if (statuses) delete statuses[agentId]
    const list = await this.agents(roomId)
    bus.push({ type: 'agents', roomId, agents: list })
    bus.activity({ kind: 'agent.retired', roomId, agentId, actor: 'you', text: 'retired', object: agent.name })
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
   * The Lead's own workspace, archived or not (KERNEL-353): History and comments on an archived Lead's files ask too. The shared
   * `isLeadWorkspace` is the same check for open workspaces.
   */
  isLeadWorkspace(ws: Workspace) { return !!ws.lead && !!this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.lead }

  statusOf(roomId: string): Record<string, AgentStatus> {
    const s = { ...(this.statuses.get(roomId) ?? {}) }
    for (const a of this.agentsSync(roomId)) s[a.id] ??= this.mustRoom(roomId).paused ? 'paused' : 'idle'
    return s
  }

  modelFor(agent: AgentDef): ModelId {
    const m = this.settings.models
    if (agent.model?.startsWith('claude-')) return agent.model as ModelId
    const alias = MODELS.find((x) => x.id.split('-')[1] === agent.model?.toLowerCase())
    if (alias) return alias.id
    if (agent.lead) return m.lead
    if (/qa/i.test(agent.role)) return m.qa
    if (/review/i.test(agent.role)) return m.reviewer
    return m.engineers
  }

  handlers() {
    return {
      'agents.seed': async ({ roomId, template }) => this.seedAgents(roomId, template),
      'agents.list': async ({ roomId, retired }) => (retired ? loadAgents(this.mustRoom(roomId).path, { retired: true }) : this.agents(roomId)),
      'agents.save': async ({ roomId, agentId, patch }) => this.saveAgentEdit(roomId, agentId, patch),
      'agents.draft': async ({ description, name, model }) => draftAgent({ description, name, model }),
      'agents.create': async ({ roomId, draft }) => this.hireFromDraft(roomId, draft),
      'agents.retire': async ({ roomId, agentId, handoffTo }) => { await this.retire(roomId, agentId, handoffTo); return { ok: true } },
      'agents.restore': async ({ roomId, agentId }) => this.restore(roomId, agentId),
      'agents.status': async ({ roomId }) => this.statusOf(roomId)
    } satisfies Partial<Handlers>
  }
}
