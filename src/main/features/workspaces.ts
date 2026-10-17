import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PORT_BLOCK, type AgentDef, type Chat, type ChatPart, type CompareTarget, type Effort, type LeadMode, type Provider, type Project, type ResolvedPath, type Workspace, type WorkspaceMode, type WorkspaceSource } from '@shared/types'
import { chatProvider, providerOf } from '@shared/providers'
import { buildsHere } from '@shared/leadMode'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { newId } from '../db'
import { bus } from '../bus'
import { DEFAULT_BASE_REF, loadRepoSettings, referencesInProject, type RepoSettings } from '../services/settings'
import { clock, worktreeTree, writeTree } from '../services/checkpoints'
import { branchCommits, branchName, branchType, capBranch, changedFiles, compareRange, createWorktree, currentBranch, defaultBranch, diffText, fetchOrigin, folderGone, freeBranch, freeWorktreePath, hasCommit, isWorktreeOf, leadBase, leadBranch, listBranches, mergeBase, onRemote, rangeDiff, rangeFiles, removeWorktree, resolveBaseRef, reviewBranch, projectWorktreeRoot, shortSlug, slugify, snapshotBaseline, stripRemote, taskBranch, validBranchName } from '../services/worktrees'
import { claimSpare as turnSpareIntoWorktree, fastForward, isAncestor, makeSpare, revParse, sweepSpares } from '../services/worktrees'
import { linkNodeModules, NoFreePortBlock, portBlock } from '../services/scripts'
import { exec } from '../services/exec'
import { listTree, readImage, readWorkspaceFile, resolvePaths, scratchpadDir, searchFiles } from '../services/files'
import { commitHunks, listHunks } from '../services/hunks'
import { head, messageOf, NEW_TAB } from './shared'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** When origin was last fetched, for a workspace that started from it after a fetch failed: "Oct 10, 2:05 PM (3 hours ago)". */
export function fetchedAt(ts: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ts) / 60000))
  const [n, unit] = min < 60 ? [min, 'minute'] : min < 60 * 48 ? [Math.round(min / 60), 'hour'] : [Math.round(min / 1440), 'day']
  const ago = n === 0 ? 'just now' : `${n} ${unit}${n === 1 ? '' : 's'} ago`
  return `${new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${ago})`
}

/** What `cutWorkspace` takes. `lead` makes a Lead chat's own workspace for the chat `threadId` (KERNEL-405). */
export interface CutWorkspace {
  prompt: string; parts?: ChatPart[]; source?: WorkspaceSource; agentId?: string; mode?: WorkspaceMode; baseRef?: string; title?: string; branch?: string
  provider?: Provider; model?: string; effort?: Effort; plan?: boolean; taskFor?: (ws: Workspace) => string | undefined; leadChatId?: string; reviewOf?: string; linkReviewOf?: string
  labels?: string[]; waitFor?: string[]; lead?: { threadId: string }
  /** A Lead chat that starts in Build here follows Workspace type, one in Hand off gets a worktree (KERNEL-1051). */
  leadMode?: LeadMode
  /**
   * The agent itself, for one that isn't on the project's team: Kernel's own reviewer, which runs the reviews Kernel starts with
   * its own prompts (KERNEL-549). Without it, an `agentId` the team doesn't have falls back to the Lead.
   */
  agent?: AgentDef
  /** Start from the remote as last fetched, as the Lead chats that move at startup do (KERNEL-405). */
  noFetch?: boolean
  /**
   * Save the record before the worktree exists, with `worktreePending`, for a new Lead chat (KERNEL-542). The fetch, the
   * worktree and node_modules wait for `makeWorktree`.
   */
  worktreeLater?: boolean
}

/**
 * Why git failed, without the command `run` puts before it: its `fatal:` or `error:` line, "fatal: invalid reference: main",
 * after the progress lines git prints first, such as "Preparing worktree (new branch 'kernel/plan')".
 */
function gitSaid(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const lines = (/^git .* failed \(\d+\): ([\s\S]*)$/.exec(m)?.[1] ?? m).split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? m
}

/** A project's spare worktree (KERNEL-1014): `ready` once git made it. */
interface Spare { baseRef: string; ready: boolean; made: Promise<void>; branch?: string; path?: string }

/** Creating workspaces, their ports, and what they changed (KERNEL-328). */
export class Workspaces extends Feature {
  /** Ports handed out to workspaces not saved yet, so two hand-offs in one turn never share a block (KERNEL-244). */
  readonly reservedPorts = new Set<number>()
  /** Per project, the last branch pick and the step that makes the branch, so two at once never pick the same free name (KERNEL-231). */
  private branchLocks = new Map<string, Promise<unknown>>()
  /** Per workspace, what each mention in chat resolved to, and the changed files they were resolved against (clickable file mentions). */
  private mentions = new Map<string, { changed?: string; paths: Map<string, ResolvedPath> }>()

  /** A workspace for the project's work: `cutWorkspace` makes it, then `setUpWorkspace` copies files, runs setup and sends the brief. */
  async createWorkspace(projectId: string, o: Omit<CutWorkspace, 'lead'>): Promise<Workspace> {
    // An issue picked in New workspace comes without its tracker, which the project's tells (KERNEL-462).
    const { ws, project, repo, chat } = await this.cutWorkspace(projectId, { ...o, source: await this.k.integrations.trackedSource(projectId, o.source) })
    // A brief from the Lead's hand-off is the Lead's message in the teammate's chat, not the user's (KERNEL-116).
    return this.setUpWorkspace(ws, project, repo, chat, { brief: messageOf(o.prompt, o.parts), prompt: o.prompt, from: o.leadChatId ? 'lead' : undefined, leadChatId: o.leadChatId })
  }

  /** The base Settings or the repo set for teammates' workspaces, or nothing for the repo's default branch. */
  private configuredBase(repo: RepoSettings) {
    return repo.workspace.baseRef ?? (this.settings.workspace.baseRef === DEFAULT_BASE_REF ? undefined : this.settings.workspace.baseRef)
  }

  /** The base a teammate's workspace from a hand-off starts from, as `cutWorkspace` picks it, and the project's remote (KERNEL-693). */
  async handoffBase(projectId: string, baseRef?: string): Promise<{ remote: string; base: string }> {
    const project = this.mustProject(projectId)
    const repo = await loadRepoSettings(project.path)
    const remote = await this.k.config.remoteFor(project.path, repo)
    return { remote, base: baseRef ?? this.configuredBase(repo) ?? `${remote}/${await defaultBranch(project.path, remote).catch(() => 'main')}` }
  }

