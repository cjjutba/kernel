import { basename, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { KernelApi } from '@shared/ipc'
import type { AgentStatus, NewRoomRequest, Room, RoomSetupStep } from '@shared/types'
import { newId } from '../db'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { PAUSE_KEEPS } from '../services/sessions'
import { KERNEL_HOOK_EVENTS } from '../services/hooksInstaller'
import { loadRepoSettings, localSettingsOwn } from '../services/settings'
import { defaultBranch, remoteRepo, roomWorktreeRoot, slugify } from '../services/worktrees'
import { exec } from '../services/exec'
import { resolveFilesToCopy } from '../services/filesToCopy'
import { AVATAR_FAILED, githubOwner, readImage } from '../services/roomIcons'
import { agentFiles, assertFreeFolder, assertInitable, cloneRepo, copyTemplate, ensureRepoSettings, expandHome, initGit, inspectFolder, installCommand, installScripts, listRepos, recentFolders, refuseHome, seatStarterTeam, tildify } from '../services/rooms'
import { Feature } from './feature'

/** Adding, creating, pausing, changing and removing rooms (KERNEL-326). */
export class Rooms extends Feature {
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

  /** The six steps of RoomSetup.png. A failed step records its error and the next ones still run, except when there is no checkout. */
  private async setupRoom(room: Room, req: NewRoomRequest) {
    const worktrees = roomWorktreeRoot(this.settings.worktreeRoot, room)
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

    await step('worktrees', async () => {
      await mkdir(worktrees, { recursive: true })
      // A settings.toml Kernel wrote holds Kernel's own install command, so it needs no trusting. One the repo brought does (KERNEL-209).
      // A settings.local.toml the repo committed is the repo's, not Kernel's, so then nothing is trusted.
      // The install command runs the repo's own install scripts, though, and those still wait for the user (KERNEL-260, D-078).
      if (await ensureRepoSettings(room.path) && await localSettingsOwn(room.path) && !(await installScripts(room.path)).length) await this.k.trust.trustCurrent(room)
    })
    await step('install', async () => {
      const { command, reason } = await installCommand(room.path)
      if (!command) return { detail: reason ?? 'Nothing to install' }
      // The install would run the repo's install scripts. Trusting them runs it (KERNEL-260).
      if (await this.k.trust.holdInstall(room)) return { detail: "Skipped until you trust this repo's install scripts" }
      update('install', { detail: command })
      const r = await exec('sh', ['-c', command], { cwd: room.path, timeoutMs: 600_000 })
      if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join('\n') || `${command} failed`)
    })
    await step('copy', async () => {
      const present = (await resolveFilesToCopy(room.path, (await loadRepoSettings(room.path)).files.copy)).map((f) => f.path)
      if (!present.length) return { detail: 'No local files to copy' }
      return { detail: present.length > 5 ? `${present.slice(0, 5).join(', ')} and ${present.length - 5} more` : present.join(', ') }
    })
    await step('hooks', async () => {
      const status = await this.k.hooks.hooksStatus()
      if (!status.installed) throw new Error('Kernel hooks are not in your Claude settings yet. Open Check hooks in the sidebar to install them.')
    })
    // A repo that brings its own agents keeps them, and Room setup shows the team for review (KERNEL-397). An empty one gets
    // the starter teammates picked in New room. Kernel's own Rowan and Theo fill in a missing Lead or reviewer either way.
    // A repo with more agents than one team needs asks who joins (KERNEL-465, RoomSetupRoster.png).
    await step('agents', async () => {
      const brought = (await agentFiles(room.path)).length
      if (!brought) {
        if (!this.o.starterDir) throw new Error('No starter team found. Add agent files to .claude/agents.')
        await seatStarterTeam(this.o.starterDir, room.path, req.team)
      }
      const list = await this.k.team.agents(room.id)
      bus.push({ type: 'agents', roomId: room.id, agents: list })
      for (const a of list) bus.push({ type: 'agent.status', roomId: room.id, agentId: a.id, status: 'idle' })
      const roster = brought ? await this.k.team.rosterOf(room.id) : undefined
      if (roster?.needed) return { detail: `${roster.agents} agents found in .claude/agents`, brought, roster }
      const own = list.filter((a) => !a.builtIn).map((a) => a.name)
      const kernel = list.filter((a) => a.builtIn).map((a) => a.name)
      const detail = [own.length ? `${own.join(', ')} from .claude/agents` : '', kernel.length ? `${kernel.join(' and ')} from Kernel` : ''].filter(Boolean).join(', ')
      return { detail: detail || 'No agents in .claude/agents', ...(brought ? { brought, roster } : {}) }
    })
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

  async updateRoom(roomId: string, patch: Partial<Pick<Room, 'name' | 'desc' | 'hidden' | 'archived' | 'desks' | 'allow'>>): Promise<Room> {
    const before = this.mustRoom(roomId)
    // Archiving a room (Settings > Room) stops every agent and archives its open workspaces. The record and the folder stay.
    if (patch.archived && !before.archived) {
      // A workspace that fails to archive keeps the room open, and the error names it, so nothing is half archived without the user knowing.
      const failed: string[] = []
      for (const ws of this.store.workspaces(roomId).filter((w) => w.status !== 'archived')) {
        try { await this.k.archiveWorkspace(ws.id) } catch (e) { this.sessions.stopWorkspace(ws.id); failed.push(`${ws.name}: ${(e as Error).message}`) }
      }
      if (failed.length) throw new Error(`Could not archive ${failed.length === 1 ? 'a workspace' : `${failed.length} workspaces`}, so ${before.name} stays open. ${failed.join(' ')}`)
    }
    const room = this.store.saveRoom({ ...before, ...patch })
    bus.push({ type: 'room', room })
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
      try { await this.k.archiveWorkspace(ws.id, undefined, { keepWorktree: !deleteWorktrees, removingRoom: true }) } catch (e) { this.sessions.stopWorkspace(ws.id); failed.push(`${ws.name}: ${(e as Error).message}`) }
    }
    if (failed.length) throw new Error(`Could not archive ${failed.length === 1 ? 'a workspace' : `${failed.length} workspaces`}, so ${room.name} stays. ${failed.join(' ')}`)
    this.k.overlaps.forget(roomId)
    const shared = this.store.sharedFiles({ roomId }).map((f) => f.id)
    this.store.deleteRoom(roomId)
    this.k.envStore.dropRoom(roomId)
    this.k.trust.envFilesOk.delete(roomId)
    await this.k.roomIcons.remove(room.icon)
    await this.k.shared.remove(shared)
    await this.k.trust.forgetRoom(roomId)
    this.k.team.forgetRoom(roomId)
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
      'github.repos': async ({ query }) => listRepos(query),
      'rooms.setPaused': async ({ roomId, paused }) => (paused ? this.pauseRoom(roomId, 'you') : this.resumeRoom(roomId))
    } satisfies Partial<Handlers>
  }
}
