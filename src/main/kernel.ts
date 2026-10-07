import { basename, join } from 'node:path'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Server } from 'node:http'
import type { AgentDef, AgentDraft, AgentEdit, AgentStatus, Chat, ClaudeAccount, ChatItem, ChatPart, PrState, WorkspaceSource, HookStatus, NewRoomRequest, RateLimit, Room, RoomSetupStep, TeamTemplate, Workspace, WorkspaceMode, ModelId, Effort } from '@shared/types'
import { MODELS } from '@shared/types'
import { NotImplemented, type Channel, type KernelApi, type PushEvent } from '@shared/ipc'
import { Store, newId } from './db'
import { bus } from './bus'
import { createAgent, draftAgent, loadAgents, restoreAgent, retireAgent, saveAgent, updateAgent, watchAgents } from './services/agents'
import { Approvals, parsePlanSteps } from './services/approvals'
import { Tasks } from './services/tasks'
import { Notifications } from './services/notifications'
import { Sessions, sessionEnv } from './services/sessions'
import { Ptys } from './services/pty'
import type { forkSession as ForkSession } from '@anthropic-ai/claude-agent-sdk'
import { kernelMcpServer } from './services/kernelMcp'
import { startHookServer } from './services/hookServer'
import { hookStatus, installHooks, KERNEL_HOOK_EVENTS } from './services/hooksInstaller'
import { nextFreePort, portBusy, runPreflight } from './services/preflight'
import { applySettingsPatch, loadAppSettings, loadRepoSettings, saveAppSettings, type AppSettings } from './services/settings'
import { changedFiles, createWorktree, currentBranch, defaultBranch, diffText, branchExists, freeBranch, listBranches, mergeBase, remoteRepo, removeWorktree, restoreWorktree, slugify, snapshotBaseline, taskBranch } from './services/worktrees'
import { readAccount, signOut } from './services/account'
import { copyLocalFiles, freePort, runScript, stopAllScripts, stopScript } from './services/scripts'
import { agentFiles, assertFreeFolder, cloneRepo, copyTemplate, ensureRepoSettings, expandHome, initGit, inspectFolder, installCommand, listRepos, recentFolders, seatStarterTeam, copyAgentFiles, tildify } from './services/rooms'
import { exec, git } from './services/exec'
import { discoverSkills, listTree, readWorkspaceFile, searchFiles } from './services/files'
import { commitHunks, listHunks } from './services/hunks'
import { allGreen, gh, openPrs, prNote, resolveFile, type GitHub } from './services/github'
import { linearToken, searchIssues } from './services/linear'
import { Overlaps } from './services/overlap'
import { checkpointTitle, clock, listCheckpoints, revertTo, snapshot } from './services/checkpoints'
import { blockingLimit, NetworkMonitor, terminalScript } from './services/health'
import { discardChanges, gitStatus, pushBranch } from './services/archive'

const COPY = 'fork:'

/** How a hook from an outside session moves its agent on the floor. */
const HOOK_STATUS: Record<string, AgentStatus> = { UserPromptSubmit: 'working', PreToolUse: 'working', PermissionRequest: 'needs', Stop: 'idle', SessionEnd: 'idle' }

type CoreChannel = Exclude<Channel, `system.${string}`>
export type Handlers = { [C in CoreChannel]: (req: KernelApi[C]['req']) => Promise<KernelApi[C]['res']> }

/**
 * Channels no lane has built yet, and the issue that builds each. They reject with NotImplemented.
 * A lane that builds one deletes its line here and adds the handler to the map in `handlers()`.
 */