  /**
   * Makes a workspace and its first chat, in `setup`: the ports, the fetch, the worktree on a new branch, and the record. A Lead
   * chat (`lead`) gets one too (KERNEL-405), always a worktree whatever "Default workspace type" says, on a branch named by
   * the Lead branch pattern, from `<remote>/<default>` or the target branch picked in New chat. A project with no commit keeps the Lead
   * on the checkout. Nothing from the repo's settings runs here. With `worktreeLater` only the checks that need no network run
   * before the record is saved, and `makeWorktree` does the rest (KERNEL-542).
   */
  async cutWorkspace(projectId: string, o: CutWorkspace): Promise<{ ws: Workspace; project: Project; repo: RepoSettings; chat: Chat }> {
    const project = this.mustProject(projectId)
    const repo = await loadRepoSettings(project.path)
    const s = this.settings
    const agents = await this.k.team.agents(projectId)
    const lead = o.lead ? agents.find((a) => a.lead) : undefined
    if (o.lead && !lead) throw new Error("Kernel can't lead in this build: its starter file is missing.")
    const agent = lead ?? o.agent ?? agents.find((a) => a.id === o.agentId) ?? agents.find((a) => a.lead) ?? agents[0]
    if (!agent) throw new Error('This project has no agents. Add one to .claude/agents first.')
    // A review gets its own worktree started from the work it reviews (KERNEL-130).
    // The branch the author is on now, which may not be the one the workspace started on (KERNEL-68).
    const reviewed = o.reviewOf && this.store.workspace(o.reviewOf) ? await this.k.prs.syncBranch(o.reviewOf) : undefined
    if (o.reviewOf && (!reviewed || reviewed.projectId !== projectId || reviewed.status === 'archived')) throw new Error('The workspace to review is not open in this project.')
    const remote = await this.k.config.remoteFor(project.path, repo)
    const main = o.lead ? await leadBase(project.path, remote) : undefined
    const mode = reviewed ? 'worktree' : o.lead ? (main ? (o.leadMode === 'build' ? o.mode ?? repo.workspace.mode ?? s.workspace.mode : 'worktree') : 'current') : o.mode ?? repo.workspace.mode ?? s.workspace.mode
    // A project Kernel ran git init in waits for the user's first commit (KERNEL-231). Without one, a worktree has nothing to start from.
    // The Lead's base was found above, so its project has one.
    if (mode === 'worktree' && !o.lead && !(await hasCommit(project.path))) throw new Error(`${project.name} has no commit yet, so a new workspace has nothing to branch from. Make the first commit in ${project.path}, then try again.`)
    const later = !!o.worktreeLater && mode === 'worktree' && !reviewed
    if (o.waitFor?.length && (mode === 'current' || reviewed)) throw new Error(reviewed ? 'A review never waits for another PR.' : "A workspace on the main checkout can't wait for a PR. Pass mode worktree.")
    const title = o.title ?? o.prompt.split(/\s+/).slice(0, 6).join(' ')
    // A base nobody set is the repo's default branch, the one PRs go into (KERNEL-400). The Lead starts from it or the branch picked
    // in New chat, never the workspace base from Settings (KERNEL-405).
    const set = o.baseRef ?? (o.lead ? undefined : this.configuredBase(repo))
    // `origin/` in a base from Settings, the Lead or a PR means the project's remote. A branch picked from the list is a real ref.
    // The Lead's base already named the default branch.
    const wanted = set ?? `${remote}/${main ? stripRemote(main, remote) : await defaultBranch(project.path, remote).catch(() => 'main')}`
    const picked = o.source?.kind === 'branch' || (!!o.lead && !!o.baseRef)
    const want = picked ? wanted : onRemote(wanted, remote)
    // A failed fetch still starts the workspace, from the remote as last fetched, and says so (KERNEL-179). A folder
    // without that remote has nothing to fetch, so it says nothing. One whose worktree waits for `makeWorktree` fetches there.
    const fetched = !reviewed && !o.noFetch && !later && mode === 'worktree' && want.startsWith(`${remote}/`) && (await exec('git', ['-C', project.path, 'remote', 'get-url', remote])).code === 0
      ? await fetchOrigin(project.path, remote, { check: stripRemote(want, remote) }) : undefined
    // The fetch may have moved the base under the project's other workspaces (KERNEL-180), and catches up one that started
    // when a fetch failed (KERNEL-653).
    if (fetched?.ok) void this.k.baseWatch.check(projectId, { fetch: false, fetched: true }).catch(() => undefined)
    // A base on the remote waits for the fetch, which may bring it, and `makeWorktree` reads it then. Any other must be here
    // now, so New chat still says when it isn't (KERNEL-542).
    const baseRef = reviewed ? await this.k.reviews.reviewBase(project.path, reviewed.branch, remote)
      : mode === 'current' && o.lead ? project.defaultBranch
      : later && want.startsWith(`${remote}/`) ? want
      : await resolveBaseRef(project.path, want, { strict: o.source?.kind === 'pr' || picked, remote })
    const stale = this.staleBase(fetched, baseRef, remote)
    // The ports come first, so running out of them leaves no worktree or branch behind (KERNEL-244).
    const ws: Workspace = await this.withPort(async (port) => {
      // The Lead chat goes in the first record, so it's there before the teammate's first turn can end (KERNEL-105), with the Lead
      // chat that tab belongs to, which outlasts the tab (KERNEL-337). A review the Lead started with base_ref keeps the Lead's
      // base and branch, and is only linked (KERNEL-299). A Lead chat's own workspace carries that chat (KERNEL-405).
      const reviewOf = reviewed?.id ?? (mode === 'worktree' ? o.linkReviewOf : undefined)
      const threadId = o.lead?.threadId ?? (o.leadChatId ? this.store.chat(o.leadChatId)?.threadId : undefined)
      const save = (path: string, branch: string, baselineRef?: string) => {
        const w: Workspace = { id: newId(), projectId, name: slugify(title || 'chat'), branch, baseRef, ...(stale ? { fetchFailed: stale.text } : {}), path, mode, agentId: agent.id, ...(o.lead ? { lead: true as const } : {}), port, status: 'setup', baselineRef, source: o.source, title, leadChatId: o.leadChatId, ...(threadId ? { threadId } : {}), ...(reviewOf ? { reviewOf } : {}), ...(o.waitFor?.length ? { waitsFor: { on: o.waitFor, held: true } } : {}), ...(later ? { worktreePending: {} } : {}), firstInProject: this.isFirstInProject(projectId, { threadId: o.lead?.threadId }), prState: 'none', createdAt: Date.now() }
        this.store.saveWorkspace(w)
        return w
      }
      if (mode === 'worktree') {
        // Kernel names the branch from the issue key and a few words of the title, and the Lead can name it instead, cut to
        // 60 characters (KERNEL-275), for a review too (KERNEL-265). A taken name gets a suffix. A Lead chat's follows
        // the Lead branch pattern, `kernel/<a few words>` (KERNEL-405).
        const asked = o.branch ? capBranch(o.branch) : undefined
        if (asked && !(await validBranchName(project.path, asked))) throw new Error(`${asked} is not a valid branch name.`)
        const issue = o.source?.kind === 'issue' ? o.source : undefined
        const labels = o.labels ?? (issue && !asked && !reviewed && !o.lead ? await this.k.integrations.issueLabels(projectId, issue) : [])
        const wanted = asked || (reviewed ? reviewBranch(reviewed.title ?? reviewed.name, reviewed.source?.kind === 'issue' ? reviewed.source.id : undefined)
          : o.lead ? branchName(repo.workspace.leadBranchPattern || s.workspace.leadBranchPattern, { slug: shortSlug(title || 'chat'), lead: agent.name })
          : taskBranch(repo.workspace.branchPattern ?? s.workspace.branchPattern, issue ? issue.title : title, issue?.id, branchType(labels)))
        if (later) {
          // git makes this one after, so a pattern git won't take is caught now, while New chat can still say so (KERNEL-542).
          if (!asked && !(await validBranchName(project.path, wanted))) throw new Error(`${wanted} is not a valid branch name. Change the branch names for chats with Kernel in Settings, Git.`)
          // The record is saved inside the project's lock, so the next pick sees its branch and folder taken before git makes them.
          return this.withBranchLock(project.id, async () => {
            const taken = this.pendingNames(projectId)
            const branch = await freeBranch(project.path, wanted, remote, taken.branches)
            const root = projectWorktreeRoot(s.worktreeRoot, project)
            await mkdir(root, { recursive: true })
            return save(await freeWorktreePath(project.path, root, branch, taken.paths), branch)
          })
        }
        const made = await this.newBranchWorktree(project, wanted, baseRef, remote)
        // Local files are copied with setup, in `prepare`.
        if (repo.files.symlinkNodeModules) await linkNodeModules(project.path, made.path)
        return save(made.path, made.branch)
      }
      // A project with no commit to start from keeps the Lead on the checkout, with no baseline, as before KERNEL-355.
      if (o.lead && !main) return save(project.path, await currentBranch(project.path).catch(() => project.defaultBranch))
      if (s.workspace.oneCurrentBranchPerProject && this.onCheckout(projectId, { agentId: agent.id, lead: !!o.lead }))
        throw new Error('Another workspace is already working on the current branch in this project.')
      return save(project.path, await currentBranch(project.path).catch(() => project.defaultBranch), s.workspace.baselineCurrentBranch ? (await snapshotBaseline(project.path)).ref : undefined)
    })
    // Until its brief has gone out, the Lead's messages to it wait here (KERNEL-118). Nobody messages the Lead's own workspace.
    if (!o.lead) this.k.setup.setSetup(ws.id, { later: [] })
    bus.push({ type: 'workspace', workspace: ws })
    bus.activity({ kind: 'workspace.created', projectId, workspaceId: ws.id, agentId: agent.id, text: 'started', object: ws.name })
    if (!o.lead) bus.track({ name: 'workspace.created', by: o.leadChatId ? 'lead' : 'user', review: !!(o.reviewOf ?? o.linkReviewOf) })
    // The issue goes to In Progress in the project's tracker, when it came from there.
    if (!o.lead && o.source?.kind === 'issue' && o.source.id) void this.k.integrations.startIssue(ws, o.source)
    // The Lead's hand-off: the task this workspace builds moves to Building now, not when the turn ends.
    const taskId = o.taskFor?.(ws)
    if (taskId) { ws.taskId = taskId; this.saveWs(ws) }

    const role = this.k.team.pickFor(agent)
    // A model picked in New workspace runs on its own provider. Otherwise the agent's pin or its role decides (KERNEL-406).
    const pick = { provider: o.model ? o.provider ?? providerOf(o.model) : role.provider, model: o.model ?? role.model, effort: o.effort ?? role.effort, plan: o.plan ?? (agent.lead && s.models.leadPlanMode) }
    // A Lead chat's first tab is auto-named, and the chat takes its name (KERNEL-337).
    const chat = o.lead ? this.newChat(ws.id, NEW_TAB, { ...pick, threadId: o.lead.threadId })
      : this.newChat(ws.id, title, pick)
    if (stale) this.sayStale(ws, remote, stale)
    return { ws, project, repo, chat }
  }

