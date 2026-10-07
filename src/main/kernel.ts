import { basename, join } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Server } from 'node:http'
import type { AgentDef, AgentStatus, Chat, HookStatus, NewRoomRequest, Room, RoomSetupStep, Workspace, WorkspaceMode, ModelId, Effort } from '@shared/types'
import { NotImplemented, type Channel, type KernelApi, type PushEvent } from '@shared/ipc'
import { Store, newId } from './db'
import { bus } from './bus'
import { loadAgents, saveAgent } from './services/agents'
import { Approvals } from './services/approvals'
import { Sessions } from './services/sessions'
import { kernelMcpServer } from './services/kernelMcp'
import { startHookServer } from './services/hookServer'
import { hookStatus, installHooks, KERNEL_HOOK_EVENTS } from './services/hooksInstaller'
import { nextFreePort, portBusy, runPreflight } from './services/preflight'
import { loadAppSettings, loadRepoSettings, saveAppSettings, type AppSettings } from './services/settings'
import { branchName, changedFiles, createWorktree, currentBranch, defaultBranch, diffText, freeBranch, mergeBase, remoteRepo, removeWorktree, slugify, snapshotBaseline } from './services/worktrees'
import { copyLocalFiles, freePort, runScript, stopAllScripts, stopScript } from './services/scripts'
import { agentFiles, assertFreeFolder, cloneRepo, copyTemplate, ensureRepoSettings, expandHome, initGit, inspectFolder, installCommand, listRepos, recentFolders, seatStarterTeam, tildify } from './services/rooms'
import { exec } from './services/exec'
import { discoverSkills, listTree, readWorkspaceFile, searchFiles } from './services/files'
import { commitHunks, listHunks } from './services/hunks'
import { prMerge, prReady, prReopen, prStateOf, prView } from './services/github'

type CoreChannel = Exclude<Channel, `system.${string}`>
export type Handlers = { [C in CoreChannel]: (req: KernelApi[C]['req']) => Promise<KernelApi[C]['res']> }

/**
 * Channels no lane has built yet, and the issue that builds each. They reject with NotImplemented.
 * A lane that builds one deletes its line here and adds the handler to the map in `handlers()`.
 */
export const UNBUILT = {
  'rooms.overlaps': 'KERNEL-24', 'rooms.resolveOverlap': 'KERNEL-24',
  'agents.save': 'KERNEL-19', 'agents.draft': 'KERNEL-19', 'agents.create': 'KERNEL-19', 'agents.retire': 'KERNEL-19', 'agents.restore': 'KERNEL-19',
  'agents.seed': 'KERNEL-22',
    'chats.rename': 'KERNEL-12', 'chats.close': 'KERNEL-12', 'chats.fork': 'KERNEL-12', 'terminal.write': 'KERNEL-12', 'terminal.resize': 'KERNEL-12',
  'checkpoints.list': 'KERNEL-13', 'checkpoints.revert': 'KERNEL-13',
  'pr.get': 'KERNEL-15', 'pr.continue': 'KERNEL-15',
  'git.branches': 'KERNEL-16', 'github.prs': 'KERNEL-16', 'issues.list': 'KERNEL-16',
  'notifications.list': 'KERNEL-17', 'notifications.read': 'KERNEL-17',
  'tasks.list': 'KERNEL-18',
  'lead.ask': 'KERNEL-21', 'workspaces.restore': 'KERNEL-21', 'account.get': 'KERNEL-21', 'account.signOut': 'KERNEL-21',
  'chats.restart': 'KERNEL-22',
  'workspaces.gitStatus': 'KERNEL-28', 'workspaces.discard': 'KERNEL-28', 'chats.compact': 'KERNEL-28', 'usage.notifyOnReset': 'KERNEL-28',
  'account.signIn': 'KERNEL-28', 'app.openTerminal': 'KERNEL-28',
  'settings.set': 'KERNEL-25', 'app.exportLogs': 'KERNEL-25',
  'settings.setRoom': 'KERNEL-26', 'mcp.list': 'KERNEL-26', 'integrations.list': 'KERNEL-26', 'integrations.connect': 'KERNEL-26',
  'update.get': 'KERNEL-30', 'update.check': 'KERNEL-30', 'update.install': 'KERNEL-30'
} as const satisfies Partial<Record<CoreChannel, `KERNEL-${number}`>>

