import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import type { Server } from 'node:http'
import type { AgentDef, AgentStatus, Chat, Room, Workspace, WorkspaceMode, ModelId, Effort } from '@shared/types'
import type { Channel, KernelApi } from '@shared/ipc'
import { Store, newId } from './db'
import { bus } from './bus'
import { loadAgents, saveAgent } from './services/agents'
import { Approvals } from './services/approvals'
import { Sessions } from './services/sessions'
import { kernelMcpServer } from './services/kernelMcp'
import { startHookServer } from './services/hookServer'
import { installHooks } from './services/hooksInstaller'
import { runPreflight } from './services/preflight'
import { loadAppSettings, loadRepoSettings, saveAppSettings, type AppSettings } from './services/settings'
import { branchName, changedFiles, createWorktree, currentBranch, defaultBranch, diffText, freeBranch, mergeBase, remoteRepo, removeWorktree, slugify, snapshotBaseline } from './services/worktrees'
import { copyLocalFiles, freePort, runScript, stopAllScripts, stopScript } from './services/scripts'
import { prMerge, prReady, prReopen, prStateOf, prView } from './services/github'

type CoreChannel = Exclude<Channel, `system.${string}`>
export type Handlers = { [C in CoreChannel]: (req: KernelApi[C]['req']) => Promise<KernelApi[C]['res']> }

export class Kernel {
  readonly store: Store
  readonly approvals: Approvals
  readonly sessions: Sessions
  settings!: AppSettings
  private hookServer?: Server
  private agentCache = new Map<string, AgentDef[]>()
  private statuses = new Map<string, Record<string, AgentStatus>>()
  private prTimer?: NodeJS.Timeout

