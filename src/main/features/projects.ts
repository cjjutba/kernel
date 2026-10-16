import { basename, join } from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'
import type { KernelApi } from '@shared/ipc'
import type { AgentOrigin, AgentStatus, NewProjectRequest, PushCheck, Project, ProjectSetupStep } from '@shared/types'
import { newId } from '../db'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { PAUSE_KEEPS } from '../services/sessions'
import { KERNEL_HOOK_EVENTS } from '../services/hooksInstaller'
import { DEFAULT_BASE_REF, loadRepoSettings } from '../services/settings'
import { defaultBranch, hasCommit, onRemote, remoteRepo, projectWorktreeRoot, slugify } from '../services/worktrees'
import { scanInstructions } from '../services/instructionConflicts'
import { exec } from '../services/exec'
import { checkPush, pushStepOf } from '../services/preflight'
import { resolveFilesToCopy } from '../services/filesToCopy'
import { AVATAR_FAILED, githubOwner, readImage } from '../services/projectIcons'
import { removeTree } from '../services/removeTree'
import { agentFiles, assertFreeFolder, assertInitable, cloneRepo, copyTemplate, createGitHubRepo, ensureRepoSettings, exists, expandHome, initGit, inspectFolder, installCommand, listOwners, listRepos, makeEmptyRepo, recentFolders, refuseHome, repoAvailable, seatStarterTeam, tildify } from '../services/projects'
import { Feature } from './feature'

/** Where Project setup says a project's agents came from, when it asks for a roster (ProjectSetupRoster.png). */
const AGENT_PLACES: Record<AgentOrigin, string> = { project: '.claude/agents', personal: '~/.claude/agents', plugin: 'Claude Code plugins' }

/** The order setup runs its steps in, so a retry knows which come after the failed one (KERNEL-876). */
const STEP_ORDER: ProjectSetupStep['id'][] = ['clone', 'github', 'host', 'worktrees', 'install', 'copy', 'hooks', 'push', 'agents']

/**
 * A project's setup: the steps last published, the request that started it, the run going now, and whether Kernel seated
 * the starter team, so a retry still counts those agents as Kernel's rather than the repo's. `made` says the checkout's
 * folder wasn't there when setup started, so what a failed clone left in it is Kernel's to remove (KERNEL-883).
 */
interface Setup { steps: ProjectSetupStep[]; publish: () => void; req: NewProjectRequest; running?: Promise<void>; seated?: boolean; made?: boolean }

/** What a setup that hasn't finished cleanly keeps under the meta key `projectSetups`, so Try again works after a restart (KERNEL-883). */
type SavedSetup = Pick<Setup, 'steps' | 'req' | 'seated' | 'made'>

/** A setup with a step that failed, or that hasn't finished yet. Only these are saved. */
const unfinished = (steps: ProjectSetupStep[]) => steps.some((s) => s.state !== 'ok' && s.state !== 'warn')

/** Adding, creating, pausing, changing and removing projects (KERNEL-326). */
export class Projects extends Feature {
  /** By project id, the last push check, null for a project that had no remote (KERNEL-460). */
  private readonly pushChecks = new Map<string, PushCheck | null>()
  /** By project id, the push check running now, so a second ask waits for it. */
  private readonly checking = new Map<string, Promise<PushCheck | null>>()
  /** By project id, the project's setup, so Check again can update its step and Try again can run it again. */
  private readonly setups = new Map<string, Setup>()
  /** Whether the setups saved before this launch are in `setups` yet. Read on first use, since features have no start of their own. */
  private restored = false

  async addProject(path: string, name?: string): Promise<Project> {
    const existing = this.store.projects().find((r) => r.path === path)
    if (existing) return existing
    refuseHome(path, this.home)
    const remote = await this.k.config.remoteFor(path)
    const id = newId()
    // Its worktrees go in a folder named by its id, so another project with the same name gets its own (KERNEL-231).
    const project: Project = { id, name: name ?? basename(path), path, repo: await remoteRepo(path, remote), defaultBranch: await defaultBranch(path, remote).catch(() => 'main'), paused: false, worktreeDir: id, createdAt: Date.now() }
    this.store.saveProject(project)
    await this.k.team.agents(project.id)
    return project
  }