type Unbuilt = keyof typeof UNBUILT

/** Handlers for every unbuilt channel, each rejecting with the issue that builds it. */
function unbuilt(): Pick<Handlers, Unbuilt> {
  const out: Record<string, () => Promise<never>> = {}
  for (const [channel, issue] of Object.entries(UNBUILT)) out[channel] = async () => { throw new NotImplemented(channel as Channel, issue) }
  return out as unknown as Pick<Handlers, Unbuilt>
}

export class Kernel {
  readonly store: Store
  readonly approvals: Approvals
  readonly sessions: Sessions
  settings!: AppSettings
  private hookServer?: Server
  private agentCache = new Map<string, AgentDef[]>()
  private statuses = new Map<string, Record<string, AgentStatus>>()
  private prTimer?: NodeJS.Timeout
  /** When each hook event last arrived from a real session. The test event is not counted. */
  private hookSeen = new Map<string, number>()
  private unlisten: () => void = () => undefined

  constructor(private o: { dataDir: string; home?: string; claudeSettingsFile?: string; starterDir?: string }) {
    this.store = new Store(join(o.dataDir, 'kernel.db'))
    this.approvals = new Approvals(this.store)
    this.sessions = new Sessions({
      store: this.store,
      approvals: this.approvals,
      settings: () => this.settings,
      agentFor: (ws) => this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId),
      mcpFor: (ws, agent) => (agent?.lead ? { kernel: this.leadTools(ws.roomId, agent) } : undefined),
      roomAllow: (roomId) => this.store.room(roomId)?.allow ?? [],
      allowInRoom: (roomId, rule) => {
        const room = this.store.room(roomId)
        if (room && !room.allow?.includes(rule)) this.store.saveRoom({ ...room, allow: [...(room.allow ?? []), rule] })
      },
      onTurnDone: (ws) => { if (ws.prState !== 'none') void this.refreshPr(ws.id).catch(() => undefined) }
    })
    const onActivity = (e: Parameters<Store['saveActivity']>[0]) => this.store.saveActivity(e)
    const onHook = (e: { hook_event_name: string }) => this.hookSeen.set(e.hook_event_name, Date.now())
    const onPush = (e: PushEvent) => {
      if (e.type === 'agent.status') this.statuses.set(e.roomId, { ...(this.statuses.get(e.roomId) ?? {}), [e.agentId]: e.status })
    }
    bus.on('activity', onActivity).on('hook', onHook).on('push', onPush)
    // A stopped kernel has a closed database. Leave the shared bus so a second kernel in the same process doesn't write to it.
    this.unlisten = () => { bus.off('activity', onActivity).off('hook', onHook).off('push', onPush) }
  }

  private get home() { return this.o.home ?? homedir() }
  private get settingsFile() { return join(this.o.dataDir, 'settings.json') }

  async start() {
    this.settings = await loadAppSettings(this.settingsFile, this.home)
    await saveAppSettings(this.settingsFile, this.settings)
    await this.listenHooks(this.settings.hookPort)
    this.prTimer = setInterval(() => void this.pollPrs(), 45_000)
  }

  /** Starts the hook server on `port`. A taken port is not fatal: preflight reports it and offers the next one. */
  private async listenHooks(port: number): Promise<boolean> {
    try {
      this.hookServer = await startHookServer({
        port,
        approvals: this.approvals,
        approvalTimeoutMs: this.settings.permissions.approvalTimeoutSec * 1000,
        isManaged: (id) => this.sessions.isManaged(id),
        resolve: (cwd) => this.resolveCwd(cwd)
      })
      return true
    } catch { return false }
  }

  /** Moves the hook server to `port`, saves it, and rewrites the hooks if they were installed. Returns the status after. */
  private async restartHooks(port: number): Promise<HookStatus> {
    // A busy new port must not take down the server that works. Check before closing.
    if (port !== this.settings.hookPort && (await portBusy(port))) throw new Error(`Port ${port} is in use. Pick another port and try again.`)
    const wasInstalled = (await hookStatus(this.claudeSettings).catch(() => [] as string[])).length > 0
    await new Promise<void>((r) => (this.hookServer?.listening ? this.hookServer.close(() => r()) : r()))
    this.hookServer = undefined
    if (!(await this.listenHooks(port))) throw new Error(`Port ${port} is in use. Pick another port and try again.`)
    if (port !== this.settings.hookPort) {
      this.settings = { ...this.settings, hookPort: port }
      await saveAppSettings(this.settingsFile, this.settings)
    }
    if (wasInstalled) await installHooks(this.claudeSettings, port, this.settings.permissions.approvalTimeoutSec)
    return this.hooksStatus()
  }

  private async hooksStatus(): Promise<HookStatus> {
    const installed = new Set(await hookStatus(this.claudeSettings).catch(() => [] as string[]))
    return {
      port: this.settings.hookPort,
      listening: !!this.hookServer?.listening,
      installed: KERNEL_HOOK_EVENTS.every((e) => installed.has(e)),
      events: KERNEL_HOOK_EVENTS.map((name) => ({ name, installed: installed.has(name), lastSeen: this.hookSeen.get(name) }))
    }
  }

  async stop() {
    this.unlisten()
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

  // ---------- new rooms

  /**
   * Creates the room's record and returns it at once. The slow part (clone, install, seating agents) runs behind it
   * and reports through `room.setup` push events, which RoomSetup.png draws.
   */
  async createRoom(req: NewRoomRequest): Promise<Room> {
    const name = req.name.trim()
    if (!name) throw new Error('Give the room a name.')
    let path: string
    if (req.source === 'folder') {
      path = expandHome(req.from, this.home)
      const info = await inspectFolder(path, this.home)
      if (!info.git && !req.initGit) throw new Error(`${tildify(path, this.home)} is not a git repository. Initialize git to use it.`)
    } else {
      path = expandHome(req.cloneTo ?? join(this.home, 'Projects', slugify(req.source === 'repo' ? basename(req.from) : name)), this.home)
      await assertFreeFolder(path, this.home)
    }
    const taken = this.store.rooms().find((r) => r.path === path)
    if (taken) throw new Error(`${tildify(path, this.home)} is already the room ${taken.name}.`)
    const room: Room = {
      id: newId(), name, desc: req.desc?.trim() || undefined, kind: req.source, path,
      repo: req.source === 'repo' ? req.from : undefined, defaultBranch: req.baseBranch || 'main', paused: false, createdAt: Date.now()
    }
    this.store.saveRoom(room)
    bus.push({ type: 'room', room })
    void this.setupRoom(room, req).catch(() => undefined)
    return room
  }

  /** The six steps of RoomSetup.png. A failed step records its error and the next ones still run, except when there is no checkout. */
  private async setupRoom(room: Room, req: NewRoomRequest) {
    const worktrees = join(this.settings.worktreeRoot, slugify(room.name))
    const steps: RoomSetupStep[] = [
      { id: 'clone', title: req.source === 'repo' ? `Clone ${req.from}` : req.source === 'scratch' ? `Copy ${req.from}` : 'Use your folder', detail: tildify(room.path, this.home), state: 'wait' },
      { id: 'worktrees', title: 'Create the worktree folder', detail: tildify(worktrees, this.home), state: 'wait' },
      { id: 'install', title: 'Install dependencies', detail: 'Checking the lockfile', state: 'wait' },
      { id: 'copy', title: 'Copy local files', detail: '', state: 'wait' },
      { id: 'hooks', title: 'Install hooks', detail: `${KERNEL_HOOK_EVENTS.length} events to localhost:${this.settings.hookPort}`, state: 'wait' },
      { id: 'agents', title: 'Seat agents', detail: '', state: 'wait' }
    ]
    const publish = () => bus.push({ type: 'room.setup', roomId: room.id, steps: steps.map((s) => ({ ...s })) })
    const update = (id: RoomSetupStep['id'], patch: Partial<RoomSetupStep>) => { Object.assign(steps.find((s) => s.id === id)!, patch); publish() }
    const step = async (id: RoomSetupStep['id'], fn: () => Promise<Partial<RoomSetupStep> | void>) => {
      const started = Date.now()
      update(id, { state: 'run', meta: 'running', error: undefined })
      try {
        const done = (await fn()) ?? {}
        update(id, { state: 'ok', meta: Date.now() - started >= 1500 ? `${Math.round((Date.now() - started) / 1000)}s` : undefined, ...done })
        return true
      } catch (e) {
        update(id, { state: 'fail', meta: undefined, error: (e as Error).message })
        return false
      }
    }
    publish()

    const checkedOut = await step('clone', async () => {
      if (req.source === 'repo') await cloneRepo(req.from, room.path)
      else if (req.source === 'scratch') await copyTemplate(req.from, room.path)
      else if (req.initGit && !(await inspectFolder(room.path, this.home)).git) await initGit(room.path)
      const next: Room = { ...room, repo: room.repo ?? (await remoteRepo(room.path)), defaultBranch: req.baseBranch || (await defaultBranch(room.path).catch(() => 'main')) }
      this.store.saveRoom(next)
      bus.push({ type: 'room', room: next })
    })
    if (!checkedOut) return

    await step('worktrees', async () => {
      await mkdir(worktrees, { recursive: true })
      await ensureRepoSettings(room.path)
    })
    await step('install', async () => {
      const { command, reason } = await installCommand(room.path)
      if (!command) return { detail: reason ?? 'Nothing to install' }
      update('install', { detail: command })
      const r = await exec('sh', ['-c', command], { cwd: room.path, timeoutMs: 600_000 })
      if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join('\n') || `${command} failed`)
    })
    await step('copy', async () => {
      const wanted = (await loadRepoSettings(room.path)).files.copy
      const present: string[] = []
      for (const f of wanted) if (await stat(join(room.path, f)).then(() => true, () => false)) present.push(f)
      return { detail: present.length ? present.join(', ') : 'No local files to copy' }
    })
    await step('hooks', async () => {
      const status = await this.hooksStatus()
      if (!status.installed) throw new Error('Kernel hooks are not in your Claude settings yet. Open Check hooks in the sidebar to install them.')
    })
    await step('agents', async () => {
      let files = await agentFiles(room.path)
      if (!files.length) {
        if (!this.o.starterDir) throw new Error('No starter team found. Add agent files to .claude/agents.')
        await seatStarterTeam(this.o.starterDir, room.path, req.team)
        files = await agentFiles(room.path)
      }
      const list = await this.agents(room.id)
      bus.push({ type: 'agents', roomId: room.id, agents: list })
      for (const a of list) bus.push({ type: 'agent.status', roomId: room.id, agentId: a.id, status: 'idle' })
      return { detail: list.length ? `${list.map((a) => a.name).join(', ')} from .claude/agents` : 'No agents in .claude/agents' }
    })
  }

  async updateRoom(roomId: string, patch: Partial<Pick<Room, 'name' | 'desc' | 'hidden' | 'archived' | 'desks'>>): Promise<Room> {
    const room = this.store.saveRoom({ ...this.mustRoom(roomId), ...patch })
    bus.push({ type: 'room', room })
    return room
  }

  /**
   * Forgets a room: stops its agents and scripts, archives its workspaces and deletes Kernel's record of them.
   * The folder, its git history and .claude/agents are never touched. Worktrees are removed only when asked.
   */
  async removeRoom(roomId: string, deleteWorktrees: boolean) {
    const room = this.mustRoom(roomId)
    for (const ws of this.store.workspaces(roomId)) {
      this.sessions.stopWorkspace(ws.id)
      stopScript(ws.id, 'run')
      if (deleteWorktrees && ws.mode === 'worktree' && ws.status !== 'archived') await removeWorktree(room.path, ws.path, { force: true }).catch(() => undefined)
    }
    this.store.deleteRoom(roomId)
    this.agentCache.delete(roomId)
    this.statuses.delete(roomId)
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

  async hunks(id: string, path?: string) {
    const ws = this.mustWs(id)
    return listHunks(ws.path, { baselineRef: ws.mode === 'current' ? ws.baselineRef : undefined }, path)
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
      ...unbuilt(),
      'preflight.run': async () => this.preflight(),
      'preflight.fix': async ({ id }) => {
        if (id === 'teams') {
          this.settings = { ...this.settings, models: { ...this.settings.models, agentTeams: true } }
          await saveAppSettings(this.settingsFile, this.settings)
        } else if (id === 'hooks') await this.restartHooks(await nextFreePort(this.settings.hookPort + 1))
        return this.preflight()
      },
      'hooks.status': async () => this.hooksStatus(),
      'hooks.restart': async ({ port }) => this.restartHooks(port ?? this.settings.hookPort),
      'hooks.test': async () => {
        // /health answers from the same server that receives hooks, and records nothing.
        const res = await fetch(`http://127.0.0.1:${this.settings.hookPort}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
        if (!res?.ok) throw new Error(`No reply from the hook server on port ${this.settings.hookPort}.`)
        return this.hooksStatus()
      },
      'hooks.install': async ({ port }) => ({ path: this.claudeSettings, events: await installHooks(this.claudeSettings, port, this.settings.permissions.approvalTimeoutSec) }),
      'rooms.list': async () => this.store.rooms(),
      'rooms.add': async ({ path, name }) => this.addRoom(path, name),
      'rooms.create': async (req) => this.createRoom(req),
      'rooms.update': async ({ roomId, patch }) => this.updateRoom(roomId, patch),
      'rooms.remove': async ({ roomId, deleteWorktrees }) => { await this.removeRoom(roomId, deleteWorktrees); return { ok: true } },
      'rooms.inspectFolder': async ({ path }) => inspectFolder(path, this.home),
      'rooms.recentFolders': async () => recentFolders(this.store.rooms().map((r) => r.path), this.home),
      'github.repos': async ({ query }) => listRepos(query),
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
      'workspaces.tree': async ({ workspaceId }) => listTree(this.mustWs(workspaceId).path, await this.changes(workspaceId).catch(() => [])),
      'workspaces.readFile': async ({ workspaceId, path }) => readWorkspaceFile(this.mustWs(workspaceId).path, path),
      'chats.list': async ({ workspaceId }) => this.store.chats(workspaceId),
      'chats.create': async ({ workspaceId, kind }) => { const first = this.store.chats(workspaceId)[0]; return this.newChat(workspaceId, kind === 'terminal' ? 'Terminal (claude)' : 'New chat', { model: first?.model ?? this.settings.models.engineers, effort: first?.effort ?? this.settings.models.effort, plan: false, kind }) },
      'chats.items': async ({ chatId }) => this.store.items(chatId),
      'workspaces.files': async ({ workspaceId, query, limit }) => searchFiles(this.mustWs(workspaceId).path, query, limit),
      'workspaces.hunks': async ({ workspaceId, path }) => this.hunks(workspaceId, path),
      'workspaces.commit': async ({ workspaceId, hunkIds, message }) => {
        const picked = (await this.hunks(workspaceId)).filter((h) => hunkIds.includes(h.id))
        if (picked.length !== hunkIds.length) throw new Error('Those changes moved on. Open the card again and pick again.')
        await commitHunks(this.mustWs(workspaceId).path, picked, message?.trim() || `Update ${[...new Set(picked.map((h) => h.path))].join(', ')}`)
        return { ok: true }
      },
      'skills.list': async ({ roomId }) => discoverSkills(this.mustRoom(roomId).path),
      'chats.queue': async ({ chatId }) => this.sessions.queued(chatId),
      'chats.unqueue': async ({ chatId, id }) => this.sessions.unqueue(chatId, id),
      'chats.sendNow': async ({ chatId, id }) => this.sessions.sendNow(chatId, id),
      'chats.retry': async ({ chatId, itemId }) => { await this.sessions.retry(chatId, itemId); return { ok: true } },
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
      'usage.get': async () => this.sessions.usage(),
      'settings.get': async () => this.settings,
      'settings.room': async ({ roomId }) => loadRepoSettings(this.mustRoom(roomId).path)
    }
  }

  private preflight() {
    return runPreflight({ hookPort: this.settings.hookPort, hookServerUp: !!this.hookServer?.listening, agentTeams: this.settings.models.agentTeams })
  }

  private get claudeSettings() { return this.o.claudeSettingsFile ?? join(this.home, '.claude', 'settings.json') }
}