  constructor(private o: { dataDir: string; home?: string; claudeSettingsFile?: string }) {
    this.store = new Store(join(o.dataDir, 'kernel.db'))
    this.approvals = new Approvals(this.store)
    this.sessions = new Sessions({
      store: this.store,
      approvals: this.approvals,
      settings: () => this.settings,
      agentFor: (ws) => this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId),
      mcpFor: (ws, agent) => (agent?.lead ? { kernel: this.leadTools(ws.roomId, agent) } : undefined),
      onTurnDone: (ws) => { if (ws.prState !== 'none') void this.refreshPr(ws.id).catch(() => undefined) }
    })
    bus.on('activity', (e) => this.store.saveActivity(e))
    bus.on('push', (e) => {
      if (e.type === 'agent.status') this.statuses.set(e.roomId, { ...(this.statuses.get(e.roomId) ?? {}), [e.agentId]: e.status })
    })
  }

  private get home() { return this.o.home ?? homedir() }
  private get settingsFile() { return join(this.o.dataDir, 'settings.json') }

  async start() {
    this.settings = await loadAppSettings(this.settingsFile, this.home)
    await saveAppSettings(this.settingsFile, this.settings)
    try {
      this.hookServer = await startHookServer({
        port: this.settings.hookPort,
        approvals: this.approvals,
        approvalTimeoutMs: this.settings.permissions.approvalTimeoutSec * 1000,
        isManaged: (id) => this.sessions.isManaged(id),
        resolve: (cwd) => this.resolveCwd(cwd)
      })
    } catch { /* port taken: preflight reports it */ }
    this.prTimer = setInterval(() => void this.pollPrs(), 45_000)
  }

  async stop() {
    clearInterval(this.prTimer)
    this.sessions.stopAll()
    stopAllScripts()
    await new Promise<void>((r) => (this.hookServer ? this.hookServer.close(() => r()) : r()))
    this.store.db.close()
  }

  // ---------- rooms and agents

  async addRoom(path: string, name?: string): Promise<Room> {
    const existing = this.store.rooms().find((r) => r.path === path)
    if (existing) return existing
    const room: Room = { id: newId(), name: name ?? basename(path), path, repo: await remoteRepo(path), defaultBranch: await defaultBranch(path).catch(() => 'main'), paused: false, createdAt: Date.now() }
    this.store.saveRoom(room)
    await this.agents(room.id)
    return room
  }

  async agents(roomId: string): Promise<AgentDef[]> {
    const room = this.mustRoom(roomId)
    const list = await loadAgents(room.path)
    this.agentCache.set(roomId, list)
    return list
  }

  private agentsSync(roomId: string) { return this.agentCache.get(roomId) ?? [] }

  statusOf(roomId: string): Record<string, AgentStatus> {
    const s = { ...(this.statuses.get(roomId) ?? {}) }
    for (const a of this.agentsSync(roomId)) s[a.id] ??= this.mustRoom(roomId).paused ? 'paused' : 'idle'
    return s
  }

  // ---------- workspaces

  async createWorkspace(roomId: string, o: { prompt: string; agentId?: string; mode?: WorkspaceMode; baseRef?: string; title?: string; model?: ModelId; effort?: Effort; plan?: boolean }): Promise<Workspace> {
    const room = this.mustRoom(roomId)
    const repo = await loadRepoSettings(room.path)
    const s = this.settings
    const agents = await this.agents(roomId)
    const agent = agents.find((a) => a.id === o.agentId) ?? agents.find((a) => a.lead) ?? agents[0]
    if (!agent) throw new Error('This room has no agents. Add one to .claude/agents first.')
    const mode = o.mode ?? repo.workspace.mode ?? s.workspace.mode
    const title = o.title ?? o.prompt.split(/\s+/).slice(0, 6).join(' ')
    const baseRef = o.baseRef ?? repo.workspace.baseRef ?? s.workspace.baseRef
    const taken = new Set(this.store.workspaces().filter((w) => w.status !== 'archived').map((w) => w.port))
    const port = await freePort(4300, taken)

    let path: string, branch: string, baselineRef: string | undefined
    if (mode === 'worktree') {
      branch = await freeBranch(room.path, branchName(repo.workspace.branchPattern ?? s.workspace.branchPattern, { slug: slugify(title) }))
      path = await createWorktree({ repo: room.path, root: join(s.worktreeRoot, slugify(room.name)), branch, baseRef, fetch: baseRef.startsWith('origin/') })
      await copyLocalFiles(room.path, path, repo.files.copy)
    } else {
      if (s.workspace.oneCurrentBranchPerRoom && this.store.workspaces(roomId).some((w) => w.mode === 'current' && w.status !== 'archived' && w.agentId !== agent.id))
        throw new Error('Another workspace is already working on the current branch in this room.')
      path = room.path
      branch = await currentBranch(room.path)
      if (s.workspace.baselineCurrentBranch) baselineRef = (await snapshotBaseline(room.path)).ref
    }

    const ws: Workspace = { id: newId(), roomId, name: slugify(title), branch, baseRef, path, mode, agentId: agent.id, port, status: 'setup', baselineRef, prState: 'none', createdAt: Date.now() }
    this.store.saveWorkspace(ws)
    bus.push({ type: 'workspace', workspace: ws })
    bus.activity({ kind: 'workspace.created', roomId, workspaceId: ws.id, agentId: agent.id, text: 'started', object: ws.name })

    const chat = this.newChat(ws.id, title, { model: o.model ?? this.modelFor(agent), effort: o.effort ?? s.models.effort, plan: o.plan ?? (agent.lead && s.models.leadPlanMode) })
    const ready = await this.runSetup(ws, room, repo.scripts.setup)
    if (!ready) return this.saveWs({ ...ws, status: 'failed' })
    const done = this.saveWs({ ...ws, status: 'ready' })
    if (s.scripts.runAfterSetup && repo.scripts.run) void runScript({ workspaceId: ws.id, kind: 'run', script: repo.scripts.run, cwd: path, port, root: room.path })
    await this.sessions.send(chat.id, [{ type: 'text', text: o.prompt }])
    return done
  }

  private async runSetup(ws: Workspace, room: Room, script?: string): Promise<boolean> {
    if (!script || !this.settings.scripts.setupOnCreate) return true
    const code = await runScript({ workspaceId: ws.id, kind: 'setup', script, cwd: ws.path, port: ws.port, root: room.path })
    return code === 0
  }

  async archiveWorkspace(id: string, deleteBranch?: boolean) {
    const ws = this.mustWs(id)
    const room = this.mustRoom(ws.roomId)
    this.sessions.stopWorkspace(id)
    stopScript(id, 'run')
    const repo = await loadRepoSettings(room.path)
    if (repo.scripts.archive && this.settings.scripts.archiveOnArchive) await runScript({ workspaceId: id, kind: 'archive', script: repo.scripts.archive, cwd: ws.path, port: ws.port, root: room.path })
    if (ws.mode === 'worktree') await removeWorktree(room.path, ws.path, { force: true, deleteBranch: (deleteBranch ?? this.settings.workspace.deleteBranchOnArchive) ? ws.branch : undefined })
    this.saveWs({ ...ws, status: 'archived' })
    bus.activity({ kind: 'workspace.archived', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'archived', object: ws.name })
  }

  async changes(id: string) {
    const ws = this.mustWs(id)
    if (ws.mode === 'current') return changedFiles(ws.path, ws.baselineRef ?? 'HEAD')
    return changedFiles(ws.path, await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef))
  }

  async diff(id: string, file?: string) {
    const ws = this.mustWs(id)
    const since = ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)
    return diffText(ws.path, since, file)
  }

  // ---------- chats

  newChat(workspaceId: string, title: string, o: { model: ModelId; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal' }): Chat {
    return this.store.saveChat({ id: newId(), workspaceId, title, kind: o.kind ?? 'chat', model: o.model, effort: o.effort, plan: o.plan, createdAt: Date.now() })
  }

  private modelFor(agent: AgentDef): ModelId {
    const m = this.settings.models
    if (agent.model?.startsWith('claude-')) return agent.model as ModelId
    if (agent.model === 'opus') return 'claude-opus-5-5'
    if (agent.model === 'haiku') return 'claude-haiku-4-5-20251001'
    if (agent.lead) return m.lead
    if (/qa/i.test(agent.role)) return m.qa
    if (/review/i.test(agent.role)) return m.reviewer
    return m.engineers
  }

  /** The Lead lives in a room-level workspace on the main checkout. Floor briefs go there. */
  async leadChat(roomId: string): Promise<Chat> {
    const agents = await this.agents(roomId)
    const lead = agents.find((a) => a.lead)
    if (!lead) throw new Error('No lead agent. Mark one agent with "lead: true".')
    let ws = this.store.workspaces(roomId).find((w) => w.agentId === lead.id && w.mode === 'current' && w.status !== 'archived')
    if (!ws) {
      const room = this.mustRoom(roomId)
      ws = this.saveWs({ id: newId(), roomId, name: 'lead', branch: await currentBranch(room.path), baseRef: room.defaultBranch, path: room.path, mode: 'current', agentId: lead.id, port: await freePort(4300), status: 'ready', prState: 'none', createdAt: Date.now() })
    }
    return this.store.chats(ws.id)[0] ?? this.newChat(ws.id, 'Lead', { model: this.modelFor(lead), effort: this.settings.models.effort, plan: this.settings.models.leadPlanMode })
  }

  private leadTools(roomId: string, lead: AgentDef) {
    return kernelMcpServer({
      roomId, lead,
      agents: () => this.agents(roomId),
      workspaces: () => this.store.workspaces(roomId),
      createWorkspace: (o) => this.createWorkspace(roomId, { ...o, mode: o.mode }),
      messageWorkspace: async (workspaceId, text) => { const chat = this.store.chats(workspaceId)[0]; if (chat) await this.sessions.send(chat.id, [{ type: 'text', text }]) },
      askUser: async (o) => (await this.approvals.request({ kind: o.kind, source: 'sdk', roomId, agentId: lead.id, title: o.title, detail: o.detail, options: o.options })).decision,
      hireAgent: async (a) => { const file = await saveAgent(this.mustRoom(roomId).path, a); await this.agents(roomId); return file }
    })
  }

  // ---------- pull requests

  async createPr(id: string, draft = false) {
    const ws = this.mustWs(id)
    const chat = this.store.chats(id)[0]
    if (!chat) throw new Error('This workspace has no chat.')
    const ask = this.settings.pr.createInstructions + (draft || this.settings.pr.draft ? '\n5. Open it as a draft.' : '')
    await this.sessions.send(chat.id, [{ type: 'file', name: 'create-pr.md', text: ask }])
    return this.saveWs({ ...ws, prState: 'checks' })
  }

  /** One button, three situations: conflicts, failing checks, or review comments. Each sends its own instructions. */
  async resolveConflicts(id: string) {
    const ws = this.mustWs(id)
    const chat = this.store.chats(id)[0]
    if (!chat) return
    const byState: Partial<Record<Workspace['prState'], [string, string]>> = {
      conflict: ['resolve-conflicts.md', this.settings.pr.resolveInstructions],
      cifail: ['fix-checks.md', '# Fix failing checks\n1. Run `gh pr checks` and read every failure.\n2. Reproduce locally, fix the cause, not the test.\n3. Run the full suite, push, and summarize the fix.'],
      changes: ['address-review.md', '# Address review\n1. Read the review with `gh pr view --comments`.\n2. Make each requested change.\n3. Push, then reply to each comment with what changed.']
    }
    const [name, text] = byState[ws.prState] ?? byState.conflict!
    await this.sessions.send(chat.id, [{ type: 'file', name, text }])
    this.saveWs({ ...ws, prState: 'checks' })
  }

  async refreshPr(id: string): Promise<Workspace> {
    const ws = this.mustWs(id)
    const pr = await prView(ws.path, ws.branch)
    const next = this.saveWs({ ...ws, prNumber: pr?.number ?? ws.prNumber, prUrl: pr?.url ?? ws.prUrl, prState: pr ? prStateOf(pr) : ws.prState === 'checks' ? 'checks' : 'none' })
    if (next.prState !== ws.prState) { bus.push({ type: 'pr', workspaceId: id, state: next.prState }); bus.activity({ kind: 'pr.changed', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: `PR is ${next.prState}`, object: pr ? `#${pr.number}` : undefined }) }
    return next
  }

  async mergePr(id: string) {
    const ws = this.mustWs(id)
    await prMerge(ws.path, this.settings.pr.mergeMethod)
    return this.refreshPr(id)
  }

  async readyPr(id: string) { await prReady(this.mustWs(id).path); return this.refreshPr(id) }
  async reopenPr(id: string) { await prReopen(this.mustWs(id).path); return this.refreshPr(id) }

  private async pollPrs() {
    for (const ws of this.store.workspaces()) if (ws.status !== 'archived' && !['none', 'merged', 'closed'].includes(ws.prState)) await this.refreshPr(ws.id).catch(() => undefined)
  }

  // ---------- helpers

  private resolveCwd(cwd: string) {
    const ws = this.store.workspaces().filter((w) => w.status !== 'archived').sort((a, b) => b.path.length - a.path.length).find((w) => cwd === w.path || cwd.startsWith(w.path + '/'))
    if (ws) return { roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId }
    const room = this.store.rooms().find((r) => cwd === r.path || cwd.startsWith(r.path + '/'))
    return room ? { roomId: room.id } : {}
  }

  private saveWs(ws: Workspace) { this.store.saveWorkspace(ws); bus.push({ type: 'workspace', workspace: ws }); return ws }
  private mustRoom(id: string) { const r = this.store.room(id); if (!r) throw new Error(`Unknown room ${id}`); return r }
  private mustWs(id: string) { const w = this.store.workspace(id); if (!w) throw new Error(`Unknown workspace ${id}`); return w }

  /** Every IPC channel, in one map. The preload exposes these to the renderer as window.kernel.invoke. */
  handlers(): Handlers {
    return {
      'preflight.run': async () => runPreflight({ hookPort: this.settings.hookPort, hookServerUp: !!this.hookServer?.listening }),
      'hooks.install': async ({ port }) => ({ path: this.claudeSettings, events: await installHooks(this.claudeSettings, port, this.settings.permissions.approvalTimeoutSec) }),
      'rooms.list': async () => this.store.rooms(),
      'rooms.add': async ({ path, name }) => this.addRoom(path, name),
      'rooms.setPaused': async ({ roomId, paused }) => {
        const room = this.store.saveRoom({ ...this.mustRoom(roomId), paused })
        if (paused) for (const ws of this.store.workspaces(roomId)) for (const c of this.store.chats(ws.id)) await this.sessions.interrupt(c.id)
        for (const a of this.agentsSync(roomId)) bus.push({ type: 'agent.status', roomId, agentId: a.id, status: paused ? 'paused' : 'idle' })
        return room
      },
      'rooms.brief': async ({ roomId, text, agentId }) => {
        let chat: Chat
        if (agentId) {
          const ws = this.store.workspaces(roomId).find((w) => w.agentId === agentId && w.status !== 'archived')
          if (!ws) throw new Error('That agent has no open workspace. Brief the Lead instead.')
          chat = this.store.chats(ws.id)[0]
        } else chat = await this.leadChat(roomId)
        await this.sessions.send(chat.id, [{ type: 'text', text }])
        return { chatId: chat.id, workspaceId: chat.workspaceId }
      },
      'agents.list': async ({ roomId }) => this.agents(roomId),
      'agents.status': async ({ roomId }) => this.statusOf(roomId),
      'workspaces.list': async ({ roomId }) => this.store.workspaces(roomId),
      'workspaces.create': async ({ roomId, ...o }) => this.createWorkspace(roomId, o),
      'workspaces.archive': async ({ workspaceId, deleteBranch }) => { await this.archiveWorkspace(workspaceId, deleteBranch); return { ok: true } },
      'workspaces.changes': async ({ workspaceId }) => this.changes(workspaceId),
      'workspaces.diff': async ({ workspaceId, file }) => this.diff(workspaceId, file),
      'chats.list': async ({ workspaceId }) => this.store.chats(workspaceId),
      'chats.create': async ({ workspaceId, kind }) => { const first = this.store.chats(workspaceId)[0]; return this.newChat(workspaceId, kind === 'terminal' ? 'Terminal (claude)' : 'New chat', { model: first?.model ?? this.settings.models.engineers, effort: first?.effort ?? this.settings.models.effort, plan: false, kind }) },
      'chats.items': async ({ chatId }) => this.store.items(chatId),
      'chats.send': async ({ chatId, parts }) => this.sessions.send(chatId, parts),
      'chats.interrupt': async ({ chatId }) => { await this.sessions.interrupt(chatId); return { ok: true } },
      'chats.configure': async ({ chatId, ...patch }) => this.sessions.configure(chatId, patch),
      'approvals.list': async ({ roomId }) => this.store.approvals({ roomId }),
      'approvals.decide': async ({ id, decision }) => { const a = this.approvals.decide(id, decision); if (!a) throw new Error('This request already timed out or was answered.'); return a },
      'pr.create': async ({ workspaceId, draft }) => this.createPr(workspaceId, draft),
      'pr.refresh': async ({ workspaceId }) => this.refreshPr(workspaceId),
      'pr.merge': async ({ workspaceId }) => this.mergePr(workspaceId),
      'pr.resolve': async ({ workspaceId }) => { await this.resolveConflicts(workspaceId); return { ok: true } },
      'pr.ready': async ({ workspaceId }) => this.readyPr(workspaceId),
      'pr.reopen': async ({ workspaceId }) => this.reopenPr(workspaceId),
      'scripts.run': async ({ workspaceId, kind }) => {
        const ws = this.mustWs(workspaceId); const room = this.mustRoom(ws.roomId); const repo = await loadRepoSettings(room.path)
        const script = repo.scripts[kind]
        if (!script) throw new Error(`No ${kind} script in .kernel/settings.toml`)
        void runScript({ workspaceId, kind, script, cwd: ws.path, port: ws.port, root: room.path })
        return { ok: true }
      },
      'scripts.stop': async ({ workspaceId }) => { stopScript(workspaceId, 'run'); return { ok: true } },
      'activity.recent': async ({ roomId, limit }) => this.store.activity(roomId, limit),
      'usage.get': async () => this.sessions.usage()
    }
  }

  private get claudeSettings() { return this.o.claudeSettingsFile ?? join(this.home, '.claude', 'settings.json') }
}