  // ---------- new projects

  /**
   * Creates the project's record and returns it at once. The slow part (clone, install, seating agents) runs behind it
   * and reports through `project.setup` push events, which ProjectSetup.png draws.
   */
  async createProject(req: NewProjectRequest): Promise<Project> {
    const name = req.name.trim()
    if (!name) throw new Error('Give the project a name.')
    let path: string
    if (req.source === 'folder') {
      path = expandHome(req.from, this.home)
      refuseHome(path, this.home)
      const info = await inspectFolder(path, this.home)
      if (!info.git && !req.initGit && !req.github) throw new Error(`${tildify(path, this.home)} is not a git repository. Initialize git to use it.`)
      // Refused here, before the project exists, rather than in the setup step (KERNEL-231).
      if (!info.git) await assertInitable(path, this.home)
    } else {
      path = expandHome(req.cloneTo ?? join(this.home, 'Projects', slugify(req.source === 'repo' ? basename(req.from) : name)), this.home)
      await assertFreeFolder(path, this.home)
    }
    // Recorded before anything runs: only a folder that wasn't there yet is Kernel's to clear for a retry (KERNEL-883).
    const made = req.source !== 'folder' && !(await exists(path))
    const taken = this.store.projects().find((r) => r.path === path)
    if (taken) throw new Error(`${tildify(path, this.home)} is already the project ${taken.name}.`)
    const id = newId()
    const project: Project = {
      id, name, desc: req.desc?.trim() || undefined, kind: req.source, path,
      repo: req.source === 'repo' ? req.from : undefined, defaultBranch: req.baseBranch || 'main', paused: false, worktreeDir: id, createdAt: Date.now()
    }
    this.store.saveProject(project)
    bus.push({ type: 'project', project })
    bus.track({ name: 'room.created', source: req.source })
    this.startSetup(project, req, made)
    return project
  }

  /** Builds the steps of ProjectSetup.png and runs them all. */
  private startSetup(project: Project, req: NewProjectRequest, made: boolean) {
    this.restore()
    const worktrees = projectWorktreeRoot(this.settings.worktreeRoot, project)
    const steps: ProjectSetupStep[] = [
      { id: 'clone', title: req.source === 'repo' ? `Clone ${req.from}` : req.source === 'scratch' ? (req.github ? 'Create the folder' : `Copy ${req.from}`) : 'Use your folder', detail: tildify(project.path, this.home), state: 'wait' },
      // A private repo for a project made from scratch, or a folder with no GitHub remote yet (KERNEL-944).
      ...(req.github ? [{ id: 'github' as const, title: `Create ${req.github.owner}/${req.github.name} on GitHub`, detail: 'Private repo', state: 'wait' as const }] : []),
      { id: 'host', title: 'Code host', detail: '', state: 'wait' },
      { id: 'worktrees', title: 'Create the worktree folder', detail: tildify(worktrees, this.home), state: 'wait' },
      { id: 'install', title: 'Install dependencies', detail: 'Checking the lockfile', state: 'wait' },
      { id: 'copy', title: 'Copy local files', detail: '', state: 'wait' },
      { id: 'hooks', title: 'Install hooks', detail: `${KERNEL_HOOK_EVENTS.length} events to localhost:${this.settings.hookPort}`, state: 'wait' },
      { id: 'agents', title: 'Seat agents', detail: '', state: 'wait' }
    ]
    const setup = this.track(project.id, { steps, req, made })
    setup.publish()
    this.run(project.id, setup, 'clone')
  }