  /**
   * A fetch that failed, for a base on the remote: git's reason, how old the base is, and the sentence `fetchFailed` keeps. A
   * local branch the base fell back to wasn't fetched, so a failed fetch says nothing about it.
   */
  private staleBase(fetched: Awaited<ReturnType<typeof fetchOrigin>> | undefined, baseRef: string, remote: string) {
    if (fetched?.ok !== false || !baseRef.startsWith(`${remote}/`)) return undefined
    const when = fetched.lastFetch === undefined ? undefined : fetchedAt(fetched.lastFetch)
    return { error: fetched.error, when, text: `Fetching ${remote} failed (${fetched.error}), so it started from ${baseRef} as of ${when ?? 'its last fetch'}.` }
  }

  /** The feed and the chat say the workspace started from the remote as last fetched (KERNEL-179). */
  private sayStale(ws: Workspace, remote: string, stale: { error: string; when?: string }) {
    bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, actor: 'kernel', text: `started ${ws.name} from ${ws.baseRef} as last fetched${stale.when ? ` ${stale.when}` : ''}, because fetching ${remote} failed:`, object: stale.error, warn: true })
    this.note(ws.id, `Couldn't fetch ${remote} (${stale.error}), so this workspace started from ${ws.baseRef} as of ${stale.when ?? 'its last fetch'}. It may be missing recent merges.`)
  }

  /** The branches and folders that Lead chats hold before git makes them, so no other pick takes them (KERNEL-542). */
  pendingNames(projectId: string, except?: string): { branches: Set<string>; paths: Set<string> } {
    const held = this.store.workspaces(projectId).filter((w) => w.worktreePending && w.status !== 'archived' && w.id !== except)
    return { branches: new Set(held.map((w) => w.branch)), paths: new Set(held.map((w) => w.path)) }
  }

  /** The spare worktree of each project, ready or being made (KERNEL-1014). At most one per project. */
  private spares = new Map<string, Spare>()

  /**
   * Makes the project's spare worktree in the background, from `<remote>/<default>` as last fetched, for a new Lead chat to claim
   * (KERNEL-1014). Nothing when the project has one already, has no commit, or keeps its Lead on the checkout. Never throws.
   */
  async prepareSpare(projectId: string): Promise<void> {
    if (this.stopped || this.spares.has(projectId)) return
    const project = this.store.project(projectId)
    if (!project) return
    const spare: Spare = { baseRef: '', ready: false, made: Promise.resolve() }
    this.spares.set(projectId, spare)
    spare.made = (async () => {
      try {
        const repo = await loadRepoSettings(project.path)
        const remote = await this.k.config.remoteFor(project.path, repo)
        const base = await leadBase(project.path, remote)
        if (!base) throw new Error('no base')
        spare.baseRef = base
        const root = projectWorktreeRoot(this.settings.worktreeRoot, project)
        Object.assign(spare, await makeSpare({ repo: project.path, root, baseRef: base }))
        // A project removed, or a Kernel stopped, while git worked leaves nothing behind.
        if (this.stopped || this.spares.get(projectId) !== spare || !this.store.project(projectId)) await this.discard(project.path, spare)
        else spare.ready = true
      } catch {
        if (this.spares.get(projectId) === spare) this.spares.delete(projectId)
      }
    })()
    await spare.made
  }

  private async discard(repo: string, spare: { branch?: string; path?: string }) {
    if (!spare.path || !spare.branch) return
    await removeWorktree(repo, spare.path, { deleteBranch: spare.branch, force: true }).catch(() => undefined)
  }

  /** Removes the project's spare, as the project goes (KERNEL-1014). */
  async dropSpare(projectId: string, repo: string): Promise<void> {
    const spare = this.spares.get(projectId)
    this.spares.delete(projectId)
    if (spare) { await spare.made.catch(() => undefined); await this.discard(repo, spare) }
  }

  /** At quit: every spare goes. At launch, `sweepAllSpares` finds the ones a crash left. */
  async dropSpares(): Promise<void> {
    await Promise.all([...this.spares.keys()].map((id) => { const p = this.store.project(id); return p ? this.dropSpare(id, p.path) : undefined }))
  }

  async sweepAllSpares(): Promise<void> {
    await Promise.all(this.store.projects().map((p) => sweepSpares(p.path)))
  }

  /**
   * Takes the project's spare for the Lead chat `ws`, whose branch and folder `makeWorktree` picks, inside the project's branch
   * lock so `pendingNames` and `freeBranch` stay right (KERNEL-1014). Undefined, with the spare removed when it was broken, when
   * there is none, it is still being made, it starts from another base than the chat's, or anything fails: the caller makes the
   * worktree as it always did. A spare is taken once, so a second Send meanwhile finds none.
   */
  private async claimSpare(ws: Workspace, project: Project, remote: string): Promise<{ branch: string; path: string } | undefined> {
    const spare = this.spares.get(project.id)
    if (!spare?.ready || spare.baseRef !== ws.baseRef || !spare.path || !spare.branch) return undefined
    this.spares.delete(project.id)
    try {
      return await this.withBranchLock(project.id, async () => {
        const now = this.mustWs(ws.id)
        if (this.stopped || now.status === 'archived' || await isWorktreeOf(project.path, now.path)) throw new Error('nothing to claim')
        const taken = this.pendingNames(project.id, ws.id)
        const branch = await freeBranch(project.path, now.branch, remote, taken.branches)
        const root = dirname(now.path)
        await mkdir(root, { recursive: true })
        const path = branch === now.branch && !taken.paths.has(now.path) && await folderGone(now.path) ? now.path : await freeWorktreePath(project.path, root, branch, taken.paths)
        await turnSpareIntoWorktree(project.path, { branch: spare.branch!, path: spare.path! }, { branch, path })
        return { branch, path }
      })
    } catch {
      await this.discard(project.path, spare)
      return undefined
    }
  }

  /**
   * A claimed spare starts the chat only when nothing in it is the chat's to inherit: its working tree is clean, and its HEAD is
   * the base or behind it, so a fast-forward lands exactly on the base. Edits left in the spare, or commits a base moved back
   * past, fail it, and the caller makes a fresh worktree. False when it can't be brought up to `baseRef`.
   */
  private async catchUp(path: string, baseRef: string): Promise<boolean> {
    const [here, there, status] = await Promise.all([revParse(path, 'HEAD'), revParse(path, baseRef), exec('git', ['-C', path, 'status', '--porcelain'])])
    if (!here || !there || status.code !== 0 || status.stdout.trim()) return false
    if (here === there) return true
    return await isAncestor(path, here, there) === true && await fastForward(path, baseRef) && await revParse(path, 'HEAD') === there
  }

  /** Worktrees being made for Lead chats, by workspace (KERNEL-542). */
  private making = new Map<string, Promise<Workspace>>()

  /** Once the worktree being made for the workspace exists, or making it failed. At once when none is being made. */
  async worktreeMade(id: string): Promise<void> { await this.making.get(id)?.catch(() => undefined) }

  /**
   * Makes the worktree a new Lead chat's record waits for (KERNEL-542): the fetch, the base read again after it, the
   * worktree on the branch and in the folder the record picked, or the next free ones when someone took them meanwhile, and
   * the node_modules link. A failed fetch starts from the remote as last fetched and says so (KERNEL-179). When git won't make
   * the worktree, the workspace is failed with git's reason in `worktreePending`, and calling this again tries again. A worktree
   * git made before a quit cut this short is taken as it is. One call at a time per workspace. Returns the workspace.
   */
  makeWorktree(id: string): Promise<Workspace> {
    const running = this.making.get(id)
    if (running) return running
    const run = this.makeNow(id).finally(() => { if (this.making.get(id) === run) this.making.delete(id) })
    this.making.set(id, run)
    return run
  }

  private async makeNow(id: string): Promise<Workspace> {
    const ws = this.mustWs(id)
    if (!ws.worktreePending || ws.status === 'archived') return ws
    if (ws.worktreePending.error) this.updateWs(id, { status: 'setup', worktreePending: { ...ws.worktreePending, error: undefined } })
    const project = this.mustProject(ws.projectId)
    try {
      const repo = await loadRepoSettings(project.path)
      const remote = await this.k.config.remoteFor(project.path, repo)
      // The claim runs alongside the check that main didn't move (KERNEL-1014).
      const [fetched, claimed] = await Promise.all([
        ws.baseRef.startsWith(`${remote}/`) && (await exec('git', ['-C', project.path, 'remote', 'get-url', remote])).code === 0
          ? fetchOrigin(project.path, remote, { check: stripRemote(ws.baseRef, remote) }) : undefined,
        this.claimSpare(ws, project, remote)
      ])
      // A Kernel that stopped meanwhile has closed its database. The next launch finds the workspace in setup and fails it.
      if (this.stopped) return ws
      if (fetched?.ok) void this.k.baseWatch.check(project.id, { fetch: false, fetched: true }).catch(() => undefined)
      // A base other than the default branch was picked in New chat, and a picked base never falls back to another (KERNEL-405).
      const main = `${remote}/${await defaultBranch(project.path, remote).catch(() => 'main')}`
      const baseRef = await resolveBaseRef(project.path, ws.baseRef, { strict: ws.baseRef !== main, remote })
      // A spare older than its base is brought up to it before the message is released. One that can't be goes, and the worktree is made.
      let spare = claimed
      if (spare && !(await this.catchUp(spare.path, baseRef))) {
        await this.discard(project.path, spare)
        spare = undefined
      }
      const made = spare ?? await this.withBranchLock(project.id, async () => {
        const now = this.mustWs(id)
        if (this.stopped || now.status === 'archived') return undefined
        if (await isWorktreeOf(project.path, now.path) && await currentBranch(now.path).catch(() => undefined) === now.branch) return { branch: now.branch, path: now.path }
        const taken = this.pendingNames(project.id, id)
        const branch = await freeBranch(project.path, now.branch, remote, taken.branches)
        const root = dirname(now.path)
        await mkdir(root, { recursive: true })
        const path = branch === now.branch && !taken.paths.has(now.path) && await folderGone(now.path) ? now.path : await freeWorktreePath(project.path, root, branch, taken.paths)
        await createWorktree({ repo: project.path, root, branch, baseRef, path })
        return { branch, path }
      })
      if (this.stopped) return ws
      if (spare) void this.prepareSpare(project.id)
      if (!made) return this.mustWs(id)
      try {
        if (repo.files.symlinkNodeModules) await linkNodeModules(project.path, made.path)
      } catch (e) {
        await removeWorktree(project.path, made.path, { deleteBranch: made.branch, force: true }).catch(() => undefined)
        throw e
      }
      if (this.stopped) return ws
      const stale = this.staleBase(fetched, baseRef, remote)
      const done = this.updateWs(id, { ...made, baseRef, worktreePending: undefined, fetchFailed: stale?.text })
      if (stale) this.sayStale(done, remote, stale)
      return done
    } catch (e) {
      if (this.stopped) return ws
      const error = gitSaid(e)
      bus.push({ type: 'script.output', workspaceId: id, kind: 'setup', lines: [{ line: `Kernel couldn't make the worktree: ${error}`, stream: 'stderr' }] })
      return this.updateWs(id, { status: 'failed', worktreePending: { ...ws.worktreePending, error } })
    }
  }

  /**
   * A new workspace's setup: files.copy and setup, then ready, the start checkpoint and the run script.
   *
   * With a `brief` (a hand-off or New workspace), the brief waits in the chat's queue until setup passes, then goes out with the
   * Lead's messages that came while it ran (KERNEL-118). A hand-off awaits it all, so create_workspace reports a failed setup
   * (KERNEL-122). With none (a fork, a Lead chat, a restore), the caller already holds the chat, and what waits in its tabs
   * goes out when setup passes, or after Run again. `checkpoint: false` takes no start checkpoint, for a
   * restore (KERNEL-77).
   */
  async setUpWorkspace(ws: Workspace, project: Project, repo: RepoSettings, chat: Chat, o: { brief?: ChatPart[]; prompt?: string; from?: 'lead'; leadChatId?: string; checkpoint?: boolean } = {}): Promise<Workspace> {
    if (!o.brief) {
      // `recoverSetups` leaves it alone, should it run while this setup does, as for a chat that moves at startup.
      this.k.setup.fresh.add(ws.id)
      try { return await this.setUpHeld(ws, project, repo, chat, o.checkpoint) } finally { this.k.setup.fresh.delete(ws.id) }
    }
    const parts = o.brief
    const from = o.from
    this.k.setup.setSetup(ws.id, { ...this.k.setup.setups.get(ws.id), chatId: chat.id, brief: parts, ...(from ? { from } : {}), later: this.k.setup.setups.get(ws.id)?.later ?? [] })
    // The Lead's messages sent before the brief went out follow it, never go before it (KERNEL-118). Messages that
    // arrive while the brief is sent are still caught here, and the mark goes only once the list is empty.
    const after = async (send: (m: ChatPart[]) => Promise<unknown> | void) => {
      for (let held = this.k.setup.setups.get(ws.id); held?.later.length; held = this.k.setup.setups.get(ws.id)) { const m = held.later.shift()!; this.k.setup.saveSetups(); await send(m) }
      this.k.setup.setSetup(ws.id, undefined)
    }
    // Setup runs alongside unless the user asked agents to wait for it (KERNEL-1012).
    const alongside = this.k.setup.runsOnCreate(repo) && !this.k.setup.holdsForSetup(repo)
    let ready: boolean
    try { ready = await this.k.setup.prepare(ws, project, repo, { background: alongside }) } catch (e) { this.k.setup.setSetup(ws.id, undefined); throw e }
    // Archived while setup ran: archive stopped the script, and the workspace stays archived.
    if (this.mustWs(ws.id).status === 'archived') { this.k.setup.setSetup(ws.id, undefined); return this.mustWs(ws.id) }
    // The first prompt waits in the chat's queue until setup passes (WorkspaceSetupFailed.png, "Run again").
    if (!ready) {
      this.sessions.hold(chat.id, parts, { from })
      await after((m) => this.sessions.hold(chat.id, m, { from: 'lead' }))
      const failed = this.updateWs(ws.id, { status: 'failed' })
      // The Lead's create_workspace says so in its result while the Lead's turn still waits for it, so this event doesn't
      // wake the Lead a second time (KERNEL-126). A setup that was stopped, by archive or quit, isn't a failure to report.
      const code = this.k.setup.setupFailures.get(ws.id)
      if (code !== null && failed.status !== 'archived') this.leadUpdates.setup(failed, false, { told: !!o.leadChatId && this.sessions.isRunning(o.leadChatId), code })
      return failed
    }
    // Read again: wait_for_merge may have set or cleared the wait while setup ran (KERNEL-259).
    const wait = this.mustWs(ws.id).waitsFor
    if (wait?.held && wait.on.length) {
      // The brief and the Lead's messages wait in the chat, and only then does the workspace count as ready, so a quit
      // between them finds a ready waiter that Sessions.restore holds again. No checkpoint, run script or turn yet.
      const base = await head(ws.path)
      this.sessions.hold(chat.id, parts, { from })
      await after((m) => this.sessions.hold(chat.id, m, { from: 'lead' }))
      const now = this.mustWs(ws.id)
      if (now.status === 'archived') return now
      const held = this.updateWs(ws.id, { status: 'ready', waitsFor: { ...(now.waitsFor ?? wait), held: true, ...(base ? { base } : {}) } })
      // No note: the composer's queue tray shows the wait and its Send now (KERNEL-973).
      const label = this.k.waits.waitLabelOf(held)
      // The Lead reads it in create_workspace's result while its turn still waits for it (KERNEL-126's pattern).
      this.leadUpdates.waits(held, 'wait.started', { on: held.waitsFor!.on, label, held: true, ...(o.leadChatId && this.sessions.isRunning(o.leadChatId) ? { told: true } : {}) })
      // Something it waits for may have merged while setup ran.
      void this.k.waits.settleWait(ws.id).catch(() => undefined)
      if (alongside) void this.k.setup.runInBackground(held, project, repo)
      return held
    }
    const done = await this.k.setup.setupDone(ws, project, chat, o.prompt ?? chat.title, async () => {
      // A wait set while the brief was on its way is now a started teammate's (KERNEL-259).
      const late = this.mustWs(ws.id).waitsFor
      if (late?.held) this.updateWs(ws.id, { waitsFor: { ...late, held: false } })
      // The Lead's messages sent before the brief went out go in its first turn, after it (KERNEL-393). One that arrives while
      // it is sent is still caught by `after`.
      const later = this.k.setup.setups.get(ws.id)?.later.splice(0) ?? []
      this.k.setup.saveSetups()
      await this.sessions.sendAll(chat.id, [{ parts, from }, ...later.map((m) => ({ parts: m, from: 'lead' as const }))])
      await after((m) => this.sessions.send(chat.id, m, { from: 'lead' }))
    }, { run: !alongside })
    if (alongside && done.status === 'ready') void this.k.setup.runInBackground(done, project, repo)
    return done
  }

  /** `setUpWorkspace` for a workspace whose chats are already held: a fork, a Lead chat, or a restore. */
  private async setUpHeld(ws: Workspace, project: Project, repo: RepoSettings, chat: Chat, checkpoint?: boolean): Promise<Workspace> {
    const alongside = this.k.setup.runsOnCreate(repo) && !this.k.setup.holdsForSetup(repo)
    const ready = await this.k.setup.prepare(ws, project, repo, { background: alongside })
    for (const m of this.k.setup.setups.get(ws.id)?.later ?? []) this.sessions.hold(chat.id, m, { from: 'lead' })
    if (this.k.setup.setups.has(ws.id)) this.k.setup.setSetup(ws.id, undefined)
    if (this.mustWs(ws.id).status === 'archived') return this.mustWs(ws.id)
    if (!ready) {
      const failed = this.updateWs(ws.id, { status: 'failed' })
      const code = this.k.setup.setupFailures.get(ws.id)
      // The Lead's own setup failing is for the user, in the chat. Nobody else handed it off.
      if (code !== null && failed.status !== 'archived' && !failed.lead) this.k.leadUpdates.setup(failed, false, { code })
      return failed
    }
    const done = await this.k.setup.setupDone(ws, project, chat, chat.title, async () => this.k.setup.releaseTabs(ws.id, chat.id), { checkpoint, run: !alongside })
    if (alongside && done.status === 'ready') void this.k.setup.runInBackground(done, project, repo)
    return done
  }

  /**
   * Fork into new workspace (KERNEL-346). A worktree on a new branch from the chat's workspace's HEAD, holding that workspace's
   * files as they are now, uncommitted and untracked ones too, with the same agent and base. The chat is forked into it up to
   * `itemId`, the way Fork into new chat does it. Kernel sends nothing: setup runs as for any new workspace, then the user
   * writes the next message. Answers once the workspace and its chat exist, so the window can open it while setup runs.
   */
  async forkWorkspace(chatId: string, itemId?: string): Promise<Workspace> {
    const chat = this.mustChat(chatId)
    if (chat.kind === 'terminal') throw new Error('A big terminal cannot be forked.')
    const src = this.mustWs(chat.workspaceId)
    // Current-branch workspaces share the main checkout, whose changes aren't only the agent's.
    if (src.mode !== 'worktree') throw new Error('Only a workspace with its own worktree can fork into a new workspace.')
    // A Lead chat plans and hands off. Its work isn't a task to fork (KERNEL-355, KERNEL-405).
    if (this.isLeadWorkspace(src)) throw new Error("A chat with Kernel can't fork into a new workspace. Fork into a new chat instead.")
    if (src.status === 'archived') throw new Error('Restore the workspace from History to fork it.')
    const project = this.mustProject(src.projectId)
    const repo = await loadRepoSettings(project.path)
    const from = await head(src.path)
    if (!from) throw new Error(`${src.name} has no commit to fork from.`)
    // Read before anything else changes, so the files are the ones the source had when Fork was pressed.
    const files = await worktreeTree(src.path)
    let ws!: Workspace
    const fork = await this.k.chats.forkChat(chatId, itemId, async () => (ws = await this.forkTree(src, project, repo, from, files)).id)
    this.k.setup.setSetup(ws.id, { chatId: fork.id, later: this.k.setup.setups.get(ws.id)?.later ?? [] })
    // Nothing goes out before setup passes.
    this.sessions.hold(fork.id)
    this.note(ws.id, `Forked from ${src.name}, with its files as they were at ${clock(Date.now())}.`)
    void this.setUpWorkspace(ws, project, repo, fork).catch((e) => {
      // A Kernel that stopped meanwhile has closed its database. The next launch finds the workspace in setup and fails it.
      if (this.stopped) return
      console.warn(`[fork] setting up ${ws.name} failed`, e)
      if (this.store.workspace(ws.id)?.status === 'setup') this.updateWs(ws.id, { status: 'failed' })
    })
    return ws
  }

  /** The fork's worktree and record: a branch at `from` whose files are made to match `files`, and the workspace in setup. */
  private async forkTree(src: Workspace, project: Project, repo: RepoSettings, from: string, files: string): Promise<Workspace> {
    const remote = await this.k.config.remoteFor(project.path, repo)
    const ws = await this.withPort(async (port) => {
      const { branch, path } = await this.newBranchWorktree(project, `${capBranch(src.branch, 55)}-fork`, from, remote)
      try {
        await writeTree(path, `${from}^{tree}`, files)
        if (repo.files.symlinkNodeModules) await linkNodeModules(project.path, path)
      } catch (e) {
        await removeWorktree(project.path, path, { deleteBranch: branch, force: true }).catch(() => undefined)
        throw e
      }
      // The sidebar shows the name, so the fork's says what it is and takes the branch's number: kernel-155-home-fork-2.
      const name = `${slugify(src.name, 40)}-fork${/-fork(-\d+)$/.exec(branch)?.[1] ?? ''}`
      const w: Workspace = { id: newId(), projectId: project.id, name, title: src.title ?? src.name, branch, baseRef: src.baseRef, path, mode: 'worktree', agentId: src.agentId, port, status: 'setup', prState: 'none', createdAt: Date.now() }
      this.store.saveWorkspace(w)
      return w
    })
    // The Lead's messages that arrive during setup wait here, as for a hand-off's workspace (KERNEL-118).
    this.k.setup.setSetup(ws.id, { later: [] })
    bus.push({ type: 'workspace', workspace: ws })
    bus.activity({ kind: 'workspace.created', actor: 'you', projectId: project.id, workspaceId: ws.id, agentId: ws.agentId, text: `forked ${src.name} into`, object: ws.name })
    return ws
  }

  /**
   * Runs `pick`, which picks a free branch with `freeBranch` and makes it, one at a time per project. A branch is free until git
   * makes it, so a second pick at once would choose the same name (KERNEL-231). New workspaces, forks, restores and Continue use it.
   */
  async withBranchLock<T>(projectId: string, pick: () => Promise<T>): Promise<T> {
    const run = (this.branchLocks.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(pick)
    this.branchLocks.set(projectId, run)
    try { return await run } finally { if (this.branchLocks.get(projectId) === run) this.branchLocks.delete(projectId) }
  }

  /**
   * A worktree on a new branch: `wanted`, or the first free name after it, here and on `remote` (KERNEL-479), in the project's
   * worktree folder. Names a Lead chat holds before git makes them are taken (KERNEL-542).
   */
  private newBranchWorktree(project: Project, wanted: string, baseRef: string, remote: string): Promise<{ branch: string; path: string }> {
    return this.withBranchLock(project.id, async () => {
      const taken = this.pendingNames(project.id)
      const branch = await freeBranch(project.path, wanted, remote, taken.branches)
      const root = projectWorktreeRoot(this.settings.worktreeRoot, project)
      await mkdir(root, { recursive: true })
      return { branch, path: await createWorktree({ repo: project.path, root, branch, baseRef, path: await freeWorktreePath(project.path, root, branch, taken.paths) }) }
    })
  }

  /**
   * Another open workspace on the project's checkout, which "One current-branch workspace per project" refuses a second to
   * share: a teammate's, or a chat with Kernel that builds there (KERNEL-1051). `self` is the one asking, so it never counts, nor
   * does a chat of the same agent unless both build.
   */
  onCheckout(projectId: string, self: { id?: string; agentId: string; lead?: boolean }): Workspace | undefined {
    return this.store.workspaces(projectId).find((w) => w.mode === 'current' && w.status !== 'archived' && w.id !== self.id
      && (w.agentId !== self.agentId || (!!self.lead && isLeadChatWorkspace(w) && buildsHere(w))))
  }

  /**
   * Gives a chat on the shared main folder its own worktree (KERNEL-1051): a branch named by the Lead branch pattern from the
   * chat's title, cut from `<remote>/<default>` through `makeWorktree` (the spare, the fetch, the KERNEL-653 check), and ports.
   * The record is `setup` with `worktreePending` meanwhile. Throws git's reason when the worktree can't be made, with the
   * record left as `makeWorktree` leaves it, for the caller to put back.
   */
  async cutOwnWorktree(id: string, title: string, leadName: string | undefined, pending?: () => void): Promise<Workspace> {
    const ws = this.mustWs(id)
    const project = this.mustProject(ws.projectId)
    const repo = await loadRepoSettings(project.path)
    const remote = await this.k.config.remoteFor(project.path, repo)
    const base = await leadBase(project.path, remote)
    if (!base) throw new Error(`${project.name} has no commit yet, so there is nothing for a worktree to start from.`)
    const wanted = leadBranch(repo.workspace.leadBranchPattern || this.settings.workspace.leadBranchPattern, title, leadName)
    if (!(await validBranchName(project.path, wanted))) throw new Error(`${wanted} is not a valid branch name. Change the branch names for chats with Kernel in Settings, Git.`)
    await this.withPort((port) => this.withBranchLock(project.id, async () => {
      const taken = this.pendingNames(project.id, id)
      const branch = await freeBranch(project.path, wanted, remote, taken.branches)
      const root = projectWorktreeRoot(this.settings.worktreeRoot, project)
      await mkdir(root, { recursive: true })
      const path = await freeWorktreePath(project.path, root, branch, taken.paths)
      // The stamp it got when it started stays: the first chat of a new project is still the first once it has a copy.
      this.updateWs(id, { shared: undefined, mode: 'worktree', branch, path, baseRef: base, port, status: 'setup', worktreePending: { fromShared: true }, naming: 'branch', firstInProject: ws.firstInProject === true, fetchFailed: undefined })
    }))
    pending?.()
    const made = await this.makeWorktree(id)
    if (made.worktreePending) throw new Error(made.worktreePending.error ?? "Kernel couldn't make the worktree.")
    return made
  }

  /**
   * Whether a chat or workspace started now is the first of a newly added project: the project has no other workspace or chat,
   * open or archived (KERNEL-1053). `id` and `threadId` are the record and chat that are being made, which don't count.
   */
  isFirstInProject(projectId: string, self: { id?: string; threadId?: string } = {}): boolean {
    return !this.store.workspaces(projectId).some((w) => w.id !== self.id) && !this.store.threads(projectId).some((t) => t.id !== self.threadId)
  }

  /** The first port of every open workspace's block. */
  openPorts() { return this.store.workspaces().filter((w) => w.status !== 'archived' && !w.shared).map((w) => w.port) }

  /**
   * The one way a workspace gets ports: a free block (`portBlock`), held in memory while `use` runs, through its awaits,
   * until it has stored the workspace that uses it, so a second hand-off in the same turn can't pick it too (KERNEL-244).
   * The block goes back if `use` throws. With none free, the error says how many workspaces hold one and how to free them, and
   * the Lead's create_workspace passes it on as it is (KERNEL-830).
   */
  async withPort<T>(use: (port: number) => T | Promise<T>): Promise<T> {
    const port = await portBlock(() => this.openPorts(), this.reservedPorts).catch((e) => {
      if (!(e instanceof NoFreePortBlock)) throw e
      const open = this.openPorts().length
      throw new Error(`Kernel is out of ports for new workspaces. ${open} ${open === 1 ? 'workspace is' : 'workspaces are'} open across your projects, and each holds ${PORT_BLOCK} ports. Archive the workspaces you've finished to free their ports.`)
    })
    try { return await use(port) } finally { this.reservedPorts.delete(port) }
  }

  /**
   * Whether a worktree workspace's folder was deleted outside Kernel (KERNEL-291). The flag is set or cleared to match, and pushed
   * when it changes. A current-branch workspace is the project's own checkout, so it is never flagged. An archived one has no folder,
   * and neither has a Lead chat whose worktree isn't made yet (KERNEL-542).
   */
  async checkFolder(id: string): Promise<boolean> {
    const ws = this.mustWs(id)
    if (ws.mode !== 'worktree' || ws.status === 'archived' || ws.worktreePending || ws.shared) return false
    const gone = await folderGone(ws.path).catch(() => false)
    if (gone !== !!this.mustWs(id).folderGone) this.updateWs(id, { folderGone: gone ? true : undefined })
    return gone
  }

  /** The files a workspace changed. Their totals are saved on the workspace too, for the sidebar and Home (+412 -38). */
  async changes(id: string) {
    // A folder deleted outside Kernel has no changes to read, and the workspace says so (KERNEL-291). One not made yet has none.
    if (this.unmade(id) || await this.checkFolder(id)) return []
    const ws = this.mustWs(id)
    const files = ws.mode === 'current'
      ? await changedFiles(ws.path, ws.baselineRef ?? 'HEAD')
      : await changedFiles(ws.path, await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef))
    this.filesMoved(id, files.map((f) => `${f.status} ${f.path}`).join('\0'))
    const stat = { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) }
    const old = this.mustWs(id).stat
    if (!old || old.files !== stat.files || old.added !== stat.added || old.removed !== stat.removed) this.updateWs(id, { stat })
    return files
  }

  /**
   * The worktree's changed files differ from the last read, so the mentions resolved before may not hold: one was made, deleted or
   * renamed. Every turn's end reads the changes, so the cache doesn't outlive a turn that moved files.
   */
  private filesMoved(id: string, changed: string) {
    if (this.mentions.get(id)?.changed !== changed) this.mentions.set(id, { changed, paths: new Map() })
  }

  /** The scratchpads of the workspace's Claude chats, built from each chat's own session (clickable file mentions). */
  private scratchpads(ws: Workspace): string[] {
    return this.store.chats(ws.id).filter((c) => chatProvider(c) === 'claude' && c.sessionId).map((c) => scratchpadDir(ws.path, c.sessionId!))
  }

  /**
   * What each path mentioned in the workspace's chats resolves to, from the cache when it can. A miss by an absolute or `~/` path
   * isn't kept: the agent may write that file to its scratchpad later in the turn, which the changed files never show.
   */
  async resolvePaths(id: string, paths: string[]): Promise<Record<string, ResolvedPath>> {
    const ws = this.mustWs(id)
    if (ws.worktreePending) return Object.fromEntries(paths.map((p) => [p, null]))
    const cache = this.mentions.get(id) ?? { paths: new Map<string, ResolvedPath>() }
    this.mentions.set(id, cache)
    const todo = [...new Set(paths)].filter((p) => !cache.paths.has(p))
    if (todo.length) {
      const found = await resolvePaths(ws.path, todo, { also: this.scratchpads(ws), home: this.home }).catch(() => ({} as Record<string, ResolvedPath>))
      for (const raw of todo) {
        const r = found[raw] ?? null
        if (r || !/^\s*[~/]/.test(raw)) cache.paths.set(raw, r)
      }
    }
    return Object.fromEntries(paths.map((p) => [p, cache.paths.get(p) ?? null]))
  }

  /**
   * A Lead chat whose worktree isn't made yet, or one on the shared main folder, which has no worktree of its own: nothing reads
   * its folder for changes, and the right panel gets empty lists (KERNEL-542, KERNEL-1050).
   */
  private unmade(id: string) { const ws = this.mustWs(id); return !!ws.worktreePending || !!ws.shared }

  /** Refuses what needs the folder of a Lead chat whose worktree isn't made yet (KERNEL-542). */
  private mustBeMade(id: string) { if (this.mustWs(id).worktreePending) throw new Error("This chat's worktree isn't made yet.") }

  /** What the diff compares against: the baseline for current-branch workspaces, the merge base with the base branch otherwise. */
  private async since(ws: Workspace) {
    return ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)
  }

  private async diff(id: string, file?: string) {
    const ws = this.mustWs(id)
    return diffText(ws.path, await this.since(ws), file)
  }

  /**
   * The files a compare target other than the base lists (KERNEL-516). The totals `changes` saves stay the work against the
   * base, so nothing is saved or pushed here.
   */
  private async compareFiles(id: string, target: Exclude<CompareTarget, { kind: 'base' }>) {
    if (await this.checkFolder(id)) return []
    const ws = this.mustWs(id)
    return rangeFiles(ws.path, await compareRange(ws.path, target))
  }

  private async compareDiff(id: string, target: Exclude<CompareTarget, { kind: 'base' }>, file?: string) {
    const ws = this.mustWs(id)
    return rangeDiff(ws.path, await compareRange(ws.path, target), file)
  }

  /** The commits on the branch since its base, newest first. A current-branch workspace counts from its baseline, as its changes do. */
  private async commits(id: string) {
    const ws = this.mustWs(id)
    return branchCommits(ws.path, ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : ws.baseRef)
  }

  /** The branches to compare with: the base, then `<remote>/<default>`, then the project's others, newest first (KERNEL-516). */
  private async compareBranches(id: string) {
    const ws = this.mustWs(id)
    const { path } = this.mustProject(ws.projectId)
    const remote = await this.k.config.remoteOfWs(ws)
    const all = await listBranches(path, remote)
    const main = `${remote}/${await defaultBranch(path, remote).catch(() => 'main')}`
    return [...new Set([ws.baseRef, ...all.filter((b) => b === main), ...all])].filter((b) => b !== ws.branch)
  }

  private async hunks(id: string, path?: string) {
    const ws = this.mustWs(id)
    return listHunks(ws.path, { baselineRef: ws.mode === 'current' ? ws.baselineRef : undefined }, path)
  }

  /**
   * Diff totals for every live workspace, once at launch, so the sidebar has them before any turn ends. A worktree whose folder was
   * deleted while Kernel was closed is flagged here (KERNEL-291).
   */
  async countChanges() {
    for (const ws of this.store.workspaces()) {
      if (ws.status === 'archived') continue
      if (ws.status === 'setup') await this.checkFolder(ws.id).catch(() => undefined)
      else await this.changes(ws.id).catch(() => undefined)
    }
  }

  handlers() {
    return {
      'workspaces.list': async ({ projectId }) => this.store.workspaces(projectId),
      // Workspaces you start yourself follow "Start new workspaces in plan mode". The Lead's hand-offs call createWorkspace directly (KERNEL-74).
      'workspaces.create': async ({ projectId, ...o }) => this.createWorkspace(projectId, { ...o, plan: o.plan ?? this.settings.models.workspacePlanMode }),
      'workspaces.fork': async ({ chatId, itemId }) => this.forkWorkspace(chatId, itemId),
      // A Lead chat whose worktree isn't made yet reads as empty, and refuses what would change its files (KERNEL-542).
      'workspaces.changes': async ({ workspaceId, target }) => this.unmade(workspaceId) ? [] : target && target.kind !== 'base' ? this.compareFiles(workspaceId, target) : this.changes(workspaceId),
      'workspaces.diff': async ({ workspaceId, file, target }) => this.unmade(workspaceId) ? '' : target && target.kind !== 'base' ? this.compareDiff(workspaceId, target, file) : this.diff(workspaceId, file),
      'workspaces.commits': async ({ workspaceId }) => this.unmade(workspaceId) ? [] : this.commits(workspaceId),
      'workspaces.compareBranches': async ({ workspaceId }) => this.compareBranches(workspaceId),
      'workspaces.tree': async ({ workspaceId }) => this.mustWs(workspaceId).worktreePending ? [] : listTree(this.mustWs(workspaceId).path, await this.changes(workspaceId).catch(() => [])),
      // A file in the agent's own scratchpad opens too, by its absolute path (clickable file mentions).
      'workspaces.readFile': async ({ workspaceId, path }) => {
        this.mustBeMade(workspaceId)
        const ws = this.mustWs(workspaceId)
        return readWorkspaceFile(ws.path, path, this.scratchpads(ws))
      },
      'workspaces.resolvePaths': async ({ workspaceId, paths }) => this.resolvePaths(workspaceId, paths),
      'workspaces.readImage': async ({ workspaceId, path, at, target }) => {
        const ws = this.mustWs(workspaceId)
        if (ws.worktreePending) return null
        if (!target || target.kind === 'base') return at === 'base' ? readImage(ws.path, path, await this.since(ws)) : readImage(ws.path, path, undefined, this.scratchpads(ws))
        const range = await compareRange(ws.path, target)
        return readImage(ws.path, path, at === 'base' ? range.from : range.to)
      },
      'workspaces.files': async ({ workspaceId, query, limit }) => {
        if (this.mustWs(workspaceId).worktreePending) return []
        const ws = this.mustWs(workspaceId)
        // The project's reference folders too, those that are there now (KERNEL-748).
        const project = this.k.store.project(ws.projectId)
        return searchFiles(ws.path, query, limit, project ? referencesInProject(project.path).present : [])
      },
      'workspaces.hunks': async ({ workspaceId, path }) => this.unmade(workspaceId) ? [] : this.hunks(workspaceId, path),
      'workspaces.commit': async ({ workspaceId, hunkIds, message }) => {
        this.mustBeMade(workspaceId)
        if (this.mustWs(workspaceId).shared) throw new Error('This chat has no worktree of its own. Switch it to Build here first.')
        const picked = (await this.hunks(workspaceId)).filter((h) => hunkIds.includes(h.id))
        if (picked.length !== hunkIds.length) throw new Error('Those changes moved on. Open the card again and pick again.')
        await commitHunks(this.mustWs(workspaceId).path, picked, message?.trim() || `Update ${[...new Set(picked.map((h) => h.path))].join(', ')}`)
        return { ok: true }
      }
    } satisfies Partial<Handlers>
  }
}