export const UNBUILT = {
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
  readonly notifications: Notifications
  readonly tasks: Tasks
  readonly sessions: Sessions
  readonly overlaps: Overlaps
  readonly ptys = new Ptys()
  /** The SDK call behind a fork. Tests swap it for a stub. */
  forkSession: typeof ForkSession = async (id, o) => (await import('@anthropic-ai/claude-agent-sdk')).forkSession(id, o)
  settings!: AppSettings
  private hookServer?: Server
  private agentCache = new Map<string, AgentDef[]>()
  private agentWatchers = new Map<string, () => void>()
  private statuses = new Map<string, Record<string, AgentStatus>>()
  private prTimer?: NodeJS.Timeout
  /** When each hook event last arrived from a real session. The test event is not counted. */
  private hookSeen = new Map<string, number>()
  private unlisten: () => void = () => undefined
  private network?: NetworkMonitor
  /** One timer per rejected usage window, at its reset time. */
  private limitTimers = new Map<RateLimit['type'], { at: number; timer: NodeJS.Timeout }>()
  /** The last account read, so a sign-out keeps the name on the account menu. */
  private account?: import('@shared/types').ClaudeAccount
  /** Windows CJ asked to hear about when they reset ("Notify me"). */
  private notifyReset = new Set<RateLimit['type']>()

  constructor(private o: {
    dataDir: string; home?: string; claudeSettingsFile?: string; starterDir?: string; showNotification?: (n: import('@shared/types').Notification, o: { silent: boolean }) => void; inBackground?: () => boolean
    /** Can this machine reach Claude? The app passes a DNS probe; tests leave it out, so they never go offline. */
    probeNetwork?: () => Promise<boolean>
    /** Kernel's version, for Settings > About. */
    version?: string
    /** Called with the settings at start and after every change, for the parts only the app shell can do (open at login). */
    onSettings?: (s: AppSettings) => void
  }) {
    this.store = new Store(join(o.dataDir, 'kernel.db'))
    this.approvals = new Approvals(this.store)
    this.tasks = new Tasks({ store: this.store, agents: (roomId) => this.agentsSync(roomId) })
    this.notifications = new Notifications({
      store: this.store,
      settings: () => this.settings,
      agentName: (roomId, agentId) => (roomId ? this.agentsSync(roomId).find((a) => a.id === agentId)?.name : undefined),
      show: o.showNotification,
      inBackground: o.inBackground
    })
    this.sessions = new Sessions({
      store: this.store,
      approvals: this.approvals,
      settings: () => this.settings,
      agentFor: (ws) => this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId),
      mcpFor: (ws, agent, chat) => (agent?.lead ? { kernel: this.leadTools(ws.roomId, agent, chat) } : undefined),
      roomAllow: (roomId) => this.store.room(roomId)?.allow ?? [],
      allowInRoom: (roomId, rule) => {
        const room = this.store.room(roomId)
        if (room && !room.allow?.includes(rule)) this.store.saveRoom({ ...room, allow: [...(room.allow ?? []), rule] })
      },
      onTurnDone: (ws, chat) => {
        void this.checkpoint(ws, chat).catch(() => undefined)
        void this.refreshPr(ws.id).catch(() => undefined); void this.overlaps.check(ws.roomId).catch(() => undefined)
      },
      onFailure: (failure) => {
        if (failure === 'auth') this.signedOut()
        else if (failure === 'network') void this.network?.check()
      },
      onLimits: (limits) => this.applyLimits(limits)
    })
    this.overlaps = new Overlaps({
      workspaces: (roomId) => this.store.workspaces(roomId),
      since: async (ws) => (ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)),
      leadId: (roomId) => this.agentsSync(roomId).find((a) => a.lead)?.id
    })
    const onActivity = (e: Parameters<Store['saveActivity']>[0]) => this.store.saveActivity(e)
    const onHook = (e: { hook_event_name: string }, ctx?: { roomId?: string; agentId?: string }) => {
      this.hookSeen.set(e.hook_event_name, Date.now())
      // Only sessions Kernel did not start reach here (the big terminal, or Claude Code run by hand), so the floor learns their status from the hooks.
      const status = HOOK_STATUS[e.hook_event_name]
      if (!status || !ctx?.roomId || !ctx.agentId) return
      if (this.statuses.get(ctx.roomId)?.[ctx.agentId] === 'paused') return
      bus.push({ type: 'agent.status', roomId: ctx.roomId, agentId: ctx.agentId, status })
    }
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
    this.o.onSettings?.(this.settings)
    await this.listenHooks(this.settings.hookPort)
    this.prTimer = setInterval(() => void this.pollPrs(), 45_000)
    this.notifications.attach()
    if (this.o.probeNetwork) {
      this.network = new NetworkMonitor({ probe: this.o.probeNetwork, onChange: (online) => this.setOnline(online) })
      this.network.start()
    }
    this.tasks.attach()
    // A room paused before the app quit is still paused: its agents wait and its sends are held. A limit pause is not:
    // the limits and their reset timers lived in memory, so nothing would lift it. The next rejection pauses it again.
    for (const r of this.store.rooms()) {
      if (r.paused && r.pausedBy === 'limit') { const { pausedBy: _by, ...rest } = r; bus.push({ type: 'room', room: this.store.saveRoom({ ...rest, paused: false }) }) }
      else if (r.paused) this.sessions.pause(r.id)
    }
  }

  /** Starts the hook server on `port`. A taken port is not fatal: preflight reports it and offers the next one. */
  private async listenHooks(port: number): Promise<boolean> {
    try {
      this.hookServer = await startHookServer({
        port,
        approvals: this.approvals,
        approvalTimeoutMs: () => this.settings.permissions.approvalTimeoutSec * 1000,
        isManaged: (id) => this.sessions.isManaged(id),
        resolve: (cwd) => this.resolveCwd(cwd)
      })
      // A server that closes or errors on its own takes the floor and the logs with it (WorkspaceHooksDown.png).
      const server = this.hookServer
      server.on('close', () => { if (this.hookServer === server) void this.pushHooks() })
      server.on('error', () => void this.pushHooks())
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
    return this.pushHooks()
  }

  /**
   * Settings > any app page. Saves to settings.json and applies at once: running sessions read the permission lists on their
   * next tool call, the mode moves to them now, a higher limit on agents working at once starts what was waiting, and a new
   * approval timeout is read per request and rewritten into the installed hooks.
   */
  private async setSettings(patch: Parameters<typeof applySettingsPatch>[1]): Promise<AppSettings> {
    const before = this.settings
    this.settings = applySettingsPatch(before, patch)
    await saveAppSettings(this.settingsFile, this.settings)
    this.sessions.applySettings(before)
    this.o.onSettings?.(this.settings)
    // The server reads the timeout per request. Only the copy in the installed hooks needs rewriting.
    if (before.permissions.approvalTimeoutSec !== this.settings.permissions.approvalTimeoutSec && (await hookStatus(this.claudeSettings)).length > 0) await installHooks(this.claudeSettings, this.settings.hookPort, this.settings.permissions.approvalTimeoutSec)
    return this.settings
  }

  /** The activity log as plain text, one line per event, saved in the data folder. */
  private async exportLogs(): Promise<{ path: string }> {
    const dir = join(this.o.dataDir, 'logs')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `kernel-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    const lines = this.store.activity(undefined, 5000).reverse().map((e) => `${new Date(e.ts).toISOString()} ${[e.actor, e.text, e.object].filter(Boolean).join(' ')}`)
    await writeFile(path, lines.join('\n') + '\n')
    return { path }
  }

  private async pushHooks(): Promise<HookStatus> {
    const status = await this.hooksStatus()
    bus.push({ type: 'hooks', status })
    return status
  }

  // ---------- failures (KERNEL-28)

  /** Main's view of the network. Offline holds every room like a pause; back online sends what queued. */
  private setOnline(online: boolean) {
    bus.push({ type: 'online', online })
    if (online) this.sessions.releaseAll('offline')
    else this.sessions.holdAll('offline')
  }

  /** Reads `claude auth status`. Tests swap it for a stub. */
  accountReader: () => Promise<ClaudeAccount> = readAccount
  private authTimer?: NodeJS.Timeout

  /**
   * A session reported an auth failure: Claude Code is signed out. Everything waits until the CLI is signed in again,
   * by Sign in here or by `claude /login` in a terminal, which a check every 10 seconds picks up.
   */
  private signedOut() {
    this.sessions.holdAll('auth')
    bus.push({ type: 'account', account: { ...this.account, signedIn: false } })
    if (this.authTimer) return
    this.authTimer = setInterval(() => void this.readAccount().catch(() => undefined), 10_000)
    this.authTimer.unref?.()
  }

  /** Every read of the account can end a sign-out: a signed-in answer lifts the hold and tells the renderer. */
  async readAccount() {
    const account = await this.accountReader()
    if (!account.signedIn) return account
    this.account = account
    if (this.sessions.heldFor().includes('auth')) {
      clearInterval(this.authTimer); this.authTimer = undefined
      this.sessions.releaseAll('auth')
      bus.push({ type: 'account', account })
    }
    return account
  }

  /** Runs Claude Code's own login (it opens the browser), then reads the account back. */
  async signIn() {
    await exec('claude', ['auth', 'login'], { timeoutMs: 5 * 60_000 })
    const account = await this.readAccount()
    bus.push({ type: 'account', account })
    if (!account.signedIn) throw new Error('Sign in did not finish. Open a terminal and run claude /login.')
    return account
  }

  /**
   * A 5-hour or weekly rejection pauses every room by `limit` (FloorLimit.png); its end resumes them. Each rejected
   * window gets a timer at its reset time, which marks it allowed again and sends "Notify me".
   */
  private applyLimits(limits: RateLimit[]) {
    const now = Date.now()
    const rooms = this.store.rooms().filter((r) => !r.archived)
    if (blockingLimit(limits, now)) { for (const r of rooms) if (!r.paused) this.pauseRoom(r.id, 'limit') }
    else for (const r of rooms) if (r.paused && r.pausedBy === 'limit') this.resumeRoom(r.id, 'limit')
    for (const l of limits) {
      const at = l.resetsAt ? l.resetsAt * 1000 : undefined
      const held = this.limitTimers.get(l.type)
      if (l.status !== 'rejected' || !at) { if (held) { clearTimeout(held.timer); this.limitTimers.delete(l.type) } continue }
      if (held?.at === at) continue
      if (held) clearTimeout(held.timer)
      const timer = setTimeout(() => this.limitReset(l.type), Math.min(Math.max(0, at - now), 2 ** 31 - 1))
      timer.unref?.()
      this.limitTimers.set(l.type, { at, timer })
    }
  }

  private limitReset(type: RateLimit['type']) {
    this.limitTimers.delete(type)
    this.sessions.resetLimit(type)
    if (!this.notifyReset.delete(type)) return
    const name = type === 'five_hour' ? '5-hour limit' : type === 'seven_day_opus' ? 'Opus limit' : type === 'seven_day_sonnet' ? 'Sonnet limit' : 'weekly limit'
    this.o.showNotification?.({ id: `limit-${type}-${Date.now()}`, kind: 'system', title: `Your ${name} reset`, sub: 'Agents can run again.', needsYou: false, read: false, createdAt: Date.now() }, { silent: false })
  }

  /** Opens Terminal.app in `cwd` and runs `command` there. */
  async openTerminal(cwd: string, command?: string) {
    const r = await exec('osascript', ['-e', terminalScript(cwd, command)], { timeoutMs: 15_000 })
    if (r.code !== 0) throw new Error(`Could not open Terminal: ${r.stderr.trim() || 'osascript failed'}`)
  }

  /** Throws away uncommitted changes, after a checkpoint so they can still come back from the drawer. */
  async discard(workspaceId: string) {
    const ws = this.mustWs(workspaceId)
    if (ws.mode === 'current') throw new Error('Discard is off on the current branch, because it would throw away your own changes too. Revert to a checkpoint instead.')
    const chats = this.store.chats(workspaceId)
    if (chats.some((c) => this.sessions.isRunning(c.id))) throw new Error('The agent is still working. Stop it first, then discard.')
    const chat = chats.find((c) => c.kind !== 'terminal')
    if (chat) await snapshot(ws, { chatId: chat.id, title: 'Before discarding changes' }).then((c) => bus.push({ type: 'checkpoint', checkpoint: c }))
    await discardChanges(ws.path)
    bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId, agentId: ws.agentId, actor: 'you', text: 'discarded the changes in', object: ws.name })
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
    this.notifications.detach()
    this.tasks.detach()
    clearInterval(this.prTimer)
    this.network?.stop()
    clearInterval(this.authTimer)
    for (const t of this.limitTimers.values()) clearTimeout(t.timer)
    this.limitTimers.clear()
    for (const close of this.agentWatchers.values()) close()
    this.agentWatchers.clear()
    this.sessions.stopAll()
    this.ptys.killAll()
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

  /**
   * Pause a room: every agent finishes the step it is on, then waits, and sends are held until Resume.
   * `by` is who asked. A limit pause (`limit`) is lifted by whoever detects the reset, with `resumeRoom`.
   */
  pauseRoom(roomId: string, by: 'you' | 'limit'): Room {
    const room = this.store.saveRoom({ ...this.mustRoom(roomId), paused: true, pausedBy: by })
    this.sessions.pause(roomId)
    // Someone who needs CJ, is blocked or is offline keeps saying so.
    const now = this.statusOf(roomId)
    for (const a of this.agentsSync(roomId)) if (!['needs', 'blocked', 'offline'].includes(now[a.id])) bus.push({ type: 'agent.status', roomId, agentId: a.id, status: 'paused' })
    bus.push({ type: 'room', room })
    bus.activity({ kind: 'room.paused', roomId, actor: by === 'you' ? 'you' : 'kernel', text: by === 'you' ? 'paused' : 'paused the room for', object: by === 'you' ? room.name : 'a usage limit' })
    return room
  }

  resumeRoom(roomId: string, by: 'you' | 'limit' = 'you'): Room {
    const { pausedBy: _by, ...rest } = this.mustRoom(roomId)
    const room = this.store.saveRoom({ ...rest, paused: false })
    const before = this.statusOf(roomId)
    this.sessions.resume(roomId)
    const live = new Map(this.store.workspaces(roomId).map((w) => [w.agentId, this.store.chats(w.id).some((c) => this.sessions.isRunning(c.id))]))
    for (const a of this.agentsSync(roomId)) if (before[a.id] === 'paused') bus.push({ type: 'agent.status', roomId, agentId: a.id, status: live.get(a.id) ? 'working' : 'idle' })
    bus.push({ type: 'room', room })
    bus.activity({ kind: 'room.resumed', roomId, actor: by === 'you' ? 'you' : 'kernel', text: by === 'you' ? 'resumed' : 'resumed after the usage limit reset', object: by === 'you' ? room.name : undefined })
    return room
  }

  /** Empty room: write a team into .claude/agents and seat it. Refuses a room that already has agents. */
  async seedAgents(roomId: string, template: TeamTemplate): Promise<AgentDef[]> {
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
      this.ptys.killWorkspace(ws.id, this.store.chats(ws.id).map((c) => c.id))
      stopScript(ws.id, 'run')
      if (deleteWorktrees && ws.mode === 'worktree' && ws.status !== 'archived') await removeWorktree(room.path, ws.path, { force: true }).catch(() => undefined)
    }
    this.overlaps.forget(roomId)
    this.store.deleteRoom(roomId)
    this.agentWatchers.get(roomId)?.()
    this.agentWatchers.delete(roomId)
    this.agentCache.delete(roomId)
    this.statuses.delete(roomId)
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
  private announceTeam(roomId: string, list: AgentDef[], was?: AgentDef[]) {
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
  async saveAgentEdit(roomId: string, agentId: string, patch: AgentEdit): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    const saved = await updateAgent(room.path, agentId, patch)
    this.announceTeam(roomId, await this.agents(roomId))
    return saved
  }

  /** New agent > Create agent. The file joins .claude/agents and the agent takes a desk (the next free one, or the end of `room.desks`). */
  async hireFromDraft(roomId: string, draft: AgentDraft): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    const was = this.agentCache.get(roomId) ?? await this.agents(roomId)
    const def = await createAgent(room.path, draft)
    if (room.desks && !room.desks.includes(def.id)) await this.updateRoom(roomId, { desks: [...room.desks, def.id] })
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list, was)
    return list.find((a) => a.id === def.id) ?? def
  }

  /**
   * Retire: the file moves to .claude/retired-agents (D-003), open workspaces go to `handoffTo` or the Lead, and the desk frees up.
   * A turn already running keeps its own copy of the agent and finishes. The Lead cannot be retired, because nobody would plan.
   */
  async retire(roomId: string, agentId: string, handoffTo?: string): Promise<void> {
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
    if (room.desks?.includes(agentId)) await this.updateRoom(roomId, { desks: room.desks.filter((d) => d !== agentId) })
    const statuses = this.statuses.get(roomId)
    if (statuses) delete statuses[agentId]
    const list = await this.agents(roomId)
    bus.push({ type: 'agents', roomId, agents: list })
    bus.activity({ kind: 'agent.retired', roomId, agentId, actor: 'you', text: 'retired', object: agent.name })
  }

  async restore(roomId: string, agentId: string): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    await restoreAgent(room.path, agentId)
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list)
    const def = list.find((a) => a.id === agentId)
    if (!def) throw new Error(`${agentId} could not be restored.`)
    return def
  }

  private agentsSync(roomId: string) { return this.agentCache.get(roomId) ?? [] }

  statusOf(roomId: string): Record<string, AgentStatus> {
    const s = { ...(this.statuses.get(roomId) ?? {}) }
    for (const a of this.agentsSync(roomId)) s[a.id] ??= this.mustRoom(roomId).paused ? 'paused' : 'idle'
    return s
  }

  // ---------- workspaces

  async createWorkspace(roomId: string, o: { prompt: string; parts?: ChatPart[]; source?: WorkspaceSource; agentId?: string; mode?: WorkspaceMode; baseRef?: string; title?: string; model?: ModelId; effort?: Effort; plan?: boolean; taskFor?: (ws: Workspace) => string | undefined }): Promise<Workspace> {
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
      branch = await freeBranch(room.path, taskBranch(repo.workspace.branchPattern ?? s.workspace.branchPattern, o.source?.kind === 'issue' ? o.source.title : title, o.source?.kind === 'issue' ? o.source.id : undefined))
      path = await createWorktree({ repo: room.path, root: join(s.worktreeRoot, slugify(room.name)), branch, baseRef, fetch: baseRef.startsWith('origin/') })
      await copyLocalFiles(room.path, path, repo.files.copy)
    } else {
      if (s.workspace.oneCurrentBranchPerRoom && this.store.workspaces(roomId).some((w) => w.mode === 'current' && w.status !== 'archived' && w.agentId !== agent.id))
        throw new Error('Another workspace is already working on the current branch in this room.')
      path = room.path
      branch = await currentBranch(room.path)
      if (s.workspace.baselineCurrentBranch) baselineRef = (await snapshotBaseline(room.path)).ref
    }

    const ws: Workspace = { id: newId(), roomId, name: slugify(title), branch, baseRef, path, mode, agentId: agent.id, port, status: 'setup', baselineRef, source: o.source, title, prState: 'none', createdAt: Date.now() }
    this.store.saveWorkspace(ws)
    bus.push({ type: 'workspace', workspace: ws })
    bus.activity({ kind: 'workspace.created', roomId, workspaceId: ws.id, agentId: agent.id, text: 'started', object: ws.name })
    // Rowan's hand-off: the board task this workspace builds moves to Building now, not when the turn ends.
    const taskId = o.taskFor?.(ws)
    if (taskId) { ws.taskId = taskId; this.saveWs(ws) }

    const chat = this.newChat(ws.id, title, { model: o.model ?? this.modelFor(agent), effort: o.effort ?? agent.effort ?? s.models.effort, plan: o.plan ?? (agent.lead && s.models.leadPlanMode) })
    const parts: ChatPart[] = [{ type: 'text', text: o.prompt }, ...(o.parts ?? [])]
    const ready = await this.runSetup(ws, room, repo.scripts.setup)
    // The first prompt waits in the chat's queue until setup passes (WorkspaceSetupFailed.png, "Run again").
    if (!ready) { this.sessions.hold(chat.id, parts); return this.saveWs({ ...ws, status: 'failed' }) }
    return this.setupDone(ws, room, chat, o.prompt, async () => { await this.sessions.send(chat.id, parts) })
  }

  /** Setup passed: the workspace is ready, the run script starts, the start-of-chat checkpoint is taken, and the agent gets its prompt. */
  private async setupDone(ws: Workspace, room: Room, chat: Chat, prompt: string, start: () => Promise<void>) {
    const repo = await loadRepoSettings(room.path)
    const done = this.saveWs({ ...ws, status: 'ready' })
    if (this.settings.scripts.runAfterSetup && repo.scripts.run) void runScript({ workspaceId: ws.id, kind: 'run', script: repo.scripts.run, cwd: ws.path, port: ws.port, root: room.path })
    // The start of chat: reverting to it undoes everything the agent did.
    await snapshot(ws, { chatId: chat.id, title: prompt, start: true }).then((c) => bus.push({ type: 'checkpoint', checkpoint: c }), () => undefined)
    await start()
    return done
  }

  /** Workspaces whose setup is rerunning, so a second Run again doesn't start it twice. */
  private settingUp = new Set<string>()

  /** "Run again" on a failed setup: rerun the script, and when it passes send the prompt that was waiting. */
  async retrySetup(workspaceId: string): Promise<Workspace> {
    if (this.settingUp.has(workspaceId)) return this.mustWs(workspaceId)
    this.settingUp.add(workspaceId)
    try { return await this.rerunSetup(workspaceId) } finally { this.settingUp.delete(workspaceId) }
  }

  private async rerunSetup(workspaceId: string): Promise<Workspace> {
    const ws = this.mustWs(workspaceId)
    const room = this.mustRoom(ws.roomId)
    const repo = await loadRepoSettings(room.path)
    const chat = this.store.chats(ws.id).find((c) => c.kind !== 'terminal')
    if (repo.scripts.setup) {
      const code = await runScript({ workspaceId: ws.id, kind: 'setup', script: repo.scripts.setup, cwd: ws.path, port: ws.port, root: room.path })
      if (!this.setupPassed(ws, code)) return this.mustWs(workspaceId)
    }
    if (!chat) return this.saveWs({ ...ws, status: 'ready' })
    const first = this.sessions.queued(chat.id)[0]?.parts.find((p) => p.type === 'text')
    return this.setupDone(ws, room, chat, first?.type === 'text' ? first.text : ws.title ?? ws.name, async () => this.sessions.release(chat.id))
  }

  private async runSetup(ws: Workspace, room: Room, script?: string): Promise<boolean> {
    if (!script || !this.settings.scripts.setupOnCreate) return true
    const code = await runScript({ workspaceId: ws.id, kind: 'setup', script, cwd: ws.path, port: ws.port, root: room.path })
    return this.setupPassed(ws, code)
  }

  /** The last line of a failed setup log says so, the way the canvas draws it (WorkspaceSetupFailed.png). */
  private setupPassed(ws: Workspace, code: number | null) {
    if (code === 0) return true
    bus.push({ type: 'script.output', workspaceId: ws.id, kind: 'setup', line: code === null ? 'Setup was stopped' : `Setup failed with exit code ${code}`, stream: 'stderr' })
    return false
  }

  async archiveWorkspace(id: string, deleteBranch?: boolean) {
    const ws = this.mustWs(id)
    const room = this.mustRoom(ws.roomId)
    this.sessions.stopWorkspace(id)
    this.ptys.killWorkspace(id, this.store.chats(id).map((c) => c.id))
    stopScript(id, 'run')
    const repo = await loadRepoSettings(room.path)
    if (repo.scripts.archive && this.settings.scripts.archiveOnArchive) await runScript({ workspaceId: id, kind: 'archive', script: repo.scripts.archive, cwd: ws.path, port: ws.port, root: room.path })
    // Commits that never left this machine live only on the branch, so it stays whatever was asked.
    const unpushed = ws.mode === 'worktree' ? (await gitStatus(ws.path, ws.branch, ws.baseRef).catch(() => null))?.ahead ?? 0 : 0
    const drop = (deleteBranch ?? this.settings.workspace.deleteBranchOnArchive) && unpushed === 0
    if (ws.mode === 'worktree') await removeWorktree(room.path, ws.path, { force: true, deleteBranch: drop ? ws.branch : undefined })
    this.saveWs({ ...ws, status: 'archived', archivedAt: Date.now() })
    bus.activity({ kind: 'workspace.archived', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'archived', object: ws.name })
    void this.overlaps.check(ws.roomId).catch(() => undefined)
  }

  /** Brings an archived workspace back: recreates the worktree from its branch and reopens its chats, which Kernel kept. */
  async restoreWorkspace(id: string): Promise<Workspace> {
    const ws = this.mustWs(id)
    if (ws.status !== 'archived') return ws
    const room = this.mustRoom(ws.roomId)
    if (ws.mode === 'worktree') {
      const path = await stat(ws.path).then(() => undefined, () => ws.path)
      if (!path) throw new Error(`The folder ${ws.path} is back in use, so ${ws.name} cannot be restored there.`)
      await restoreWorktree({ repo: room.path, path, branch: ws.branch })
      const repo = await loadRepoSettings(room.path)
      await copyLocalFiles(room.path, path, repo.files.copy)
    } else if (this.settings.workspace.oneCurrentBranchPerRoom && this.store.workspaces(ws.roomId).some((w) => w.mode === 'current' && w.status !== 'archived' && w.agentId !== ws.agentId)) {
      throw new Error('Another workspace is already working on the current branch in this room.')
    }
    // Another workspace may have taken this port while it was archived.
    const taken = new Set(this.store.workspaces().filter((w) => w.status !== 'archived').map((w) => w.port))
    const port = taken.has(ws.port) ? await freePort(4300, taken) : ws.port
    const { archivedAt: _gone, ...rest } = ws
    const back = this.saveWs({ ...rest, port, status: 'ready' })
    bus.activity({ kind: 'workspace.restored', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'restored', object: ws.name })
    return back
  }

  /** A quick question to the room's Lead. The answer arrives in the Lead's chat like any turn; the popover reads it from there. */
  async askLead(roomId: string, text: string): Promise<{ chatId: string }> {
    const chat = await this.leadChat(roomId)
    await this.sessions.send(chat.id, [{ type: 'text', text }])
    return { chatId: chat.id }
  }

  /**
   * "Let Rowan sort it": the Lead gets both workspaces and the file, and the card leaves the floor.
   * The overlap itself clears on its own once the agents stop touching the same file.
   */
  async sortOverlap(overlapId: string): Promise<void> {
    const o = this.overlaps.get(overlapId)
    if (!o) throw new Error('That overlap is gone already.')
    const agents = await this.agents(o.roomId)
    const parts = o.parties.map((p) => `${agents.find((a) => a.id === p.agentId)?.name ?? p.agentId} in ${this.store.workspace(p.workspaceId)?.name ?? p.workspaceId} (${p.lines})`)
    const chat = await this.leadChat(o.roomId)
    const text = `${parts.join(' and ')} both changed ${o.path} in different worktrees, so merging both will conflict. Decide who keeps the change, tell the others, and sort it out before either merges.`
    await this.sessions.send(chat.id, [{ type: 'text', text }])
    this.overlaps.resolve(overlapId)
    // A note, not a brief: a brief to the Lead would restart the briefing sequence on the floor.
    const lead = agents.find((a) => a.id === this.store.workspace(chat.workspaceId)?.agentId)
    bus.activity({ kind: 'note', roomId: o.roomId, workspaceId: chat.workspaceId, agentId: lead?.id, actor: 'you', text: `asked ${lead?.name ?? 'the Lead'} to sort out the overlap in`, object: o.path.split('/').pop(), quote: text })
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

  // ---------- checkpoints

  /** Save the worktree after a turn, titled with the prompt that started the turn. */
  async checkpoint(ws: Workspace, chat: Chat) {
    const items = this.store.items(chat.id)
    const user = [...items].reverse().find((i) => i.kind === 'user')
    const text = user?.kind === 'user' ? user.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'skill' ? `/${p.name}` : p.name)).join(' ') : ''
    const c = await snapshot(ws, { chatId: chat.id, title: text || chat.title })
    bus.push({ type: 'checkpoint', checkpoint: c })
    return c
  }

  /** Restore a workspace's files to a checkpoint. Later changes go to a backup branch, and the chat gets a note saying so. */
  async revertCheckpoint(workspaceId: string, checkpointId: string): Promise<{ backupBranch: string }> {
    const ws = this.mustWs(workspaceId)
    // Current-branch workspaces share the checkout with the Lead and each other, so any agent working in the same folder blocks a revert.
    const sharing = this.store.workspaces().filter((w) => w.path === ws.path && w.status !== 'archived')
    if (sharing.some((w) => this.store.chats(w.id).some((c) => this.sessions.isRunning(c.id)))) throw new Error('An agent is still working in this workspace. Stop it, then revert.')
    const r = await revertTo(ws, checkpointId)
    bus.push({ type: 'checkpoint', checkpoint: r.checkpoint })
    const time = clock(r.checkpoint.ts)
    const tabs = this.chatTabs(ws.id).filter((c) => c.kind !== 'terminal')
    const chat = tabs.find((c) => c.id === r.checkpoint.chatId) ?? tabs[0]
    const what = r.checkpoint.start ? 'the start of the chat' : `${time}, "${checkpointTitle(r.checkpoint.title)}"`
    if (chat) {
      const item: ChatItem = { kind: 'note', id: newId(), ts: Date.now(), text: `Reverted files to ${what}. Later changes are saved on ${r.backupBranch}.` }
      this.store.saveItem(chat.id, item)
      bus.push({ type: 'chat.item', chatId: chat.id, item })
    }
    bus.activity({ kind: 'checkpoint.reverted', actor: 'you', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: `reverted files to ${time} in`, object: ws.name, data: { backupBranch: r.backupBranch } })
    return { backupBranch: r.backupBranch }
  }

  // ---------- chats

  chatTabs(workspaceId: string): Chat[] { return this.store.chats(workspaceId).filter((c) => !c.closed) }

  private mustChat(chatId: string): Chat {
    const c = this.store.chat(chatId)
    if (!c) throw new Error('That chat no longer exists.')
    return c
  }

  renameChat(chatId: string, title: string): Chat {
    const t = title.trim()
    if (!t) throw new Error('Give the chat a name.')
    return this.saveChat({ ...this.mustChat(chatId), title: t })
  }

  /** The tab leaves the strip, its transcript stays. A big terminal's process ends. The last open tab is replaced by a fresh chat. */
  closeChat(chatId: string) {
    const chat = this.mustChat(chatId)
    this.sessions.stop(chatId)
    this.ptys.kill(chatId)
    this.saveChat({ ...chat, closed: true })
    if (!this.chatTabs(chat.workspaceId).some((c) => c.kind !== 'terminal')) this.saveChat(this.newChat(chat.workspaceId, 'New chat', { model: chat.model, effort: chat.effort, plan: false }))
  }

  private saveChat(chat: Chat): Chat {
    this.store.saveChat(chat)
    bus.push({ type: 'chat', chat })
    return chat
  }

  /**
   * A new chat that resumes from this one with the SDK's session fork. With `itemId` the fork ends at the nearest assistant message
   * at or before it (user messages carry no SDK uuid), and the transcript is copied up to there.
   */
  async forkChat(chatId: string, itemId?: string): Promise<Chat> {
    const chat = this.mustChat(chatId)
    if (chat.kind === 'terminal') throw new Error('A big terminal cannot be forked.')
    const ws = this.mustWs(chat.workspaceId)
    let items = this.store.items(chatId)
    let upTo: string | undefined
    if (itemId) {
      const at = items.findIndex((i) => i.id === itemId)
      if (at < 0) throw new Error('That message is not in this chat.')
      const keep = items.slice(0, at + 1)
      const anchor = [...keep].reverse().find((i) => i.kind !== 'user' && i.id.includes(':') && !i.id.startsWith(COPY))
      if (keep.some((i) => i.id.startsWith(COPY)) && !anchor) throw new Error('Fork the original chat to branch from an earlier message.')
      if (anchor) { items = items.slice(0, items.findIndex((i) => i.id === anchor.id) + 1); upTo = anchor.id.split(':')[0] } else items = []
    }
    let sessionId: string | undefined
    if (chat.sessionId && (!itemId || upTo)) sessionId = (await this.forkSession(chat.sessionId, { dir: ws.path, upToMessageId: upTo, title: `Fork of ${chat.title}` })).sessionId
    const fork = this.saveChat({ ...this.newChat(chat.workspaceId, `Fork of ${chat.title}`, { model: chat.model, effort: chat.effort, plan: chat.plan }), sessionId, forkOf: { chatId, itemId: items[items.length - 1]?.id ?? '' } })
    for (const i of items) this.store.saveItem(fork.id, { ...i, id: `${COPY}${fork.id}:${i.id}` } as ChatItem)
    return fork
  }

  /** Starts the pty for a big terminal chat, or the workspace's plain shell (`shell:<workspaceId>`), the first time it is used. */
  private ensurePty(id: string, size?: { cols: number; rows: number }) {
    if (this.ptys.has(id)) return
    const plain = id.startsWith('shell:')
    const chat = plain ? undefined : this.mustChat(id)
    if (chat && (chat.kind !== 'terminal' || chat.closed)) throw new Error('That tab is not a terminal.')
    const ws = this.mustWs(plain ? id.slice('shell:'.length) : chat!.workspaceId)
    this.ptys.start(id, {
      cwd: ws.path,
      env: sessionEnv(process.env, { KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE_ID: ws.id }),
      command: plain ? undefined : 'claude',
      ...size
    })
  }

  newChat(workspaceId: string, title: string, o: { model: ModelId; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal' }): Chat {
    return this.store.saveChat({ id: newId(), workspaceId, title, kind: o.kind ?? 'chat', model: o.model, effort: o.effort, plan: o.plan, createdAt: Date.now() })
  }

  private modelFor(agent: AgentDef): ModelId {
    const m = this.settings.models
    if (agent.model?.startsWith('claude-')) return agent.model as ModelId
    const alias = MODELS.find((x) => x.id.split('-')[1] === agent.model?.toLowerCase())
    if (alias) return alias.id
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
    return this.chatTabs(ws.id).find((c) => c.kind !== 'terminal') ?? this.newChat(ws.id, 'Lead', { model: this.modelFor(lead), effort: lead.effort ?? this.settings.models.effort, plan: this.settings.models.leadPlanMode })
  }

  private leadTools(roomId: string, lead: AgentDef, chat: Chat) {
    return kernelMcpServer({
      roomId, lead,
      agents: () => this.agents(roomId),
      workspaces: () => this.store.workspaces(roomId),
      createWorkspace: async (o) => {
        const ws = await this.createWorkspace(roomId, { ...o, mode: o.mode, taskFor: (w) => this.tasks.link(roomId, o.agentId, w.id)?.id })
        this.linkPlanStep(roomId, o.agentId, ws.id)
        return ws
      },
      messageWorkspace: async (workspaceId, text) => { const chat = this.chatTabs(workspaceId).find((c) => c.kind !== 'terminal'); if (chat) await this.sessions.send(chat.id, [{ type: 'text', text }]) },
      askUser: async (o) => {
        // The card goes in the chat Rowan is blocked in, wherever that is, and shows in the Inbox too.
        const agents = await this.agents(roomId)
        const { approval, decision } = this.approvals.request({
          kind: o.kind, source: 'sdk', roomId, workspaceId: chat.workspaceId, chatId: chat.id, agentId: lead.id, title: o.title, detail: o.detail, options: o.options,
          steps: o.steps && parsePlanSteps(o.steps, agents), agentFile: o.agentFile
        })
        this.sessions.placeApproval(chat.id, approval.id)
        return decision
      },
      hireAgent: async (a) => {
        const was = this.agentCache.get(roomId) ?? await this.agents(roomId)
        const file = await saveAgent(this.mustRoom(roomId).path, a)
        this.announceTeam(roomId, await this.agents(roomId), was)
        return file
      }
    })
  }

  /** Point the first unlinked step for this agent in the room's latest approved plan at the new workspace (the card's Open workspace link). */
  private linkPlanStep(roomId: string, agentId: string, workspaceId: string) {
    const plan = this.store.approvals({ roomId }).filter((a) => a.kind === 'plan' && a.status === 'allowed' && a.steps?.some((s) => s.agentId === agentId && !s.workspaceId)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!plan?.steps) return
    const at = plan.steps.findIndex((s) => s.agentId === agentId && !s.workspaceId)
    this.approvals.update(plan.id, { steps: plan.steps.map((s, i) => (i === at ? { ...s, workspaceId } : s)) })
  }

  // ---------- pull requests

  /** The GitHub calls behind the PR methods. Tests swap it for a stub. */
  github: GitHub = gh
  /** Workspaces whose merge Kernel is running, so the poll doesn't overwrite `merging`. */
  private merging = new Set<string>()
  /** The method of a merge Kernel ran, until the PR is seen merged, so the note says how it landed. */
  private mergedWith = new Map<string, AppSettings['pr']['mergeMethod']>()

  /** PR instructions and notes go to the workspace's first chat. */
  private prChat(id: string): Chat | undefined {
    const chats = this.chatTabs(id)
    return chats.find((c) => c.kind !== 'terminal') ?? chats[0]
  }

  private note(workspaceId: string, text: string) {
    const chat = this.prChat(workspaceId)
    if (!chat) return
    const item: ChatItem = { kind: 'note', id: newId(), ts: Date.now(), text }
    this.store.saveItem(chat.id, item)
    bus.push({ type: 'chat.item', chatId: chat.id, item })
  }

  private setPrState(ws: Workspace, prState: PrState) {
    const next = this.saveWs({ ...ws, prState })
    if (prState !== ws.prState) bus.push({ type: 'pr', workspaceId: ws.id, state: prState })
    return next
  }

  /** Sends `create-pr.md` (Settings > PRs) to the agent. The header shows Creating until its turn ends. */
  async createPr(id: string, draft = false) {
    const ws = this.mustWs(id)
    if (ws.prState !== 'none') throw new Error('This workspace already has a pull request.')
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    const text = this.settings.pr.createInstructions + (draft || this.settings.pr.draft ? '\nOpen as draft' : '')
    await this.sessions.send(chat.id, [{ type: 'file', name: 'create-pr.md', text }])
    return this.setPrState(ws, 'creating')
  }

  /** One button, three situations: conflicts, failing checks, or review comments. Each sends its own instructions, with what GitHub reports. */
  async resolvePr(id: string) {
    const ws = this.mustWs(id)
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    if (ws.prState !== 'conflict' && ws.prState !== 'cifail' && ws.prState !== 'changes') throw new Error('This pull request has nothing to fix.')
    const info = await this.github.info(ws.path, ws.branch, id)
    if (info) bus.push({ type: 'pr.info', info })
    const [name, text] = resolveFile(ws.prState, this.settings.pr.resolveInstructions, info)
    await this.sessions.send(chat.id, [{ type: 'file', name, text }])
    this.setPrState(ws, 'resolving')
  }

  /** The PR's checks, review comments and conflicts, for the Checks tab and the review card. */
  async getPr(id: string) {
    const ws = this.mustWs(id)
    if (!ws.prNumber) return null
    const info = await this.github.info(ws.path, ws.branch, id)
    if (info) bus.push({ type: 'pr.info', info })
    return info
  }

  /**
   * Reads the PR from GitHub and moves the header to its state. `settle` is true once the agent's turn is over:
   * until then Creating and Resolving hold, so the header doesn't flash the old state while the agent works.
   * A workspace with no PR yet only adopts an open one, never an old merged or closed PR on the same branch name.
   */
  async refreshPr(id: string, o: { settle?: boolean } = {}): Promise<Workspace> {
    const ws = this.mustWs(id)
    if (ws.status === 'archived') return ws
    const info = await this.github.info(ws.path, ws.branch, id)
    if (info) bus.push({ type: 'pr.info', info })
    const settle = o.settle ?? !this.agentBusy(ws)
    const hold = this.merging.has(id) || (!settle && (ws.prState === 'creating' || ws.prState === 'resolving'))
    let state: PrState
    if (hold) state = ws.prState
    else if (!info) state = ws.prState === 'creating' || !ws.prNumber ? 'none' : ws.prState === 'resolving' ? 'open' : ws.prState
    else if (!ws.prNumber && (info.state === 'merged' || info.state === 'closed')) state = 'none'
    else state = info.state
    const adopt = info && state !== 'none'
    const next = this.saveWs({
      ...ws, prState: state,
      ...(adopt ? { prNumber: info.number, prUrl: info.url, prTitle: info.title || ws.prTitle } : {}),
      ...(state === 'merged' && !ws.mergedAt ? { mergedAt: Date.now() } : {})
    })
    if (next.prState !== ws.prState) {
      bus.push({ type: 'pr', workspaceId: id, state: next.prState })
      bus.activity({ kind: 'pr.changed', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: `PR is ${next.prState}`, object: next.prNumber ? `#${next.prNumber}` : undefined })
      const text = prNote(next, info, this.mergedWith.get(id))
      if (text) this.note(id, text)
      if (next.prState === 'merged') { this.mergedWith.delete(id); void this.overlaps.check(ws.roomId).catch(() => undefined) }
    }
    return next
  }

  /** Merges with the method from Settings > PRs. With "require green checks" on, refuses until every check passed. */
  async mergePr(id: string) {
    const ws = this.mustWs(id)
    if (ws.prState !== 'ready' && ws.prState !== 'open') throw new Error('This pull request is not ready to merge.')
    if (this.settings.pr.requireGreen) {
      const info = await this.github.info(ws.path, ws.branch, id)
      if (!info) throw new Error('Could not read the pull request from GitHub.')
      bus.push({ type: 'pr.info', info })
      if (!allGreen(info.checks)) throw new Error('Checks have not passed yet. Merging needs green checks (Settings > Pull requests).')
    }
    const method = this.settings.pr.mergeMethod
    this.merging.add(id)
    this.setPrState(ws, 'merging')
    try {
      await this.github.merge(ws.path, ws.branch, method)
      this.mergedWith.set(id, method)
    } catch (e) {
      this.merging.delete(id)
      await this.refreshPr(id, { settle: true }).catch(() => undefined)
      throw e
    }
    this.merging.delete(id)
    return this.refreshPr(id, { settle: true })
  }

  async readyPr(id: string) { const ws = this.mustWs(id); await this.github.ready(ws.path, ws.branch); return this.refreshPr(id) }
  async reopenPr(id: string) { const ws = this.mustWs(id); await this.github.reopen(ws.path, ws.branch); return this.refreshPr(id) }

  /** After a merge or close: a fresh branch from the base in the same worktree. The chat stays. */
  async continuePr(id: string) {
    const ws = this.mustWs(id)
    if (ws.prState !== 'merged' && ws.prState !== 'closed') throw new Error('Continue is for a merged or closed pull request.')
    if (ws.mode !== 'worktree') throw new Error('Continue needs a worktree workspace. Start a new workspace to keep going.')
    const room = this.mustRoom(ws.roomId)
    if (ws.baseRef.startsWith('origin/')) await exec('git', ['-C', ws.path, 'fetch', '--quiet', 'origin'], { timeoutMs: 30000 })
    // feat/x-2 continues as feat/x-3, not feat/x-2-2.
    const stem = ws.branch.replace(/-\d+$/, '')
    const branch = await freeBranch(room.path, stem !== ws.branch && await branchExists(room.path, stem) ? stem : ws.branch)
    await git(ws.path, 'checkout', '-b', branch, ws.baseRef)
    const next = this.saveWs({ ...ws, branch, prState: 'none', prNumber: undefined, prUrl: undefined, prTitle: undefined })
    bus.push({ type: 'pr', workspaceId: id, state: 'none' })
    this.note(id, `Continuing on ${branch} from ${ws.baseRef.replace(/^origin\//, '')}. The chat stays.`)
    return next
  }

  /** Whether the workspace's PR chat is in a turn or has messages waiting for one (a create-pr.md sent mid-turn waits in the queue). */
  private agentBusy(ws: Workspace) {
    const chat = this.prChat(ws.id)
    return chat ? this.sessions.isRunning(chat.id) || this.sessions.queued(chat.id).length > 0 : false
  }

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
      'rooms.setPaused': async ({ roomId, paused }) => (paused ? this.pauseRoom(roomId, 'you') : this.resumeRoom(roomId)),
      'agents.seed': async ({ roomId, template }) => this.seedAgents(roomId, template),
      'chats.restart': async ({ chatId }) => { await this.sessions.restart(chatId); return { ok: true } },
      'rooms.overlaps': async ({ roomId }) => this.overlaps.check(roomId),
      'rooms.resolveOverlap': async ({ overlapId }) => { await this.sortOverlap(overlapId); return { ok: true } },
      'rooms.brief': async ({ roomId, text, agentId }) => {
        let chat: Chat
        if (agentId) {
          const ws = this.store.workspaces(roomId).find((w) => w.agentId === agentId && w.status !== 'archived')
          if (!ws) throw new Error('That agent has no open workspace. Brief the Lead instead.')
          const first = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
          if (!first) throw new Error('That agent has no open chat. Open a new chat in its workspace, or brief the Lead instead.')
          chat = first
        } else chat = await this.leadChat(roomId)
        await this.sessions.send(chat.id, [{ type: 'text', text }])
        // The log line under the brief, and the start of the briefing sequence on the floor (FloorSent.png).
        const to = this.store.workspace(chat.workspaceId)?.agentId
        const name = (await this.agents(roomId)).find((a) => a.id === to)?.name ?? 'the Lead'
        bus.activity({ kind: 'brief', roomId, workspaceId: chat.workspaceId, agentId: to, actor: 'you', text: agentId ? `messaged ${name}` : `briefed ${name}`, quote: text })
        return { chatId: chat.id, workspaceId: chat.workspaceId }
      },
      'agents.list': async ({ roomId, retired }) => (retired ? loadAgents(this.mustRoom(roomId).path, { retired: true }) : this.agents(roomId)),
      'agents.save': async ({ roomId, agentId, patch }) => this.saveAgentEdit(roomId, agentId, patch),
      'agents.draft': async ({ description, name, model }) => draftAgent({ description, name, model }),
      'agents.create': async ({ roomId, draft }) => this.hireFromDraft(roomId, draft),
      'agents.retire': async ({ roomId, agentId, handoffTo }) => { await this.retire(roomId, agentId, handoffTo); return { ok: true } },
      'agents.restore': async ({ roomId, agentId }) => this.restore(roomId, agentId),
      'agents.status': async ({ roomId }) => this.statusOf(roomId),
      'git.branches': async ({ roomId }) => listBranches(this.mustRoom(roomId).path),
      'github.prs': async ({ roomId, query }) => openPrs(this.mustRoom(roomId).path, query),
      'issues.list': async ({ query }) => searchIssues(linearToken(), query),
      'workspaces.list': async ({ roomId }) => this.store.workspaces(roomId),
      'workspaces.create': async ({ roomId, ...o }) => this.createWorkspace(roomId, o),
      'workspaces.restore': async ({ workspaceId }) => this.restoreWorkspace(workspaceId),
      'lead.ask': async ({ roomId, text }) => this.askLead(roomId, text),
      'account.get': async () => this.readAccount(),
      'account.signOut': async () => signOut(),
      'workspaces.archive': async ({ workspaceId, deleteBranch, push }) => {
        if (push) { const ws = this.mustWs(workspaceId); await pushBranch(ws.path, ws.branch) }
        await this.archiveWorkspace(workspaceId, deleteBranch)
        return { ok: true }
      },
      'workspaces.gitStatus': async ({ workspaceId }) => { const ws = this.mustWs(workspaceId); return gitStatus(ws.path, ws.branch, ws.baseRef) },
      'workspaces.discard': async ({ workspaceId }) => { await this.discard(workspaceId); return { ok: true } },
      'chats.compact': async ({ chatId }) => { await this.sessions.compact(chatId); return { ok: true } },
      'usage.notifyOnReset': async ({ type }) => {
        if (!this.limitTimers.has(type)) throw new Error('Kernel does not know when this limit resets, so it cannot tell you. Check /usage.')
        this.notifyReset.add(type)
        return { ok: true }
      },
      'account.signIn': async () => this.signIn(),
      'app.openTerminal': async ({ cwd, command }) => { await this.openTerminal(cwd, command); return { ok: true } },
      'app.checkOnline': async () => ({ online: this.network ? await this.network.check() : true }),
      'workspaces.changes': async ({ workspaceId }) => this.changes(workspaceId),
      'workspaces.diff': async ({ workspaceId, file }) => this.diff(workspaceId, file),
      'workspaces.tree': async ({ workspaceId }) => listTree(this.mustWs(workspaceId).path, await this.changes(workspaceId).catch(() => [])),
      'workspaces.readFile': async ({ workspaceId, path }) => readWorkspaceFile(this.mustWs(workspaceId).path, path),
      'chats.list': async ({ workspaceId }) => this.chatTabs(workspaceId),
      'chats.rename': async ({ chatId, title }) => this.renameChat(chatId, title),
      'chats.close': async ({ chatId }) => { this.closeChat(chatId); return { ok: true } },
      'chats.fork': async ({ chatId, itemId }) => this.forkChat(chatId, itemId),
      'terminal.write': async ({ chatId, data }) => { this.ensurePty(chatId); this.ptys.write(chatId, data); return { ok: true } },
      'terminal.resize': async ({ chatId, cols, rows }) => { this.ensurePty(chatId, { cols, rows }); this.ptys.resize(chatId, cols, rows); return { ok: true } },
      'chats.create': async ({ workspaceId, kind }) => { const first = this.store.chats(workspaceId)[0]; return this.newChat(workspaceId, kind === 'terminal' ? 'Terminal (claude)' : 'New chat', { model: first?.model ?? this.settings.models.engineers, effort: first?.effort ?? this.settings.models.effort, plan: false, kind }) },
      'chats.items': async ({ chatId }) => this.store.items(chatId),
      'checkpoints.list': async ({ workspaceId }) => listCheckpoints(this.mustWs(workspaceId)),
      'checkpoints.revert': async ({ workspaceId, checkpointId }) => this.revertCheckpoint(workspaceId, checkpointId),
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
      'notifications.list': async () => this.notifications.list(),
      'notifications.read': async ({ ids }) => this.notifications.read(ids),
      'approvals.list': async ({ roomId }) => this.store.approvals({ roomId }),
      'approvals.decide': async ({ id, decision }) => { const a = this.approvals.decide(id, decision); if (!a) throw new Error('This request already timed out or was answered.'); return a },
      'pr.create': async ({ workspaceId, draft }) => this.createPr(workspaceId, draft),
      'pr.refresh': async ({ workspaceId }) => this.refreshPr(workspaceId),
      'pr.merge': async ({ workspaceId }) => this.mergePr(workspaceId),
      'pr.resolve': async ({ workspaceId }) => { await this.resolvePr(workspaceId); return { ok: true } },
      'pr.get': async ({ workspaceId }) => this.getPr(workspaceId),
      'pr.continue': async ({ workspaceId }) => this.continuePr(workspaceId),
      'pr.ready': async ({ workspaceId }) => this.readyPr(workspaceId),
      'pr.reopen': async ({ workspaceId }) => this.reopenPr(workspaceId),
      'scripts.run': async ({ workspaceId, kind }) => {
        const ws = this.mustWs(workspaceId); const room = this.mustRoom(ws.roomId); const repo = await loadRepoSettings(room.path)
        const script = repo.scripts[kind]
        if (!script) throw new Error(`No ${kind} script in .kernel/settings.toml`)
        if (kind === 'setup' && ws.status === 'failed') { void this.retrySetup(workspaceId).catch(() => undefined); return { ok: true } }
        void runScript({ workspaceId, kind, script, cwd: ws.path, port: ws.port, root: room.path })
        return { ok: true }
      },
      'scripts.stop': async ({ workspaceId }) => { stopScript(workspaceId, 'run'); return { ok: true } },
      'tasks.list': async ({ roomId }) => this.tasks.list(roomId),
      'activity.recent': async ({ roomId, limit }) => this.store.activity(roomId, limit),
      'usage.get': async () => this.sessions.usage(),
      'settings.get': async () => this.settings,
      'settings.set': async ({ patch }) => this.setSettings(patch),
      'app.info': async () => ({ version: this.o.version ?? '0.1.0', dataDir: this.o.dataDir }),
      'app.exportLogs': async () => this.exportLogs(),
      'settings.room': async ({ roomId }) => loadRepoSettings(this.mustRoom(roomId).path)
    }
  }

  private preflight() {
    return runPreflight({ hookPort: this.settings.hookPort, hookServerUp: !!this.hookServer?.listening, agentTeams: this.settings.models.agentTeams })
  }

  private get claudeSettings() { return this.o.claudeSettingsFile ?? join(this.home, '.claude', 'settings.json') }
}