  /** Keeps a setup by project id. Each publish pushes its steps and saves the setups that haven't finished cleanly (KERNEL-883). */
  private track(projectId: string, saved: SavedSetup): Setup {
    const setup: Setup = { ...saved, publish: () => { bus.push({ type: 'project.setup', projectId, steps: setup.steps.map((s) => ({ ...s })) }); this.saveSetups() } }
    this.setups.set(projectId, setup)
    return setup
  }

  private saveSetups() {
    const kept: Record<string, SavedSetup> = {}
    for (const [id, { steps, req, seated, made }] of this.setups) if (unfinished(steps)) kept[id] = { steps, req, seated, made }
    this.store.saveMeta('projectSetups', kept)
  }

  /**
   * Brings back the setups saved before this launch (KERNEL-883). Nothing of theirs runs any more, so a step that was running,
   * or the next one due, fails as stopped by the quit, and Try again runs it.
   */
  private restore() {
    if (this.restored) return
    this.restored = true
    const saved = this.store.meta<Record<string, SavedSetup>>('projectSetups') ?? {}
    for (const [id, s] of Object.entries(saved)) {
      if (!this.store.project(id) || this.setups.has(id)) continue
      const stopped = s.steps.find((x) => x.state === 'run') ?? (s.steps.some((x) => x.state === 'fail') ? undefined : s.steps.find((x) => x.state === 'wait'))
      if (stopped) Object.assign(stopped, { state: 'fail', meta: undefined, error: 'Setup stopped when Kernel quit.' })
      this.track(id, s)
    }
    this.saveSetups()
  }

  /** A project's setup, saved before this launch or started in it. */
  private setupOf(projectId: string) {
    this.restore()
    return this.setups.get(projectId)
  }

  /**
   * Try again on a failed project setup (KERNEL-876): the first failed step and every step after it go back to waiting and run
   * again, on the same `project.setup` events. The steps before it keep what they found. Returns once the run has started.
   */
  retrySetup(projectId: string) {
    const project = this.mustProject(projectId)
    const setup = this.setupOf(projectId)
    // A project added from a folder, or one whose setup finished before this launch, has none.
    if (!setup) throw new Error(`${project.name} has no setup to try again.`)
    if (setup.running) throw new Error(`${project.name} is still being set up.`)
    const failed = setup.steps.find((s) => s.state === 'fail')
    if (!failed) throw new Error(`${project.name} is already set up.`)
    for (const s of setup.steps.slice(setup.steps.indexOf(failed))) Object.assign(s, { state: 'wait', meta: undefined, error: undefined, output: undefined, fix: undefined, production: undefined })
    setup.publish()
    this.run(projectId, setup, failed.id)
  }

  private run(projectId: string, setup: Setup, from: ProjectSetupStep['id']) {
    const running: Promise<void> = this.setupProject(this.mustProject(projectId), setup, from).catch(() => undefined).finally(() => { if (setup.running === running) setup.running = undefined })
    setup.running = running
  }

