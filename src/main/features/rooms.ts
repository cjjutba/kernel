import { basename, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { KernelApi } from '@shared/ipc'
import type { AgentOrigin, AgentStatus, NewRoomRequest, PushCheck, Room, RoomSetupStep } from '@shared/types'
import { newId } from '../db'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { PAUSE_KEEPS } from '../services/sessions'
import { KERNEL_HOOK_EVENTS } from '../services/hooksInstaller'
import { DEFAULT_BASE_REF, loadRepoSettings } from '../services/settings'
import { defaultBranch, onRemote, remoteRepo, roomWorktreeRoot, slugify } from '../services/worktrees'
import { scanInstructions } from '../services/instructionConflicts'
import { exec } from '../services/exec'
import { checkPush, pushStepOf } from '../services/preflight'
import { resolveFilesToCopy } from '../services/filesToCopy'
import { AVATAR_FAILED, githubOwner, readImage } from '../services/roomIcons'
import { agentFiles, assertFreeFolder, assertInitable, cloneRepo, copyTemplate, ensureRepoSettings, expandHome, initGit, inspectFolder, installCommand, listRepos, recentFolders, refuseHome, seatStarterTeam, tildify } from '../services/rooms'
import { Feature } from './feature'

/** Where Room setup says a room's agents came from, when it asks for a roster (RoomSetupRoster.png). */
const AGENT_PLACES: Record<AgentOrigin, string> = { project: '.claude/agents', personal: '~/.claude/agents', plugin: 'Claude Code plugins' }

/** Adding, creating, pausing, changing and removing rooms (KERNEL-326). */
export class Rooms extends Feature {
  /** By room id, the last push check, null for a room that had no remote (KERNEL-460). */
  private readonly pushChecks = new Map<string, PushCheck | null>()
  /** By room id, the push check running now, so a second ask waits for it. */
  private readonly checking = new Map<string, Promise<PushCheck | null>>()
  /** By room id, the setup steps last published, so Check again on room setup can update its step. */
  private readonly setups = new Map<string, { steps: RoomSetupStep[]; publish: () => void }>()

  async addRoom(path: string, name?: string): Promise<Room> {
    const existing = this.store.rooms().find((r) => r.path === path)
    if (existing) return existing
    refuseHome(path, this.home)
    const remote = await this.k.config.remoteFor(path)
    const id = newId()
    // Its worktrees go in a folder named by its id, so another room with the same name gets its own (KERNEL-231).
    const room: Room = { id, name: name ?? basename(path), path, repo: await remoteRepo(path, remote), defaultBranch: await defaultBranch(path, remote).catch(() => 'main'), paused: false, worktreeDir: id, createdAt: Date.now() }
    this.store.saveRoom(room)
    await this.k.team.agents(room.id)
    await this.k.trust.untrusted(room).catch(() => null)
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
      refuseHome(path, this.home)
      const info = await inspectFolder(path, this.home)
      if (!info.git && !req.initGit) throw new Error(`${tildify(path, this.home)} is not a git repository. Initialize git to use it.`)
      // Refused here, before the room exists, rather than in the setup step (KERNEL-231).
      if (!info.git) await assertInitable(path, this.home)
    } else {
      path = expandHome(req.cloneTo ?? join(this.home, 'Projects', slugify(req.source === 'repo' ? basename(req.from) : name)), this.home)
      await assertFreeFolder(path, this.home)
    }
    const taken = this.store.rooms().find((r) => r.path === path)
    if (taken) throw new Error(`${tildify(path, this.home)} is already the room ${taken.name}.`)
    const id = newId()
    const room: Room = {
      id, name, desc: req.desc?.trim() || undefined, kind: req.source, path,
      repo: req.source === 'repo' ? req.from : undefined, defaultBranch: req.baseBranch || 'main', paused: false, worktreeDir: id, createdAt: Date.now()
    }
    this.store.saveRoom(room)
    bus.push({ type: 'room', room })
    bus.track({ name: 'room.created', source: req.source })
    void this.setupRoom(room, req).catch(() => undefined)
    return room
  }

  /**
   * The steps of RoomSetup.png. A failed step records its error and the next ones still run, except when there is no
   * checkout. Check push access joins them once the checkout has a remote (KERNEL-460). Code host follows the checkout
   * (RoomSetupGitHub.png, RoomSetupLocal.png, KERNEL-477).
   */
  private async setupRoom(room: Room, req: NewRoomRequest) {
    const worktrees = roomWorktreeRoot(this.settings.worktreeRoot, room)
    const steps: RoomSetupStep[] = [
      { id: 'clone', title: req.source === 'repo' ? `Clone ${req.from}` : req.source === 'scratch' ? `Copy ${req.from}` : 'Use your folder', detail: tildify(room.path, this.home), state: 'wait' },
      { id: 'host', title: 'Code host', detail: '', state: 'wait' },
      { id: 'worktrees', title: 'Create the worktree folder', detail: tildify(worktrees, this.home), state: 'wait' },
      { id: 'install', title: 'Install dependencies', detail: 'Checking the lockfile', state: 'wait' },
      { id: 'copy', title: 'Copy local files', detail: '', state: 'wait' },
      { id: 'hooks', title: 'Install hooks', detail: `${KERNEL_HOOK_EVENTS.length} events to localhost:${this.settings.hookPort}`, state: 'wait' },
      { id: 'agents', title: 'Seat agents', detail: '', state: 'wait' }
    ]
    const publish = () => bus.push({ type: 'room.setup', roomId: room.id, steps: steps.map((s) => ({ ...s })) })
    this.setups.set(room.id, { steps, publish })
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
      let inited = false
      if (req.source === 'repo') await cloneRepo(req.from, room.path)
      else if (req.source === 'scratch') await copyTemplate(req.from, room.path)
      else if (req.initGit && !(await inspectFolder(room.path, this.home)).git) { await initGit(room.path, this.home); inited = true }
      const remote = await this.k.config.remoteFor(room.path)
      const next: Room = { ...room, repo: room.repo ?? (await remoteRepo(room.path, remote)), defaultBranch: req.baseBranch || (await defaultBranch(room.path, remote).catch(() => 'main')) }
      this.store.saveRoom(next)
      bus.push({ type: 'room', room: next })
      // Kernel commits nothing in the user's folder, so the first commit is theirs, and new workspaces wait for it (KERNEL-231).
      if (inited) return { detail: `Git initialized in ${tildify(room.path, this.home)}. Make the first commit so new workspaces have something to branch from.` }
    })
    if (!checkedOut) return
    // Read from the checkout's remote, so a folder with no GitHub remote merges on this Mac (KERNEL-477).
    await step('host', async () => {
      const { host } = await this.k.codeHost.detect(room.path)
      const next = this.store.saveRoom({ ...this.mustRoom(room.id), host })
      bus.push({ type: 'room', room: next })
      return { detail: this.k.codeHost.line(next) }
    })
    const remote = await this.k.config.remoteFor(room.path)
    if ((await exec('git', ['-C', room.path, 'remote', 'get-url', '--push', remote])).code === 0) {
      steps.splice(steps.findIndex((s) => s.id === 'agents'), 0, { id: 'push', title: 'Check push access', detail: '', state: 'wait' })
      publish()
    }
    // Not a step of its own: reading two files can't fail setup, and Room setup lists what it found under the team.
    await this.findInstructionConflicts(room.id).catch(() => undefined)

    await step('worktrees', async () => {
      await mkdir(worktrees, { recursive: true })
      // The file Kernel writes sets no script, so there is nothing of Kernel's to trust (KERNEL-682). The check still runs,
      // so the room knows where it stands on what the repo brought (KERNEL-209).
      await ensureRepoSettings(room.path)
      await this.k.trust.untrusted(this.mustRoom(room.id))
    })
    await step('install', async () => {
      const { command, reason, runsRepoCode } = await installCommand(room.path)
      if (!command) return { detail: reason ?? 'Nothing to install' }
      // The install would run the repo's install scripts, or its own code. Then the command waits for trust, and trusting it
      // runs it (KERNEL-260, KERNEL-444, KERNEL-682).
      if (await this.k.trust.holdInstall(room, runsRepoCode)) return { detail: runsRepoCode ? "Skipped until you trust this repo's scripts" : "Skipped until you trust this repo's install scripts" }
      update('install', { detail: command })
      const r = await exec('sh', ['-c', command], { cwd: room.path, timeoutMs: 600_000 })
      if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join('\n') || `${command} failed`)
    })
    await step('copy', async () => {
      const { files } = await loadRepoSettings(room.path)
      const present = (await resolveFilesToCopy(room.path, files.copy, [], files.exclude)).map((f) => f.path)
      if (!present.length) return { detail: 'No local files to copy' }
      const detail = present.length > 5 ? `${present.slice(0, 5).join(', ')} and ${present.length - 5} more` : present.join(', ')
      // A copied file that looks like production warns, by name, and the room still opens (KERNEL-449).
      const production = (await this.k.config.production(room)).map((h) => h.path)
      return production.length ? { state: 'warn' as const, detail, production } : { detail }
    })
    await step('hooks', async () => {
      const status = await this.k.hooks.hooksStatus()
      if (!status.installed) throw new Error('Kernel hooks are not in your Claude settings yet. Open Check hooks in the sidebar to install them.')
    })
    // A push that can't work is a warning here, never a failure, so the room still opens (KERNEL-437).
    if (steps.some((s) => s.id === 'push')) {
      await step('push', async () => {
        const c = await this.runPushCheck(room.id)
        return c ? pushStepOf(c) : { detail: 'No remote to push to' }
      })
    }
    // A repo that brings its own agents keeps them, and Room setup shows the team for review (KERNEL-397). An empty one gets
    // the starter agents picked in New room. Kernel fills in a missing Lead either way, and Kernel's code review
    // a missing reviewer (KERNEL-553).
    // A repo with more agents than one team needs asks who joins (KERNEL-465, RoomSetupRoster.png).
    await step('agents', async () => {
      const brought = (await agentFiles(room.path)).length
      if (!brought) {
        if (!this.o.starterDir) throw new Error('No starter team found. Add agent files to .claude/agents.')
        await seatStarterTeam(this.o.starterDir, room.path, req.team)
      }
      const list = await this.k.team.agents(room.id)
      bus.push({ type: 'agents', roomId: room.id, agents: this.k.team.listed(room.id, list) })
      for (const a of list) bus.push({ type: 'agent.status', roomId: room.id, agentId: a.id, status: 'idle' })
      // Personal and plugin agents join every room, so they count toward a roster even when the repo brought none.
      const roster = await this.k.team.rosterOf(room.id)
      if (roster.needed) {
        const where = [...new Set(list.filter((a) => !a.builtIn).map((a) => AGENT_PLACES[a.origin ?? 'project']))]
        const places = where.length > 1 ? `${where.slice(0, -1).join(', ')} and ${where[where.length - 1]}` : where[0]
        return { detail: `${roster.agents} agents found in ${places}`, ...(brought ? { brought } : {}), roster }
      }
      const own = list.filter((a) => !a.builtIn).map((a) => a.name)
      // Kernel always leads (KERNEL-692), so a Lead file shapes it and isn't listed.
      const detail = [own.length ? `${own.join(', ')} from .claude/agents` : '', list.some((a) => a.lead) ? 'Kernel leads' : ''].filter(Boolean).join(', ')
      return { detail: detail || 'No agents in .claude/agents', ...(brought ? { brought } : {}), roster }
    })
  }

  /** Runs the room's push check, or waits for the one running, and keeps the result (KERNEL-460). A local room never asks gh (KERNEL-477). */
  private runPushCheck(roomId: string): Promise<PushCheck | null> {
    let running = this.checking.get(roomId)
    if (running) return running
    const room = this.mustRoom(roomId)
    running = (async () => {
      try {
        const c = await checkPush(room.path, await this.k.config.remoteFor(room.path), { gh: room.host !== 'local' })
        this.pushChecks.set(roomId, c)
        return c
      } finally { this.checking.delete(roomId) }
    })()
    this.checking.set(roomId, running)
    return running
  }

  /**
   * Whether git can push from the room (Settings, Room, Git): the last result while it is for the room's current remote,
   * else a new one. `recheck` always runs it again, and updates Check push access while room setup shows it.
   */
  async pushCheck(roomId: string, recheck = false): Promise<PushCheck | null> {
    // No remote is asked again each time, since it costs one local git call and the room's section has no Check again.
    const last = this.pushChecks.get(roomId)
    if (!recheck && last && last.remote === await this.k.config.remoteFor(this.mustRoom(roomId).path)) return last
    const setup = recheck ? this.setups.get(roomId) : undefined
    const shown = setup?.steps.find((s) => s.id === 'push')
    if (!setup || !shown) return this.runPushCheck(roomId)
    Object.assign(shown, { state: 'run', meta: 'running' })
    setup.publish()
    try {
      const c = await this.runPushCheck(roomId)
      Object.assign(shown, { meta: undefined }, c ? pushStepOf(c) : { state: 'ok', detail: 'No remote to push to' })
      return c
    } catch (e) {
      Object.assign(shown, { state: 'warn', meta: undefined, detail: (e as Error).message, fix: { action: 'recheck' } })
      throw e
    } finally { setup.publish() }
  }

  /**
   * Reads the repo's CLAUDE.md, .claude/CLAUDE.md and AGENTS.md for rules that fight Kernel's workflow and keeps them on the
   * room (KERNEL-452). The branches are the ones Kernel's agents never commit or push to, and the base is where teammates'
   * worktrees start, as `createWorkspace` picks it. The files are never written.
   */
  async findInstructionConflicts(roomId: string): Promise<Room> {
    const room = this.mustRoom(roomId)
    const repo = await loadRepoSettings(room.path)
    const remote = await this.k.config.remoteFor(room.path, repo)
    const set = repo.workspace.baseRef ?? (this.settings.workspace.baseRef === DEFAULT_BASE_REF ? undefined : this.settings.workspace.baseRef)
    const base = onRemote(set ?? `${remote}/${room.defaultBranch}`, remote)
    const instructionConflicts = await scanInstructions(room.path, { branches: [room.defaultBranch, ...this.settings.permissions.protectedBranches], base })
    // Read again after the scan, so a change that landed meanwhile stays.
    const next = this.store.saveRoom({ ...this.mustRoom(roomId), instructionConflicts })
    bus.push({ type: 'room', room: next })
    return next
  }

  /**
   * Pause a room: every agent finishes the step it is on, then waits, and sends are held until Resume.
   * `by` is who asked. A limit pause (`limit`) is lifted by whoever detects the reset, with `resumeRoom`.
   */
  pauseRoom(roomId: string, by: 'you' | 'limit'): Room {
    const room = this.store.saveRoom({ ...this.mustRoom(roomId), paused: true, pausedBy: by })
    this.sessions.pause(roomId)
    // Someone who needs the user, is blocked or is offline keeps saying so.
    const now = this.k.team.statusOf(roomId)
    for (const a of this.agentsSync(roomId)) if (!PAUSE_KEEPS.has(now[a.id])) bus.push({ type: 'agent.status', roomId, agentId: a.id, status: 'paused' })
    bus.push({ type: 'room', room })
    bus.activity({ kind: 'room.paused', roomId, actor: by === 'you' ? 'you' : 'kernel', text: by === 'you' ? 'paused' : 'paused the room for', object: by === 'you' ? room.name : 'a usage limit' })
    return room
  }

  resumeRoom(roomId: string, by: 'you' | 'limit' = 'you'): Room {
    const { pausedBy: _by, ...rest } = this.mustRoom(roomId)
    const room = this.store.saveRoom({ ...rest, paused: false })
    const before = this.k.team.statusOf(roomId)
    this.sessions.resume(roomId)
    // A running chat in plan mode is planning, as it was before the pause.
    const running = (agentId: string) => this.store.workspaces(roomId).filter((w) => w.agentId === agentId).flatMap((w) => this.store.chats(w.id)).filter((c) => this.sessions.isRunning(c.id))
    const resumed = (agentId: string): AgentStatus => { const r = running(agentId); return !r.length ? 'idle' : r.some((c) => !c.plan) ? 'working' : 'planning' }
    for (const a of this.agentsSync(roomId)) if (before[a.id] === 'paused') bus.push({ type: 'agent.status', roomId, agentId: a.id, status: resumed(a.id) })
    bus.push({ type: 'room', room })
    bus.activity({ kind: 'room.resumed', roomId, actor: by === 'you' ? 'you' : 'kernel', text: by === 'you' ? 'resumed' : 'resumed after the usage limit reset', object: by === 'you' ? room.name : undefined })
    return room
  }

  async updateRoom(roomId: string, patch: Partial<Pick<Room, 'name' | 'desc' | 'hidden' | 'archived' | 'desks' | 'allow' | 'permissionMode'>>): Promise<Room> {
    const before = this.mustRoom(roomId)
    // Archiving a room (Settings > Room) stops every agent and archives its open workspaces. The record and the folder stay.
    if (patch.archived && !before.archived) {
      // A workspace that fails to archive keeps the room open, and the error names it, so nothing is half archived without the user knowing.
      const failed: string[] = []
      for (const ws of this.store.workspaces(roomId).filter((w) => w.status !== 'archived')) {
        try { await this.k.archiveWorkspace(ws.id) } catch (e) { this.sessions.stopWorkspace(ws.id, { tree: true }); failed.push(`${ws.name}: ${(e as Error).message}`) }
      }
      if (failed.length) throw new Error(`Could not archive ${failed.length === 1 ? 'a workspace' : `${failed.length} workspaces`}, so ${before.name} stays open. ${failed.join(' ')}`)
    }
    const room = this.store.saveRoom({ ...before, ...patch })
    bus.push({ type: 'room', room })
    // The room's mode moves its live chats now (KERNEL-447).
    if ('permissionMode' in patch && patch.permissionMode !== before.permissionMode) this.sessions.applyModes()
    return room
  }

  /**
   * Sets the room icon (KERNEL-241). The new file is saved before the room points at it and the old file goes after,
   * so a failed avatar fetch or a rejected image leaves the room as it was.
   */
  private async setRoomIcon(roomId: string, icon: KernelApi['rooms.setIcon']['req']['icon']): Promise<Room> {
    const before = this.mustRoom(roomId)
    let next: Room['icon']
    if (icon.kind === 'github') {
      const owner = githubOwner(before.repo)
      if (!owner) throw new Error(AVATAR_FAILED)
      next = await this.k.roomIcons.save(roomId, 'github', await this.k.avatar(owner), before.icon)
    } else if (icon.kind === 'image') {
      next = await this.k.roomIcons.save(roomId, 'image', await readImage(icon.path), before.icon)
    }
    // Read again after the download: the room may have gone, or another change may have landed meanwhile.
    const now = this.store.room(roomId)
    if (!now) { await this.k.roomIcons.remove(next); throw new Error(`Unknown room ${roomId}`) }
    const { icon: old, ...rest } = now
    const room = this.store.saveRoom(next ? { ...rest, icon: next } : rest)
    if (old?.file !== next?.file) await this.k.roomIcons.remove(old)
    bus.push({ type: 'room', room })
    return room
  }

  /**
   * Forgets a room: stops its agents and scripts, archives its workspaces and deletes Kernel's record of them.
   * The folder, its git history and .claude/agents are never touched. Worktrees are removed only when asked.
   */
  /**
   * Removes a room (ConfirmRemoveRoom.png): every open workspace is archived for real, with its archive script, its setup
   * stopped and its branch kept when it has unpushed commits, then Kernel forgets the room (D-028). Worktree folders go
   * only when "Also delete the worktrees" is ticked. If a workspace fails to archive, the error names it and the room stays.
   */
  async removeRoom(roomId: string, deleteWorktrees: boolean) {
    const room = this.mustRoom(roomId)
    const failed: string[] = []
    for (const ws of this.store.workspaces(roomId).filter((w) => w.status !== 'archived')) {
      try { await this.k.archiveWorkspace(ws.id, undefined, { keepWorktree: !deleteWorktrees, removingRoom: true }) } catch (e) { this.sessions.stopWorkspace(ws.id, { tree: true }); failed.push(`${ws.name}: ${(e as Error).message}`) }
    }
    if (failed.length) throw new Error(`Could not archive ${failed.length === 1 ? 'a workspace' : `${failed.length} workspaces`}, so ${room.name} stays. ${failed.join(' ')}`)
    // Each cleanup reads the room and runs its archive script, so the record goes only once every one has ended (KERNEL-702).
    for (const ws of this.store.workspaces(roomId)) await this.k.archive.cleanedUp(ws.id)
    this.k.overlaps.forget(roomId)
    const shared = this.store.sharedFiles({ roomId }).map((f) => f.id)
    this.store.deleteRoom(roomId)
    this.k.envStore.dropRoom(roomId)
    this.k.trust.envFilesOk.delete(roomId)
    await this.k.roomIcons.remove(room.icon)
    await this.k.shared.remove(shared)
    await this.k.trust.forgetRoom(roomId)
    this.k.team.forgetRoom(roomId)
    this.pushChecks.delete(roomId)
    this.setups.delete(roomId)
  }

  handlers() {
    return {
      'rooms.list': async () => this.store.rooms(),
      'rooms.add': async ({ path, name }) => this.addRoom(path, name),
      'rooms.create': async (req) => this.createRoom(req),
      'rooms.update': async ({ roomId, patch }) => this.updateRoom(roomId, patch),
      'rooms.setIcon': async ({ roomId, icon }) => this.setRoomIcon(roomId, icon),
      'rooms.icon': async ({ roomId }) => this.k.roomIcons.dataUrl(this.mustRoom(roomId).icon),
      'rooms.remove': async ({ roomId, deleteWorktrees }) => { await this.removeRoom(roomId, deleteWorktrees); return { ok: true } },
      'rooms.inspectFolder': async ({ path }) => inspectFolder(path, this.home),
      'rooms.recentFolders': async () => recentFolders(this.store.rooms().map((r) => r.path), this.home),
      'rooms.pushCheck': async ({ roomId, recheck }) => this.pushCheck(roomId, recheck),
      'github.repos': async ({ query }) => listRepos(query),
      'rooms.setPaused': async ({ roomId, paused }) => (paused ? this.pauseRoom(roomId, 'you') : this.resumeRoom(roomId))
    } satisfies Partial<Handlers>
  }
}