  /**
   * The steps of ProjectSetup.png. A failed step records its error and the next ones still run, except when there is no
   * checkout. Check push access joins them once the checkout has a remote (KERNEL-460). Code host follows the checkout
   * (ProjectSetupGitHub.png, ProjectSetupLocal.png, KERNEL-477). `from` is the first step to run: the steps before it already
   * finished, on the first run or an earlier try (KERNEL-876).
   */
  private async setupProject(project: Project, setup: Setup, from: ProjectSetupStep['id']) {
    const { steps, publish, req } = setup
    const worktrees = projectWorktreeRoot(this.settings.worktreeRoot, project)
    const due = (id: ProjectSetupStep['id']) => STEP_ORDER.indexOf(id) >= STEP_ORDER.indexOf(from)
    const update = (id: ProjectSetupStep['id'], patch: Partial<ProjectSetupStep>) => { Object.assign(steps.find((s) => s.id === id)!, patch); publish() }
    const step = async (id: ProjectSetupStep['id'], fn: () => Promise<Partial<ProjectSetupStep> | void>) => {
      if (!due(id)) return true
      const started = Date.now()
      update(id, { state: 'run', meta: 'running', error: undefined })
      // Setup stops running as its last result is published, so Try again on that result is never refused. The last is the
      // agents step, or a checkout that failed.
      const end = (ok: boolean) => { if (id === 'agents' || ((id === 'clone' || id === 'github') && !ok)) setup.running = undefined }
      try {
        const done = (await fn()) ?? {}
        end(true)
        update(id, { state: 'ok', meta: Date.now() - started >= 1500 ? `${Math.round((Date.now() - started) / 1000)}s` : undefined, ...done })
        return true
      } catch (e) {
        end(false)
        update(id, { state: 'fail', meta: undefined, error: (e as Error).message })
        return false
      }
    }

    const checkedOut = await step('clone', async () => {
      let inited = false
      if (req.source !== 'folder') await this.clearFailedClone(project, setup)
      if (req.source === 'repo') await cloneRepo(req.from, project.path)
      else if (req.source === 'scratch' && req.github) await makeEmptyRepo(project.path, project.name)
      else if (req.source === 'scratch') await copyTemplate(req.from, project.path)
      else if ((req.initGit || req.github) && !(await inspectFolder(project.path, this.home)).git) { await initGit(project.path, this.home); inited = true }
      const remote = await this.k.config.remoteFor(project.path)
      const next: Project = { ...project, repo: project.repo ?? (await remoteRepo(project.path, remote)), defaultBranch: req.baseBranch || (await defaultBranch(project.path, remote).catch(() => 'main')) }
      this.store.saveProject(next)
      bus.push({ type: 'project', project: next })
      // Kernel commits nothing in the user's folder, so the first commit is theirs, and new workspaces wait for it (KERNEL-231).
      if (inited) return { detail: `Git initialized in ${tildify(project.path, this.home)}. Make the first commit so new workspaces have something to branch from.` }
    })
    if (!checkedOut) return
    // The repo goes up before Code host reads the remote, so the project is a GitHub one from here on (KERNEL-944). A folder with no
    // commit yet gets the remote and nothing pushed: Kernel commits nothing in the user's folder (KERNEL-231).
    const hosted = !req.github || await step('github', async () => {
      const { owner, name } = req.github!
      const committed = await hasCommit(project.path)
      await createGitHubRepo(project.path, owner, name, committed)
      const next = this.store.saveProject({ ...this.mustProject(project.id), repo: `${owner}/${name}` })
      bus.push({ type: 'project', project: next })
      return { detail: committed ? 'Private repo, pushed' : 'Private repo. Make the first commit and push it so new workspaces have something to branch from.' }
    })
    if (!hosted) return
    // Read from the checkout's remote, so a folder with no GitHub remote merges on this Mac (KERNEL-477).
    await step('host', async () => {
      const { host } = await this.k.codeHost.detect(project.path)
      const next = this.store.saveProject({ ...this.mustProject(project.id), host })
      bus.push({ type: 'project', project: next })
      return { detail: this.k.codeHost.line(next) }
    })
    if (due('host')) {
      const remote = await this.k.config.remoteFor(project.path)
      if (!steps.some((s) => s.id === 'push') && (await exec('git', ['-C', project.path, 'remote', 'get-url', '--push', remote])).code === 0) {
        steps.splice(steps.findIndex((s) => s.id === 'agents'), 0, { id: 'push', title: 'Check push access', detail: '', state: 'wait' })
        publish()
      }
      // Not a step of its own: reading two files can't fail setup, and Project setup lists what it found under the team.
      await this.findInstructionConflicts(project.id).catch(() => undefined)
    }

    await step('worktrees', async () => {
      await mkdir(worktrees, { recursive: true })
      await ensureRepoSettings(project.path)
    })
    await step('install', async () => {
      const { command, reason } = await installCommand(project.path)
      if (!command) return { detail: reason ?? 'Nothing to install' }
      update('install', { detail: command })
      const r = await exec('sh', ['-c', command], { cwd: project.path, timeoutMs: 600_000 })
      if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join('\n') || `${command} failed`)
    })
    await step('copy', async () => {
      const { files } = await loadRepoSettings(project.path)
      const present = (await resolveFilesToCopy(project.path, files.copy, [], files.exclude)).map((f) => f.path)
      if (!present.length) return { detail: 'No local files to copy' }
      const detail = present.length > 5 ? `${present.slice(0, 5).join(', ')} and ${present.length - 5} more` : present.join(', ')
      // A copied file that looks like production warns, by name, and the project still opens (KERNEL-449).
      const production = (await this.k.config.production(project)).map((h) => h.path)
      return production.length ? { state: 'warn' as const, detail, production } : { detail }
    })
    await step('hooks', async () => {
      const status = await this.k.hooks.hooksStatus()
      if (!status.installed) throw new Error('Kernel hooks are not in your Claude settings yet. Open Check hooks in the sidebar to install them.')
    })
    // A push that can't work is a warning here, never a failure, so the project still opens (KERNEL-437).
    if (steps.some((s) => s.id === 'push')) {
      await step('push', async () => {
        const c = await this.runPushCheck(project.id)
        return c ? pushStepOf(c) : { detail: 'No remote to push to' }
      })
    }
    // A repo that brings its own agents keeps them, and Project setup shows the team for review (KERNEL-397). An empty one gets
    // the starter agents picked in New project. Kernel fills in a missing Lead either way, and Kernel's code review
    // a missing reviewer (KERNEL-553).
    // A repo with more agents than one team needs asks who joins (KERNEL-465, ProjectSetupRoster.png).
    await step('agents', async () => {
      // The starter agents an earlier try seated are Kernel's, not the repo's.
      const brought = setup.seated ? 0 : (await agentFiles(project.path)).length
      if (!brought) {
        if (!this.o.starterDir) throw new Error('No starter team found. Add agent files to .claude/agents.')
        await seatStarterTeam(this.o.starterDir, project.path, req.team)
        setup.seated = true
      }
      const list = await this.k.team.agents(project.id)
      bus.push({ type: 'agents', projectId: project.id, agents: this.k.team.listed(project.id, list) })
      for (const a of list) bus.push({ type: 'agent.status', projectId: project.id, agentId: a.id, status: 'idle' })
      // Personal and plugin agents join every project, so they count toward a roster even when the repo brought none.
      const roster = await this.k.team.rosterOf(project.id)
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

  /**
   * Before a clone runs again, the folder has to be empty for git. One Kernel made for this setup only holds what a failed
   * clone left, so it goes. One that was there before is the user's and stays as it is (KERNEL-883).
   */
  private async clearFailedClone(project: Project, setup: Setup) {
    if (!(await exists(project.path))) return
    if (setup.made) { await removeTree(project.path); return }
    if ((await readdir(project.path)).length) throw new Error(`${tildify(project.path, this.home)} is not empty, and Kernel didn't make it, so Kernel leaves it as it is. Empty it, then try again.`)
  }

  /** Runs the project's push check, or waits for the one running, and keeps the result (KERNEL-460). A local project never asks gh (KERNEL-477). */
  private runPushCheck(projectId: string): Promise<PushCheck | null> {
    let running = this.checking.get(projectId)
    if (running) return running
    const project = this.mustProject(projectId)
    running = (async () => {
      try {
        const c = await checkPush(project.path, await this.k.config.remoteFor(project.path), { gh: project.host !== 'local' })
        this.pushChecks.set(projectId, c)
        return c
      } finally { this.checking.delete(projectId) }
    })()
    this.checking.set(projectId, running)
    return running
  }

  /**
   * The upgrade from the script trust gate (KERNEL-913): each project whose Install step an older Kernel held until the user
   * trusted its scripts installs once now, in the background, and the list goes. `installCommand` leaves out a stack whose
   * folder exists, such as node_modules, so an install that happened meanwhile isn't run twice. The project's log says how it went.
   */
  async installHeld() {
    const ids = this.store.meta<string[]>('heldInstalls')
    if (!ids) return
    this.store.deleteMeta('heldInstalls')
    for (const id of new Set(ids)) {
      const project = this.store.project(id)
      if (!project || project.archived) continue
      const { command } = await installCommand(project.path)
      if (!command) continue
      const r = await exec('sh', ['-c', command], { cwd: project.path, timeoutMs: 600_000 })
      if (this.stopped) return
      if (r.code === 0) bus.activity({ kind: 'note', projectId: id, actor: 'kernel', text: 'installed dependencies in', object: project.name })
      else bus.activity({ kind: 'note', projectId: id, actor: 'kernel', text: `could not install dependencies in ${project.name}:`, object: (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ') || `${command} failed`, warn: true })
    }
  }

  /**
   * Whether git can push from the project (Settings, Project, Git): the last result while it is for the project's current remote,
   * else a new one. `recheck` always runs it again, and updates Check push access while project setup shows it.
   */
  async pushCheck(projectId: string, recheck = false): Promise<PushCheck | null> {
    // No remote is asked again each time, since it costs one local git call and the project's section has no Check again.
    const last = this.pushChecks.get(projectId)
    if (!recheck && last && last.remote === await this.k.config.remoteFor(this.mustProject(projectId).path)) return last
    const setup = recheck ? this.setupOf(projectId) : undefined
    const shown = setup?.steps.find((s) => s.id === 'push')
    if (!setup || !shown) return this.runPushCheck(projectId)
    Object.assign(shown, { state: 'run', meta: 'running' })
    setup.publish()
    try {
      const c = await this.runPushCheck(projectId)
      Object.assign(shown, { meta: undefined }, c ? pushStepOf(c) : { state: 'ok', detail: 'No remote to push to' })
      return c
    } catch (e) {
      Object.assign(shown, { state: 'warn', meta: undefined, detail: (e as Error).message, fix: { action: 'recheck' } })
      throw e
    } finally { setup.publish() }
  }

  /**
   * Reads the repo's CLAUDE.md, .claude/CLAUDE.md and AGENTS.md for rules that fight Kernel's workflow and keeps them on the
   * project (KERNEL-452). The branches are the ones Kernel's agents never commit or push to, and the base is where teammates'
   * worktrees start, as `createWorkspace` picks it. The files are never written.
   */
  async findInstructionConflicts(projectId: string): Promise<Project> {
    const project = this.mustProject(projectId)
    const repo = await loadRepoSettings(project.path)
    const remote = await this.k.config.remoteFor(project.path, repo)
    const set = repo.workspace.baseRef ?? (this.settings.workspace.baseRef === DEFAULT_BASE_REF ? undefined : this.settings.workspace.baseRef)
    const base = onRemote(set ?? `${remote}/${project.defaultBranch}`, remote)
    const instructionConflicts = await scanInstructions(project.path, { branches: [project.defaultBranch, ...this.settings.permissions.protectedBranches], base })
    // Read again after the scan, so a change that landed meanwhile stays.
    const next = this.store.saveProject({ ...this.mustProject(projectId), instructionConflicts })
    bus.push({ type: 'project', project: next })
    return next
  }

  /**
   * Pause a project: every agent finishes the step it is on, then waits, and sends are held until Resume.
   * `by` is who asked. A limit pause (`limit`) is lifted by whoever detects the reset, with `resumeProject`.
   */
  pauseProject(projectId: string, by: 'you' | 'limit'): Project {
    const project = this.store.saveProject({ ...this.mustProject(projectId), paused: true, pausedBy: by })
    this.sessions.pause(projectId)
    // Someone who needs the user, is blocked or is offline keeps saying so.
    const now = this.k.team.statusOf(projectId)
    for (const a of this.agentsSync(projectId)) if (!PAUSE_KEEPS.has(now[a.id])) bus.push({ type: 'agent.status', projectId, agentId: a.id, status: 'paused' })
    bus.push({ type: 'project', project })
    bus.activity({ kind: 'project.paused', projectId, actor: by === 'you' ? 'you' : 'kernel', text: by === 'you' ? 'paused' : 'paused the project for', object: by === 'you' ? project.name : 'a usage limit' })
    return project
  }

  resumeProject(projectId: string, by: 'you' | 'limit' = 'you'): Project {
    const { pausedBy: _by, ...rest } = this.mustProject(projectId)
    const project = this.store.saveProject({ ...rest, paused: false })
    const before = this.k.team.statusOf(projectId)
    this.sessions.resume(projectId)
    // A running chat in plan mode is planning, as it was before the pause.
    const running = (agentId: string) => this.store.workspaces(projectId).filter((w) => w.agentId === agentId).flatMap((w) => this.store.chats(w.id)).filter((c) => this.sessions.isRunning(c.id))
    const resumed = (agentId: string): AgentStatus => { const r = running(agentId); return !r.length ? 'idle' : r.some((c) => !c.plan) ? 'working' : 'planning' }
    for (const a of this.agentsSync(projectId)) if (before[a.id] === 'paused') bus.push({ type: 'agent.status', projectId, agentId: a.id, status: resumed(a.id) })
    bus.push({ type: 'project', project })
    bus.activity({ kind: 'project.resumed', projectId, actor: by === 'you' ? 'you' : 'kernel', text: by === 'you' ? 'resumed' : 'resumed after the usage limit reset', object: by === 'you' ? project.name : undefined })
    return project
  }

  async updateProject(projectId: string, patch: Partial<Pick<Project, 'name' | 'desc' | 'hidden' | 'archived' | 'desks' | 'allow' | 'permissionMode'>>): Promise<Project> {
    const before = this.mustProject(projectId)
    // Archiving a project (Settings > Project) stops every agent and archives its open workspaces. The record and the folder stay.
    if (patch.archived && !before.archived) {
      // A workspace that fails to archive keeps the project open, and the error names it, so nothing is half archived without the user knowing.
      const failed: string[] = []
      for (const ws of this.store.workspaces(projectId).filter((w) => w.status !== 'archived')) {
        try { await this.k.archiveWorkspace(ws.id) } catch (e) { this.sessions.stopWorkspace(ws.id, { tree: true }); failed.push(`${ws.name}: ${(e as Error).message}`) }
      }
      if (failed.length) throw new Error(`Could not archive ${failed.length === 1 ? 'a workspace' : `${failed.length} workspaces`}, so ${before.name} stays open. ${failed.join(' ')}`)
    }
    const project = this.store.saveProject({ ...before, ...patch })
    bus.push({ type: 'project', project })
    // The project's mode moves its live chats now (KERNEL-447).
    if ('permissionMode' in patch && patch.permissionMode !== before.permissionMode) this.sessions.applyModes()
    return project
  }

  /**
   * Sets the project icon (KERNEL-241). The new file is saved before the project points at it and the old file goes after,
   * so a failed avatar fetch or a rejected image leaves the project as it was.
   */
  private async setProjectIcon(projectId: string, icon: KernelApi['projects.setIcon']['req']['icon']): Promise<Project> {
    const before = this.mustProject(projectId)
    let next: Project['icon']
    if (icon.kind === 'github') {
      const owner = githubOwner(before.repo)
      if (!owner) throw new Error(AVATAR_FAILED)
      next = await this.k.projectIcons.save(projectId, 'github', await this.k.avatar(owner), before.icon)
    } else if (icon.kind === 'image') {
      next = await this.k.projectIcons.save(projectId, 'image', await readImage(icon.path), before.icon)
    }
    // Read again after the download: the project may have gone, or another change may have landed meanwhile.
    const now = this.store.project(projectId)
    if (!now) { await this.k.projectIcons.remove(next); throw new Error(`Unknown project ${projectId}`) }
    const { icon: old, ...rest } = now
    const project = this.store.saveProject(next ? { ...rest, icon: next } : rest)
    if (old?.file !== next?.file) await this.k.projectIcons.remove(old)
    bus.push({ type: 'project', project })
    return project
  }

  /**
   * Forgets a project: stops its agents and scripts, archives its workspaces and deletes Kernel's record of them.
   * The folder, its git history and .claude/agents are never touched. Worktrees are removed only when asked.
   */
  /**
   * Removes a project (ConfirmRemoveProject.png): every open workspace is archived for real, with its archive script, its setup
   * stopped and its branch kept when it has unpushed commits, then Kernel forgets the project (D-028). Worktree folders go
   * only when "Also delete the worktrees" is ticked. If a workspace fails to archive, the error names it and the project stays.
   */
  async removeProject(projectId: string, deleteWorktrees: boolean) {
    const project = this.mustProject(projectId)
    const failed: string[] = []
    for (const ws of this.store.workspaces(projectId).filter((w) => w.status !== 'archived')) {
      try { await this.k.archiveWorkspace(ws.id, undefined, { keepWorktree: !deleteWorktrees, removingProject: true }) } catch (e) { this.sessions.stopWorkspace(ws.id, { tree: true }); failed.push(`${ws.name}: ${(e as Error).message}`) }
    }
    if (failed.length) throw new Error(`Could not archive ${failed.length === 1 ? 'a workspace' : `${failed.length} workspaces`}, so ${project.name} stays. ${failed.join(' ')}`)
    // Each cleanup reads the project and runs its archive script, so the record goes only once every one has ended (KERNEL-702).
    for (const ws of this.store.workspaces(projectId)) await this.k.archive.cleanedUp(ws.id)
    this.k.overlaps.forget(projectId)
    const shared = this.store.sharedFiles({ projectId }).map((f) => f.id)
    this.store.deleteProject(projectId)
    this.k.envStore.dropProject(projectId)
    await this.k.projectIcons.remove(project.icon)
    await this.k.shared.remove(shared)
    this.k.team.forgetProject(projectId)
    this.pushChecks.delete(projectId)
    this.restore()
    if (this.setups.delete(projectId)) this.saveSetups()
  }

  handlers() {
    return {
      // A window that loads asks for the projects once. The setups that haven't finished go out to it first, so Project setup
      // shows a failed step and Try again after a restart or a reload, on the events it already reads (KERNEL-883).
      'projects.list': async () => {
        this.restore()
        for (const s of this.setups.values()) if (unfinished(s.steps)) s.publish()
        return this.store.projects()
      },
      'projects.add': async ({ path, name }) => this.addProject(path, name),
      'projects.create': async (req) => this.createProject(req),
      'projects.retrySetup': async ({ projectId }) => { this.retrySetup(projectId); return { ok: true } },
      'projects.update': async ({ projectId, patch }) => this.updateProject(projectId, patch),
      'projects.setIcon': async ({ projectId, icon }) => this.setProjectIcon(projectId, icon),
      'projects.icon': async ({ projectId }) => this.k.projectIcons.dataUrl(this.mustProject(projectId).icon),
      'projects.remove': async ({ projectId, deleteWorktrees }) => { await this.removeProject(projectId, deleteWorktrees); return { ok: true } },
      'projects.inspectFolder': async ({ path }) => inspectFolder(path, this.home),
      'projects.recentFolders': async () => recentFolders(this.store.projects().map((r) => r.path), this.home),
      'projects.pushCheck': async ({ projectId, recheck }) => this.pushCheck(projectId, recheck),
      'github.repos': async ({ query }) => listRepos(query),
      'github.owners': async () => listOwners(),
      'github.repoAvailable': async ({ owner, name }) => repoAvailable(owner, name),
      'projects.setPaused': async ({ projectId, paused }) => (paused ? this.pauseProject(projectId, 'you') : this.resumeProject(projectId))
    } satisfies Partial<Handlers>
  }
}
