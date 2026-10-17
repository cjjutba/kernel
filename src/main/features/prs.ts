import type { AutoMerge, GitHubErrorKind, GitHubStatus, MergeMethod, PrInfo, PrReads, PrPending, PrState, Project, Workspace } from '@shared/types'
import { bus } from '../bus'
import { type AppSettings, autoMergeInProject, loadRepoSettings, localSettingsOwn, prInstructions, sharedMergeOf } from '../services/settings'
import { branchExists, currentBranch, fastForward, fetchOrigin, folderGone, freeBranch, isAncestor, isPushed, stripRemote } from '../services/worktrees'
import { exec, git } from '../services/exec'
import { BranchConflict, type CodeHost, fingerprintOf, GhReadError, HEAD_MOVED, ownPrNote, prNote, resolveFile } from '../services/github'
import { type PrContext, prTextFor } from '../services/conventions'
import { PrCadence } from '../services/prCadence'
import { inPaths } from '../services/lenses'
import { ALWAYS_REVIEW, autoMergeBlock, autoMergeRetry, autoMergeWhy, blockedWhy, gatingChecks, kindStates, mergeableState, mergeBlock, mergeNeedsPr, type AutoMergeFacts } from '@shared/merge'
import type { Handlers } from '../kernel'
import { prNoteOf, reviseNote } from './records'
import { Feature } from './feature'

/** PR states whose next read is likely to differ soon, so the poll runs at its fast rate (KERNEL-388). */
const MOVING: PrState[] = ['creating', 'checks', 'merging', 'resolving']

/** How the chat says a local merge landed: "Squashed into main as 4e1b9c2." (KERNEL-467). */
const LANDED_HERE: Record<MergeMethod, string> = { squash: 'Squashed into', merge: 'Merged into', rebase: 'Rebased onto' }

/** Why a second PR action is refused, by the action already running. `what` is "branch" for a project with no GitHub (KERNEL-519). */
const BUSY: Record<PrPending, (what: string) => string> = {
  create: () => 'Kernel is already creating this pull request.',
  resolve: (what) => `Kernel is already asking the agent to fix this ${what}.`,
  merge: (what) => `Kernel is already merging this ${what}.`,
  ready: () => 'Kernel is already marking this pull request ready.',
  reopen: () => 'Kernel is already reopening this pull request.',
  update: () => 'Kernel is already asking the agent to update this branch.'
}

/** Each workspace's pull request: opening, reading, merging and following its branch (KERNEL-330). */
export class Prs extends Feature {

  /** Workspaces whose merge Kernel is running, so the poll doesn't overwrite `merging`. */
  private merging = new Set<string>()
/** The method of a merge Kernel ran, until the PR is seen merged, so the note says how it landed. */
  private mergedWith = new Map<string, AppSettings['pr']['mergeMethod']>()
  /** The PR action running on each workspace, from whichever button or tool started it (KERNEL-519). */
  private pending = new Map<string, PrPending>()

  /**
   * Runs one PR action with the workspace marked pending, so every place showing the PR spins from the press, not from the
   * first state the action reaches seconds later (KERNEL-519). The push goes out before anything is awaited, and the clear
   * after the action's last `pr` push, so no place shows the old button in between. One action at a time per PR.
   */
  private async running<T>(id: string, action: PrPending, fn: () => Promise<T>): Promise<T> {
    const now = this.pending.get(id)
    if (now) {
      const ws = this.store.workspace(id)
      throw new Error(BUSY[now](ws && this.isLocal(ws) ? 'branch' : 'pull request'))
    }
    this.pending.set(id, action)
    bus.push({ type: 'pr.pending', workspaceId: id, action })
    try {
      return await fn()
    } finally {
      this.pending.delete(id)
      bus.push({ type: 'pr.pending', workspaceId: id })
    }
  }

  private setPrState(ws: Workspace, prState: PrState) {
    const before = this.mustWs(ws.id).prState
    const next = this.updateWs(ws.id, { prState })
    if (next.prState !== before) bus.push({ type: 'pr', workspaceId: ws.id, state: prState })
    return next
  }

  /** The PR instructions for a workspace: its project's, else Settings > Pull requests (KERNEL-190). */
  private async prTexts(ws: Workspace) {
    return prInstructions(this.settings.pr, (await loadRepoSettings(this.mustProject(ws.projectId).path)).pr)
  }

  /**
   * Sends `create-pr.md` (the project's or Settings > PRs, Kernel's own fitted to the repo's conventions, KERNEL-468) to the
   * agent. The header shows Creating until its turn ends.
   */
  createPr(id: string, draft = false) { return this.running(id, 'create', () => this.create(id, draft)) }

  private async create(id: string, draft: boolean) {
    const ws = this.mustWs(id)
    if (ws.prState !== 'none') throw new Error('This workspace already has a pull request.')
    if (this.isLocal(ws)) throw new Error('This project merges on this Mac, so there is no pull request to open. Its branch can merge once it has commits.')
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    const remote = await this.k.config.remoteOfWs(ws)
    const ctx: PrContext = { branch: ws.branch, base: stripRemote(ws.baseRef, remote), remote, draft: draft || this.settings.pr.draft }
    const written = (await this.prTexts(ws)).createInstructions
    const text = await prTextFor('create', written, ws.path, ctx)
    // Kernel's own text says `--draft` in its command. Text that goes out as written gets the line.
    await this.sessions.send(chat.id, [{ type: 'file', name: 'create-pr.md', text: text === written && ctx.draft ? `${text}\nOpen as draft` : text }])
    return this.setPrState(ws, 'creating')
  }

  /** The checks a project never counts, from its `[pr] optional_checks` (KERNEL-388). */
  private async optionalOf(projectId: string): Promise<string[]> {
    const project = this.store.project(projectId)
    return project ? (await loadRepoSettings(project.path).catch(() => undefined))?.pr?.optionalChecks ?? [] : []
  }

  /**
   * The full read of the workspace's PR, with the project's optional checks. Null when there is no PR; rejects with GhReadError
   * when GitHub couldn't be read, after telling the poll to hold off when it was the rate limit (KERNEL-388).
   */
  private async read(ws: Workspace, cwd: string, ref: string, o: { conflicts?: boolean; remote?: string } = {}): Promise<PrInfo | null> {
    const host = this.host(ws.projectId)
    try {
      const optional = await this.optionalOf(ws.projectId)
      const info = await host.info(cwd, ref, ws.id, { ...o, ...(this.isLocal(ws) ? { base: ws.baseRef } : {}), ...(optional.length ? { optional } : {}) })
      if (!this.isLocal(ws)) this.noteGitHub(ws.projectId)
      return info
    } catch (e) {
      if (e instanceof GhReadError && e.rateLimited) await this.limited(e, host, cwd)
      if (e instanceof GhReadError && !this.isLocal(ws)) this.noteGitHub(ws.projectId, e.kind)
      throw e
    }
  }

  /** Each GitHub project's PR status reads, by project id: the last one GitHub answered, and why the last one failed (KERNEL-861). */
  private reads = new Map<string, PrReads>()

  /**
   * A PR status read of the project's GitHub went through, or failed with `failed`. A failure keeps the last good read's time.
   * A read that starts or ends a failure tells the window now. A new time alone waits for the poll's end, which tells it
   * once for all its reads, so the reads after every turn don't each push.
   */
  private noteGitHub(projectId: string, failed?: GitHubErrorKind) {
    const was = this.reads.get(projectId)
    this.reads.set(projectId, failed ? { ...(was?.at ? { at: was.at } : {}), failed } : { at: Date.now() })
    if (was?.failed !== failed) this.syncGitHub()
  }

  /** The rate limit pause and each project's PR status reads, as the footer and the Pull requests page show them. */
  private githubStatus(): GitHubStatus {
    const status = this.cadence.status()
    const reads = [...this.reads].filter(([projectId]) => this.store.project(projectId))
    return reads.length ? { ...status, reads: Object.fromEntries(reads) } : status
  }

  /** Where the project's PRs live (KERNEL-453). */
  private host(projectId: string): CodeHost { return this.k.codeHost.hostFor(this.mustProject(projectId)) }

  /** The workspace's project has no GitHub, so its branch merges on the Mac (KERNEL-467). */
  private isLocal(ws: Workspace) { return this.store.project(ws.projectId)?.host === 'local' }

  /** A read GitHub refused for its rate limit. The primary limit's reset comes from `gh api rate_limit`, which costs nothing. */
  private async limited(e: GhReadError, host: CodeHost, cwd: string) {
    const resetAt = e.secondary ? undefined : (await host.rateLimit?.(cwd).catch(() => undefined))?.resetAt
    this.cadence.limited({ secondary: e.secondary, resetAt })
    this.syncGitHub()
  }

  /** The GitHub pause as last pushed, so the window hears each start, move and end once (KERNEL-401). */
  private pushedGitHub = '{}'

  /**
   * Pushes the GitHub pause to the window when it starts, moves or ends, for the footer (KERNEL-401), and each project's PR
   * status reads when they change (KERNEL-861). The poll's own timer runs at the pause's end, so main says when it is over
   * and the window never times it out itself.
   */
  private syncGitHub() {
    const status = this.githubStatus()
    const key = JSON.stringify(status)
    if (key === this.pushedGitHub) return
    this.pushedGitHub = key
    bus.push({ type: 'github', status })
  }

  /** One button, three situations: conflicts, failing checks, or review comments. Each sends its own instructions, with what GitHub reports. */
  resolvePr(id: string) { return this.running(id, 'resolve', () => this.resolve(id)) }

  private async resolve(id: string) {
    const ws = await this.syncBranch(id)
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    if (ws.prState !== 'conflict' && ws.prState !== 'cifail' && ws.prState !== 'changes') throw new Error('This pull request has nothing to fix.')
    const remote = await this.k.config.remoteOfWs(ws)
    // A read that failed still sends the instructions, without what GitHub reports.
    const info = await this.read(ws, ws.path, ws.branch, { remote }).catch((e) => { if (e instanceof GhReadError) return null; throw e })
    if (info) bus.push({ type: 'pr.info', info })
    const prNumber = info?.number ?? ws.prNumber
    const ctx: PrContext = { branch: ws.branch, base: stripRemote(info?.baseRef || ws.baseRef, remote), remote, ...(prNumber ? { prNumber } : {}) }
    const [kind, key] = ({ conflict: ['resolve', 'resolveInstructions'], cifail: ['fixChecks', 'fixChecksInstructions'], changes: ['addressReview', 'addressReviewInstructions'] } as const)[ws.prState]
    const texts = await this.prTexts(ws)
    const [name, text] = resolveFile(ws.prState, { ...texts, [key]: await prTextFor(kind, texts[key], ws.path, ctx) }, info)
    this.k.lead.userSpoke(chat.id)
    await this.sessions.send(chat.id, [{ type: 'file', name, text }])
    this.setPrState(ws, 'resolving')
  }

  /**
   * Update branch, for a branch that merges on this Mac and has fallen behind its base (KERNEL-478): asks the agent to merge
   * the base in and re-run the tests. A merge, not a rebase, since a pushed branch could only take a rebase with the force push
   * a force push, which the team doesn't make (KERNEL-886). One the remote has is pushed as usual. GitHub has its own button for a PR, so a project on GitHub refuses. Nothing changes state, so the
   * band keeps reading Behind until the next read finds the branch caught up.
   */
  updateBranch(id: string) { return this.running(id, 'update', () => this.update(id)) }

  private async update(id: string) {
    const ws = this.mustWs(id)
    if (!this.isLocal(ws)) throw new Error('Only a branch that merges on this Mac updates this way. GitHub updates a pull request.')
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    const info = await this.read(ws, ws.path, ws.branch)
    const behind = info?.local?.behind ?? 0
    const base = info?.baseRef ?? ws.baseRef
    if (!behind) throw new Error(`This branch is up to date with ${base}.`)
    const remote = await this.k.config.remoteOfWs(ws)
    const pushed = await isPushed(ws.path, ws.branch, remote)
    this.k.lead.userSpoke(chat.id)
    const steps = pushed
      ? `run git merge ${base}, resolve any conflicts, re-run the tests and push as usual. The branch is on ${remote}, so merge rather than rebase.`
      : `run git merge ${base}, resolve any conflicts and re-run the tests.`
    await this.sessions.send(chat.id, [{ type: 'text', text: `${base} has ${behind} new ${behind === 1 ? 'commit' : 'commits'} that this branch doesn't have. Commit your work, ${steps} Then say what you changed.` }])
  }

  /** Each PR's last full read and when, so opening a workspace again within `infoMs` doesn't read GitHub again. */
  private infos = new Map<string, { info: PrInfo; at: number }>()
  infoMs = 10_000

  /**
   * The PR's checks, review comments and conflicts, for the Checks tab and the review card. It goes through `refreshPr`, so
   * the header moves with what the tab shows (KERNEL-388). Null when there is no PR or GitHub couldn't be read.
   */
  private async getPr(id: string) {
    const ws = this.mustWs(id)
    // A local merge has no number, and what it reads is the branch as it is now (KERNEL-467).
    const local = this.isLocal(ws)
    if (!ws.prNumber && !local) return null
    // An archived workspace, opened from History, keeps its state and only shows what GitHub says now. Git says nothing
    // about a local one that isn't on its workspace already.
    if (ws.status === 'archived') {
      if (local) return null
      const info = await this.read(ws, ws.path, ws.branch, { remote: await this.k.config.remoteOfWs(ws) }).catch(() => null)
      if (info) bus.push({ type: 'pr.info', info })
      return info
    }
    const last = this.infos.get(id)
    if (last && Date.now() - last.at < this.infoMs) return last.info
    await this.k.refreshPr(id).catch(() => undefined)
    return this.infos.get(id)?.info ?? null
  }

  /**
   * Reads the PR from GitHub and moves the header to its state. `settle` is true once the agent's turn is over:
   * until then Creating and Resolving hold, so the header doesn't flash the old state while the agent works.
   * A workspace with no PR yet only adopts an open one, never an old merged or closed PR on the same branch name.
   * A worktree folder deleted outside Kernel can't run gh, so the project asks for the PR by number instead (KERNEL-109).
   */
  async refreshPr(id: string, o: { settle?: boolean } = {}): Promise<Workspace> {
    const asked = await this.syncBranch(id)
    // A Lead chat whose worktree isn't made yet has no branch on GitHub to read (KERNEL-542).
    if (asked.status === 'archived' || asked.worktreePending) return asked
    const remote = await this.k.config.remoteOfWs(asked)
    let read: PrInfo | null
    try {
      read = await folderGone(asked.path)
        ? await this.read(asked, this.mustProject(asked.projectId).path, asked.prNumber ? String(asked.prNumber) : asked.branch, { conflicts: false })
        : await this.read(asked, asked.path, asked.branch, { remote })
    } catch (e) {
      // GitHub couldn't be read: the PR stays as it was, and the poll backs off (KERNEL-388).
      if (e instanceof GhReadError) return this.readFailed(id, o)
      throw e
    }
    const info = read
    if (info) bus.push({ type: 'pr.info', info })
    // gh takes seconds. Decide on the workspace as it is now: it may have been archived, or a merge may have started.
    const ws = this.mustWs(id)
    if (ws.status === 'archived') return ws
    // Kernel is bringing the PR up to date (KERNEL-835). The new head waits until the update is recorded, or its ready
    // reaches `onReady` first and starts a review round of its own. `bringUpToDate` reads it again after.
    if (this.updating.has(id)) return ws
    this.noteRead(id, ws, info)
    if (info) {
      this.prints.set(id, fingerprintOf(info))
      this.infos.set(id, { info, at: Date.now() })
      // A read of git says nothing about GitHub's limits.
      if (!this.isLocal(ws)) this.cadence.ok()
    }
    const settle = o.settle ?? !this.agentBusy(ws)
    const hold = this.held(ws, settle)
    const state = this.nextState(ws, info, settle)
    const adopt = info && state !== 'none'
    const patch: Partial<Workspace> = {
      prState: state,
      // A local merge has no number or url to keep (KERNEL-467).
      ...(adopt ? { ...(info.number ? { prNumber: info.number, prUrl: info.url } : {}), prTitle: info.title || ws.prTitle, ...(info.head ? { prHead: info.head } : {}) } : {}),
      // GitHub's word on merging a ready PR goes with the state, and a held state keeps the last one (KERNEL-388).
      ...(info && !hold ? { prBlocked: state === 'ready' ? info.blocked : undefined } : {}),
      ...(state === 'merged' && !ws.mergedAt ? { mergedAt: Date.now() } : {})
    }
    // A read that changes nothing isn't saved or pushed, so each poll doesn't redraw the window and refresh every task (KERNEL-216).
    const same = (Object.keys(patch) as (keyof Workspace)[]).every((key) => patch[key] === ws[key])
    const next = same ? ws : this.updateWs(id, patch)
    // A ready PR whose checks ran again between two reads changes no field, so no workspace event weighs it (KERNEL-703).
    if (same && info && next.prState === 'ready') this.considerAutoMerge(next)
    if (info?.conflictsUnknown) this.recheckSoon(id)
    else if (info) this.cancelRecheck(id)
    this.guardOnReady(id, ws.prState, next.prState, info, ws.prBlocked === 'behind')
    if (next.prState !== ws.prState) this.moved(ws, next, prNote(next, info, this.mergedWith.get(id), remote, this.ownChat(next) ? this.autoWhy.get(id) : undefined))
    // A ready PR GitHub started or stopped blocking, its state the same, so nothing above told anyone (KERNEL-401). A PR that
    // becomes ready already blocked goes out with its 'pr' push, which the Lead and the Inbox read prBlocked on.
    if (ws.prState === 'ready' && next.prState === 'ready' && ws.prBlocked !== next.prBlocked) {
      bus.push({ type: 'pr.blocked', workspaceId: id, ...(next.prBlocked ? { blocked: next.prBlocked } : {}) })
      if (next.prBlocked) this.readyNote(id, `GitHub blocks the merge: ${blockedWhy[next.prBlocked]}`, 'GitHub blocks')
    }
    return next
  }

  /** Tells the window, the project's activity and the chat that the PR moved from `ws`'s state to `next`'s. */
  private moved(ws: Workspace, next: Workspace, text: string | undefined) {
    const id = ws.id
    this.changedAt = Date.now()
    bus.push({ type: 'pr', workspaceId: id, state: next.prState })
    bus.activity({ kind: 'pr.changed', projectId: ws.projectId, workspaceId: id, agentId: ws.agentId, text: `PR is ${next.prState}`, object: next.prNumber ? `#${next.prNumber}` : undefined })
    // The chat's own PR in Build here says nothing when it opens, since the Lead's reply does, and nothing when it is ready,
    // since an approval or the merge button does, except what the screen doesn't show (KERNEL-990).
    if (next.prState === 'ready' && next.prBlocked) this.readyNote(id, `GitHub blocks the merge: ${blockedWhy[next.prBlocked]}`, 'GitHub blocks')
    if (text && next.prState === 'merged') this.noteOnce(id, text, 'merged', next.prNumber)
    else if (text) this.note(id, text, next.prState === 'closed' || next.prState === 'cifail' ? next.prState : undefined)
    if (next.prState === 'merged') {
      this.mergedWith.delete(id)
      this.autoWhy.delete(id)
      void this.overlaps.check(ws.projectId).catch(() => undefined)
      // Main moved. A teammate with no PR yet hears it if that would conflict with its work (KERNEL-180). A local merge moved
      // it on this Mac, so there is nothing to fetch.
      void this.k.baseWatch.check(ws.projectId, { fetch: !this.isLocal(ws) }).catch(() => undefined)
    }
  }

  /** Whether the workspace is a Build here chat's own, whose PR news is rows (KERNEL-990). */
  private ownChat(ws: Workspace) { return !!this.k.lead.buildTab(ws) }

  /** Why Kernel is merging each Build here chat's own PR by itself, until the merge shows, so its row says so (KERNEL-990). */
  private autoWhy = new Map<string, string>()

  /** Auto-merge left the chat's own PR, so its ready row says why Kernel didn't merge it (KERNEL-990). */
  private refusal(id: string, why: string) {
    this.readyNote(id, `Kernel didn't merge it automatically: ${why}`, "Kernel didn't merge it")
  }

  /**
   * The chat's own ready row, posted only when it says what the screen doesn't (KERNEL-990): no review ran, auto-merge
   * refused, or GitHub blocks the merge. `tail` is that reason, added to the row once per `key`. Hand off chats get none.
   */
  readyNote(id: string, tail?: string, key = tail) {
    const ws = this.k.store.workspace(id)
    if (!ws || !this.ownChat(ws) || !ws.prNumber || ws.prState !== 'ready') return
    const row = prNoteOf(this.k.store, id, 'ready', ws.prNumber)
    if (!row) return this.noteOnce(id, ownPrNote(ws, tail), 'ready', ws.prNumber)
    if (tail && key && !row.item.text.includes(key)) reviseNote(this.k.store, row.chatId, row.item, `${row.item.text}. ${tail}`)
  }

  /** Creating and Resolving hold while the agent works, and `merging` while Kernel's merge runs. */
  private held(ws: Workspace, settle: boolean) {
    return this.merging.has(ws.id) || (!settle && (ws.prState === 'creating' || ws.prState === 'resolving'))
  }

  /** The state a read moves the workspace to, after the holds. `info` null means GitHub found no PR. */
  private nextState(ws: Workspace, info: PrInfo | null, settle: boolean): PrState {
    if (this.held(ws, settle)) return ws.prState
    // A local merge is final, and git can't tell a squashed branch from one that never merged (KERNEL-467).
    if (ws.prState === 'merged' && this.isLocal(ws)) return 'merged'
    if (!info) return ws.prState === 'creating' || !ws.prNumber ? 'none' : ws.prState === 'resolving' ? 'open' : ws.prState
    if (!ws.prNumber && (info.state === 'merged' || info.state === 'closed')) return 'none'
    // A conflict holds until GitHub has checked the PR again. The rest of the read is real (KERNEL-283).
    if (info.conflictsUnknown && ws.prState === 'conflict') return 'conflict'
    return info.state
  }

  /**
   * A read GitHub couldn't do changes no state, so a network blip or a rate limit doesn't turn Creating back into Create PR.
   * It counts toward the PR's backoff (KERNEL-216). A Creating PR whose turn is over, read and failed three times in a row,
   * does go back, so its spinner can't stay forever (KERNEL-388).
   */
  private readFailed(id: string, o: { settle?: boolean }): Workspace {
    const ws = this.mustWs(id)
    const p = this.polls.get(id) ?? { due: 0, failures: 0, changedAt: Date.now() }
    this.polls.set(id, { ...p, failures: p.failures + 1 })
    const settle = o.settle ?? !this.agentBusy(ws)
    if (ws.status !== 'archived' && ws.prState === 'creating' && !ws.prNumber && settle && p.failures + 1 >= 3) return this.setPrState(ws, 'none')
    return ws
  }

  /** Workspaces whose PR has shown checks, so a ready read with none is a push GitHub hasn't checked yet, not a repo without CI. */
  private hasChecks = new Set<string>()
  /** Ready reads with none of the checks the PR has had: the work moves on once those checks have run and passed. */
  private readyUnchecked = new Set<string>()
  /** The head commit each PR was on when the loop guard last started over for it being ready. */
  private guardReadyOn = new Map<string, string>()

  /**
   * The work moved on, so the loop guard starts over for it and its reviews (KERNEL-125): when the PR becomes ready. Right
   * after a push GitHub has no checks for the new commit and reads the PR as ready for a moment, so on a PR that has had
   * checks, ready counts once they ran, even if the state read ready all along. A ready PR still behind its base hasn't
   * moved on either: the Lead asks its agent to update it, and an update onto a stale base would otherwise start the guard
   * over every round. Leaving behind does count (KERNEL-401). `wasBehind` is the block before this read.
   */
  private guardOnReady(id: string, before: PrState, after: PrState, info: PrInfo | null | undefined, wasBehind = false) {
    if (info?.checks.length) this.hasChecks.add(id)
    if (after !== 'ready') { this.readyUnchecked.delete(id); if (after !== 'checks') this.guardReadyOn.delete(id); return }
    if (info?.blocked === 'behind') return
    if (!info?.checks.length && this.hasChecks.has(id)) { this.readyUnchecked.add(id); return }
    // Ready again on the commit the guard started over on, after only checks, isn't the work moving on. GitHub checks a
    // PR for conflicts again each time its base moves, and it reads as checks until then (KERNEL-283).
    const again = before === 'checks' && !!info?.head && this.guardReadyOn.get(id) === info.head
    const caughtUp = before === 'ready' && wasBehind
    if ((before !== 'ready' && !again) || caughtUp || this.readyUnchecked.delete(id)) {
      this.nudges.reset(id, ...this.k.autoArchive.reviewsOf(id))
      if (info?.head) this.guardReadyOn.set(id, info.head)
    }
  }

  /**
   * Merges with the project's method (`codeHost.methodFor`, KERNEL-468) once `mergeBlock` finds nothing in the way: green
   * checks and a reviewer's approval of the latest commit, as far as Settings > Pull requests asks for them (KERNEL-115),
   * and no blockers on it. `override` is a person's Merge anyway past those blockers; the Lead never passes it
   * (KERNEL-497). `head` is the commit auto-merge weighed: a PR GitHub reads at another one doesn't merge (KERNEL-556).
   */
  mergePr(id: string, o: { override?: boolean; head?: string } = {}) { return this.running(id, 'merge', () => this.merge(id, o)) }

  private async merge(id: string, o: { override?: boolean; head?: string }) {
    let ws = await this.syncBranch(id)
    const rules = this.settings.pr
    // GitHub is read fresh for every PR that last read as mergeable, since another merge may have sent GitHub back to
    // checking it for conflicts (KERNEL-376). One that isn't, mergeBlock refuses anyway.
    const fresh = async (): Promise<PrInfo | null | undefined> => {
      if (!mergeableState(ws.prState)) return undefined
      try {
        return await this.read(ws, ws.path, ws.branch, { remote: await this.k.config.remoteOfWs(ws) })
      } catch (e) {
        if (!(e instanceof GhReadError)) throw e
        // A failed read stops the merge only when a rule needs GitHub's word (KERNEL-376), and says when a rate limit resets.
        const at = e.rateLimited ? this.cadence.resumesAt() : undefined
        if (mergeNeedsPr(ws, rules)) throw new Error(`Could not read the pull request from GitHub.${at ? ` GitHub's rate limit resets at ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}`)
        return null
      }
    }
    let info = await fresh()
    // Right after another merge GitHub is still working out whether this PR conflicts with the new base. The merge waits
    // for its answer instead of refusing, so a second Merge pressed right after the first goes through (KERNEL-411).
    for (let waited = 0; info?.conflictsUnknown && waited < Prs.conflictWait.cap; waited += Prs.conflictWait.every) {
      await new Promise((resolve) => setTimeout(resolve, Prs.conflictWait.every))
      ws = this.mustWs(id)
      info = await fresh()
    }
    if (info?.conflictsUnknown) throw new Error(`GitHub is still checking ${ws.prNumber ? `#${ws.prNumber}` : 'this pull request'} for conflicts. Try again in a moment.`)
    if (info) bus.push({ type: 'pr.info', info })
    if (o.head && info?.head !== o.head) throw new Error(HEAD_MOVED)
    const name = (agentId: string) => this.agentsSync(ws.projectId).find((a) => a.id === agentId)?.name ?? agentId
    const block = mergeBlock(ws, info, rules, name, { override: o.override })
    if (block) throw new Error(block)
    const method = await this.k.codeHost.methodFor(this.mustProject(ws.projectId))
    this.merging.add(id)
    this.setPrState(ws, 'merging')
    let landed: { sha: string; base: string } | void
    try {
      // GitHub merges only the head Kernel checked: the one auto-merge weighed, else the one the fresh read found (KERNEL-829).
      const head = o.head ?? info?.head
      landed = await this.host(ws.projectId).merge(ws.path, ws.branch, method, { base: ws.baseRef, title: ws.prTitle ?? ws.title, ...(head ? { head } : {}) })
      this.mergedWith.set(id, method)
      this.updateWs(id, { mergedWith: method })
    } catch (e) {
      this.k.codeHost.forgetMergeMethods(this.mustProject(ws.projectId))
      this.merging.delete(id)
      const after = await this.k.refreshPr(id, { settle: true }).catch(() => undefined)
      // gh can fail or time out after GitHub merged: the read says what happened (KERNEL-829).
      if (after?.prState === 'merged') {
        this.mergedWith.set(id, method)
        return this.updateWs(id, { mergedWith: method })
      }
      throw e
    }
    this.merging.delete(id)
    if (landed) return this.landedHere(id, method, landed)
    // GitHub works out again whether every other PR into the base conflicts, so the poll follows them closely (KERNEL-388).
    this.pollSoon()
    return this.k.refreshPr(id, { settle: true })
  }

  /**
   * A merge Kernel made on the Mac is done once git says so (KERNEL-467). Reading the branch again would find a squashed
   * branch still ahead of its base, so the workspace moves to merged here, and the push drives `archiveMerged` (wiring.ts).
   */
  private landedHere(id: string, method: MergeMethod, landed: { sha: string; base: string }): Workspace {
    const ws = this.mustWs(id)
    const next = this.updateWs(id, { prState: 'merged', mergedAt: ws.mergedAt ?? Date.now(), mergeCommit: landed.sha })
    this.moved(ws, next, `${LANDED_HERE[method]} ${landed.base} as ${landed.sha.slice(0, 7)}.`)
    return next
  }

  /** How often and how long a merge re-reads a PR GitHub is still checking for conflicts, in ms. Tests shorten it. */
  static conflictWait = { every: 2000, cap: 30_000 }

  /** What each workspace's PR was when Kernel last weighed it for auto-merge, so each change is weighed once (KERNEL-556). */
  private weighed = new Map<string, string>()
  /** How many times Kernel weighed each workspace's PR again at the same key, after a refusal GitHub hadn't settled (KERNEL-768). */
  private retries = new Map<string, { key: string; n: number }>()
  /** How many times one key is weighed again before its refusal stands. Each waits for the quick re-read, `recheckMs`. */
  static autoMergeRetries = 8
  /**
   * How many times Kernel brought each workspace's PR up to date before merging it by itself (KERNEL-835), by PR number, the
   * heads the last update started from and made, and whether the Lead heard that Kernel stopped.
   */
  private updates = new Map<string, { pr: number; n: number; from?: string; head?: string; told?: boolean }>()
  /** Workspaces whose PR Kernel is bringing up to date now, so two weighs of the same head update it once. */
  private updating = new Set<string>()
  /** The most times Kernel brings one PR up to date. Past that, the Lead tells the user and Kernel leaves it (KERNEL-835). */
  static maxUpdates = 3
  /** Projects already warned that their shared settings file sets a personal `[merge]` key, by project id and the keys. */
  private warnedMerge = new Set<string>()

  /**
   * A workspace changed (wiring.ts). A teammate's PR that reads ready, with an approval of its head and no blockers on it, is
   * weighed for auto-merge once per head, set of approvals, GitHub block (KERNEL-556) and settled checks (KERNEL-703). Until the user's auto-merge is on,
   * that costs reading the project's two settings files. While it is on, the Lead's updates on the PR wait for the outcome, so
   * The Lead doesn't say "ready to merge" about a PR Kernel is merging.
   */
  considerAutoMerge(ws: Workspace) {
    if (this.stopped || ws.status === 'archived' || ws.reviewOf || ws.prState !== 'ready' || !ws.prNumber) return
    const s = kindStates(ws)
    // An overrule clears the way for a merge a person starts, never for Kernel's own (KERNEL-732).
    if (!s.approved.length || s.blocking.length || s.overruled.length) return
    // The checks as the last read settled them, so a check that ran after a weigh refused it brings a new one (KERNEL-703).
    const checks = (this.infos.get(ws.id)?.info.checks ?? []).map((c) => `${c.name}=${c.state}${c.url ? `@${c.url}` : ''}`).join(',')
    const key = [ws.prNumber, ws.prHead ?? '', s.approved.join(','), ws.prBlocked ?? '', checks].join(':')
    if (this.weighed.get(ws.id) === key) return
    this.weighed.set(ws.id, key)
    const project = this.store.project(ws.projectId)
    const app = this.settings?.pr.autoMerge
    if (!project || !app) return
    const { rules, ignored } = autoMergeInProject(project.path, app)
    this.warnIgnored(project, ignored)
    if (!rules.on) return
    this.leadUpdates.readingPr(ws.id)
    void this.autoMerge(ws.id).catch(() => undefined).finally(() => this.leadUpdates.readPr(ws.id))
  }

  /**
   * Merges the workspace's PR by itself when the user's auto-merge allows it (KERNEL-556), or says why not. The merge goes
   * through `mergePr`, so `mergeBlock` and its fresh GitHub read apply as to any merge, held to the head commit Kernel weighed.
   * The Lead hears either way: "Merged automatically" and why, or why not on the ready to merge line. A PR whose checks ran
   * against an older base isn't merged: Kernel brings its branch up to date and waits for its checks (`bringUpToDate`, KERNEL-835).
   */
  async autoMerge(id: string): Promise<{ merged: Workspace } | { refused: string } | { updated: string }> {
    const ws = this.mustWs(id)
    const key = this.weighed.get(id)
    const project = this.mustProject(ws.projectId)
    const app = this.settings.pr.autoMerge
    let { rules, personal } = autoMergeInProject(project.path, app)
    // A personal file the repo committed isn't the user's, so it can't turn auto-merge on (KERNEL-209).
    if (personal && !(await localSettingsOwn(project.path))) rules = app
    const read = await this.mergeFacts(ws, project, rules)
    const host = this.host(ws.projectId)
    // A branch behind its base is Kernel's to update when the host can, so GitHub's block on it refuses nothing (KERNEL-835).
    const behind = !!host.updateBranch && read.pr?.blocked === 'behind'
    const facts = behind && read.pr ? { ...read, pr: { ...read.pr, blocked: undefined } } : read
    const why = autoMergeWhy(facts)
    const pr = facts.pr
    const head = pr?.head
    if (!why || !pr || !head) {
      const said = autoMergeBlock(facts) ?? "Kernel couldn't read the pull request from GitHub."
      // The head Kernel's update made may not have its checks yet, which isn't the PR having none (KERNEL-835).
      const waiting = !!head && this.updates.get(id)?.head === head && !gatingChecks(pr?.checks ?? []).length
      // The Lead hears a refusal GitHub hadn't settled only once Kernel stops weighing it again (KERNEL-768).
      if ((autoMergeRetry(facts) || waiting) && this.weighAgain(id, key)) return { refused: said }
      if (rules.on) { this.leadUpdates.autoMergeRefused(id, said); this.refusal(id, said) }
      return { refused: said }
    }
    if (host.updateBranch && (behind || await this.baseMoved(project, ws, pr))) return this.bringUpToDate(ws, { ...pr, head })
    this.leadUpdates.autoMerging(id, why)
    if (this.ownChat(ws)) this.autoWhy.set(id, why.why)
    const object = `PR #${pr.number}`
    try {
      const merged = await this.mergePr(id, { head })
      bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: id, agentId: ws.agentId, actor: 'kernel', text: 'merged automatically', object })
      return { merged }
    } catch (e) {
      this.leadUpdates.autoMerging(id)
      this.autoWhy.delete(id)
      const said = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0].trim().slice(0, 240)
      // GitHub asks for another try when the base moved during the merge, as when another PR landed (KERNEL-829).
      if ((said.startsWith('GitHub is still checking ') || said.includes('Base branch was modified')) && this.weighAgain(id, key)) return { refused: said }
      this.leadUpdates.autoMergeRefused(id, `The merge Kernel started failed. ${said}`)
      this.refusal(id, `the merge Kernel started failed. ${said}`)
      bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: id, agentId: ws.agentId, actor: 'kernel', text: "couldn't merge automatically", object, warn: true })
      return { refused: said }
    }
  }

  /**
   * The PR's base moved after GitHub last compared it with the PR, so its checks ran against an older base (KERNEL-835): the
   * base's tip, freshly fetched, has GitHub's base commit in its history and isn't it. False when git can't tell.
   */
  private async baseMoved(project: Project, ws: Workspace, pr: PrInfo): Promise<boolean> {
    if (!pr.baseOid) return false
    await fetchOrigin(project.path, await this.k.config.remoteFor(project.path), { fresh: true }).catch(() => undefined)
    const { base } = await this.k.reviews.policyFor(ws)
    if (!base) return false
    const r = await exec('git', ['-C', project.path, 'rev-parse', '--verify', '-q', `${base}^{commit}`])
    const tip = r.stdout.trim()
    return r.code === 0 && !!tip && tip !== pr.baseOid && await isAncestor(project.path, pr.baseOid, tip) === true
  }

  /**
   * Brings a PR auto-merge would merge up to date with its base instead, as its checks ran against an older one (KERNEL-835).
   * GitHub merges the base into the branch, Kernel records the update so the reviews of the old head count on the new one
   * (KERNEL-832), and the new head's checks run. Once they settle, `considerAutoMerge` weighs it again. The teammate's
   * worktree follows (`pullUpdate`). A merge that conflicts moves the PR to conflict, which the Lead asks the teammate to
   * resolve. After `maxUpdates` updates Kernel stops, and the Lead tells the user once.
   */
  private async bringUpToDate(ws: Workspace, pr: PrInfo & { head: string }): Promise<{ refused: string } | { updated: string }> {
    const id = ws.id
    // A weigh that read the PR before it merged, or before Kernel read a newer head, updates nothing. The next read weighs it.
    const now = this.store.workspace(id)
    if (!now || now.prState !== 'ready' || this.merging.has(id) || (now.prHead && now.prHead !== pr.head)) return { refused: 'The pull request changed while Kernel weighed it.' }
    const remote = await this.k.config.remoteOfWs(ws)
    const base = pr.baseRef || stripRemote(ws.baseRef, remote)
    const was = this.updates.get(id)
    const n = was?.pr === pr.number ? was.n : 0
    if (n >= Prs.maxUpdates) {
      const said = `${base} moved past it again after Kernel brought it up to date ${n} times, so Kernel stopped updating it.`
      this.leadUpdates.autoMergeRefused(id, said)
      if (was && !was.told) {
        this.updates.set(id, { ...was, told: true })
        this.leadUpdates.branchUpdated(ws, base, { capped: n })
      }
      return { refused: said }
    }
    if (this.updating.has(id)) return { refused: 'Kernel is already bringing it up to date.' }
    // A weigh that read the head before Kernel's update, and got here after it.
    if (was?.pr === pr.number && was.from === pr.head) return { updated: was.head ?? pr.head }
    this.updating.add(id)
    try {
      return await this.updateNow(ws, pr, base, remote, n)
    } finally {
      this.updating.delete(id)
      void this.k.refreshPr(id).catch(() => undefined)
    }
  }

  /** `bringUpToDate`'s update itself, one at a time per workspace (`updating`). */
  private async updateNow(ws: Workspace, pr: PrInfo & { head: string }, base: string, remote: string, n: number): Promise<{ refused: string } | { updated: string }> {
    const id = ws.id
    const object = `PR #${pr.number}`
    try {
      await this.host(ws.projectId).updateBranch?.(ws.path, String(pr.number))
    } catch (e) {
      const said = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0].trim().slice(0, 240)
      const now = this.mustWs(id)
      if (e instanceof BranchConflict && now.prState === 'ready' && !this.merging.has(id)) {
        const next = this.updateWs(id, { prState: 'conflict', prBlocked: undefined })
        this.moved(now, next, `${object} conflicts with ${base}, so Kernel couldn't bring it up to date.`)
        return { refused: `It conflicts with ${base}.` }
      }
      this.leadUpdates.autoMergeRefused(id, `Kernel couldn't bring it up to date with ${base}. ${said}`)
      bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: id, agentId: ws.agentId, actor: 'kernel', text: `couldn't bring it up to date with ${base}`, object, warn: true })
      return { refused: said }
    }
    this.updates.set(id, { pr: pr.number, n: n + 1, from: pr.head })
    const after = await this.read(ws, ws.path, ws.branch, { remote }).catch(() => null)
    const to = after?.head
    if (to && to !== pr.head) {
      this.updates.set(id, { pr: pr.number, n: n + 1, from: pr.head, head: to })
      await this.k.reviews.recordBaseUpdate(id, pr.head, to).catch(() => false)
      await this.pullUpdate(this.mustWs(id), to, base, pr.number).catch(() => undefined)
    }
    this.leadUpdates.branchUpdated(ws, base)
    bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: id, agentId: ws.agentId, actor: 'kernel', text: `brought it up to date with ${base}, waiting for checks`, object })
    return { updated: to ?? pr.head }
  }

  /**
   * After Kernel brought the PR up to date on GitHub (KERNEL-835): the teammate's worktree moves to `to` when nothing is
   * running or waiting in its chat and its tracked files are clean, as `BaseWatch` catches a worktree up. Otherwise Kernel
   * tells the teammate to pull before it pushes again, and the message waits for a running turn to end.
   */
  private async pullUpdate(ws: Workspace, to: string, base: string, pr: number) {
    if (ws.mode !== 'worktree' || ws.status !== 'ready' || this.stopped || await folderGone(ws.path)) return
    const agent = this.k.team.agentOf(ws.projectId, ws.agentId)?.name ?? 'the teammate'
    if (!this.agentBusy(ws) && await fastForward(ws.path, to)) {
      bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, actor: 'kernel', text: `updated ${agent}'s worktree to the merge of ${base}`, object: `PR #${pr}` })
      void this.k.workspaces.changes(ws.id).catch(() => undefined)
      return
    }
    const chat = this.prChat(ws.id)
    if (!chat) return
    await this.sessions.send(chat.id, [{ type: 'text', text: `Kernel brought PR #${pr} up to date with ${base} on GitHub, so the branch there has a merge commit your worktree doesn't. Run git pull --no-rebase before you push again.` }], { from: 'kernel' })
  }

  /**
   * Weighs the PR again after the quick re-read, as its key hadn't changed (KERNEL-768): `considerAutoMerge` finds it unweighed.
   * False once `key` was weighed again `autoMergeRetries` times, and when Kernel stopped, forgot the PR or weighed a newer
   * key meanwhile, so the refusal stands until the key changes. The quick re-read goes even when an earlier one read unknown.
   */
  private weighAgain(id: string, key: string | undefined): boolean {
    if (this.stopped || key === undefined || this.weighed.get(id) !== key) return false
    const r = this.retries.get(id)
    const n = r?.key === key ? r.n : 0
    if (n >= Prs.autoMergeRetries) return false
    this.retries.set(id, { key, n: n + 1 })
    this.weighed.delete(id)
    this.cancelRecheck(id)
    this.recheckSoon(id)
    return true
  }

  /**
   * What `autoMergeBlock` weighs (KERNEL-556): GitHub's read of the PR, its required reviews from the base branch's `[review]`
   * and their verdicts on GitHub's head, and what it changes against the base branch. Nothing is read with auto-merge off or
   * in a project that merges on this Mac, and nothing past a read of GitHub that failed.
   */
  private async mergeFacts(ws: Workspace, project: Project, rules: AutoMerge): Promise<AutoMergeFacts> {
    const facts: AutoMergeFacts = { rules, local: project.host === 'local', requireGreen: this.settings.pr.requireGreen }
    if (!rules.on || facts.local) return facts
    const pr = await this.read(ws, ws.path, ws.branch, { remote: await this.k.config.remoteOfWs(ws) }).catch(() => null)
    if (!pr?.head) return { ...facts, pr: null }
    const at = { ...ws, prHead: pr.head }
    await this.k.team.agents(ws.projectId)
    const { plan } = await this.k.reviews.planFor(at)
    const s = kindStates(at)
    const reviews = { required: plan.filter((p) => !p.optional).map((p) => p.kind), approved: s.approved, blocking: s.blocking, overruled: s.overruled, running: this.k.reviews.reviewState(at).inProgress }
    const { base } = await this.k.reviews.policyFor(at)
    return { ...facts, pr, reviews, ...(base ? { diff: await this.diffOf(project, base, pr.head, rules) } : {}) }
  }

  /**
   * What the PR changes, as auto-merge counts it (KERNEL-556): the lines it adds and removes against `base`, and its files that
   * Kernel's own always-review paths, the base branch's `[merge] always_review` or the user's list name, renames as both paths.
   * Undefined when git can't say, as when the head commit isn't in the project's repo.
   */
  private async diffOf(project: Project, base: string, head: string, rules: AutoMerge): Promise<AutoMergeFacts['diff']> {
    const shown = await exec('git', ['-C', project.path, 'show', `${base}:.kernel/settings.toml`])
    const shared = sharedMergeOf(shown.code === 0 ? shown.stdout : undefined)
    this.warnIgnored(project, shared.ignored)
    const r = await exec('git', ['-C', project.path, 'diff', '--numstat', '--no-renames', '-z', `${base}...${head}`])
    if (r.code !== 0) return undefined
    let lines = 0
    const files: string[] = []
    // `<added>\t<removed>\t<path>`, NUL-separated. A binary file has `-` for both.
    for (const rec of r.stdout.split('\0').filter(Boolean)) {
      const [added, removed, ...path] = rec.split('\t')
      lines += (Number(added) || 0) + (Number(removed) || 0)
      files.push(path.join('\t'))
    }
    const always = [...ALWAYS_REVIEW, ...shared.alwaysReview, ...rules.alwaysReview].map((p) => p.toLowerCase())
    return { lines, touched: files.filter((f) => inPaths(f.toLowerCase(), always)) }
  }

  /** Warns in the project, once, that its shared settings file sets `[merge]` keys only a person's own file may set (KERNEL-556). */
  private warnIgnored(project: Project, ignored: string[]) {
    const key = `${project.id}:${ignored.join(',')}`
    if (!ignored.length || this.warnedMerge.has(key)) return
    this.warnedMerge.add(key)
    const keys = ignored.map((k) => `[merge] ${k}`).join(' and ')
    bus.activity({ kind: 'note', projectId: project.id, actor: 'kernel', text: `ignores ${keys} in .kernel/settings.toml:`, object: 'auto-merge is a personal setting, set in .kernel/settings.local.toml', warn: true })
  }

  private readyPr(id: string) {
    return this.running(id, 'ready', async () => { const ws = await this.syncBranch(id); await this.host(ws.projectId).ready(ws.path, ws.branch); return this.k.refreshPr(id) })
  }
  private reopenPr(id: string) {
    return this.running(id, 'reopen', async () => { const ws = await this.syncBranch(id); await this.host(ws.projectId).reopen(ws.path, ws.branch); return this.k.refreshPr(id) })
  }

  /**
   * Follows the branch a worktree workspace is really on. An agent may switch or create branches in its worktree, for
   * example to a name the repo's own rules ask for, and PRs, merge, push, archive and restore must use the branch the work is on
   * (KERNEL-68). A PR belongs to its branch, so a switch drops the old branch's PR; the next refresh finds the new one.
   * A detached HEAD, or a folder git can't read, changes nothing.
   */
  async syncBranch(id: string): Promise<Workspace> {
    const ws = this.mustWs(id)
    // A Lead chat whose worktree isn't made yet is on the branch it picked (KERNEL-542).
    if (ws.mode !== 'worktree' || ws.status === 'archived' || ws.worktreePending) return ws
    const now = await currentBranch(ws.path).catch(() => null)
    if (!now || now === 'HEAD' || now === ws.branch) return this.mustWs(id)
    const next = this.updateWs(id, { branch: now, prState: ws.prState === 'creating' ? 'creating' : 'none', prNumber: undefined, prUrl: undefined, prTitle: undefined })
    if (next.branch !== now) return next
    bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: id, agentId: ws.agentId, text: `moved ${ws.name} to the branch`, object: now })
    if (next.prState !== ws.prState) bus.push({ type: 'pr', workspaceId: id, state: next.prState })
    return next
  }

  /** Workspaces a Continue is under way in. Archive on merge leaves them alone, since they are about to stop being merged work. */
  private continues = new Set<string>()
  continuing(id: string) { return this.continues.has(id) }

  /**
   * After a merge or close: a fresh branch from the base in the same worktree. The chat stays. Continue and an archive
   * exclude each other: one on a workspace that is archived, or whose archive has started, changes nothing, and Archive on
   * merge doesn't start once Continue has (`continuing`).
   */
  async continuePr(id: string) {
    const ws = this.mustWs(id)
    if (ws.prState !== 'merged' && ws.prState !== 'closed') throw new Error('Continue is for a merged or closed pull request.')
    if (ws.mode !== 'worktree') throw new Error('Continue needs a worktree workspace. Start a new workspace to keep going.')
    this.notArchived(id)
    if (this.continues.has(id)) throw new Error('Continue is already running in this workspace.')
    this.continues.add(id)
    try {
      const project = this.mustProject(ws.projectId)
      const remote = await this.k.config.remoteFor(project.path)
      if (ws.baseRef.startsWith(`${remote}/`)) await fetchOrigin(project.path, remote, { fresh: true })
      // feat/x-2 continues as feat/x-3, not feat/x-2-2.
      const stem = ws.branch.replace(/-\d+$/, '')
      const branch = await this.k.workspaces.withBranchLock(project.id, async () => {
        // An archive the user started meanwhile.
        this.notArchived(id)
        const free = await freeBranch(project.path, stem !== ws.branch && await branchExists(project.path, stem) ? stem : ws.branch, remote)
        await git(ws.path, 'checkout', '-b', free, ws.baseRef)
        return free
      })
      const next = this.updateWs(id, { branch, prState: 'none', prNumber: undefined, prUrl: undefined, prTitle: undefined, mergeCommit: undefined })
      // No longer merged work, so Archive on merge no longer applies.
      this.k.autoArchive.unmarkReviews(id)
      bus.push({ type: 'pr', workspaceId: id, state: 'none' })
      this.note(id, `Continuing on ${branch} from ${stripRemote(ws.baseRef, remote)}. The chat stays.`)
      return next
    } finally {
      this.continues.delete(id)
    }
  }

  private notArchived(id: string) {
    if (this.mustWs(id).status === 'archived') throw new Error('This workspace was archived, so Continue changed nothing. Restore it to keep going.')
    if (this.k.archive.archivingNow(id)) throw new Error('This workspace is being archived, so Continue changed nothing. Restore it once the archive finishes to keep going.')
  }

  /** Whether the workspace's PR chat is in a turn or has messages waiting for one (a create-pr.md sent mid-turn waits in the queue). */
  private agentBusy(ws: Workspace) {
    const chat = this.prChat(ws.id)
    return chat ? this.sessions.isRunning(chat.id) || this.sessions.queued(chat.id).length > 0 : false
  }

  /** How often a PR read on its own is read. Each open PR is read on it unless its own wait below says not yet. */
  pollMs = 45_000
  /** The longest a PR whose reads keep failing waits between reads. Each failure in a row doubles the wait up to this. */
  maxBackoffMs = 10 * 60_000
  /** A ready or draft PR whose read hasn't changed in this long is only waiting on someone, and is read every `quietMs`. */
  quietAfterMs = 24 * 60 * 60_000
  quietMs = 5 * 60_000

  /**
   * Each open PR's place in the poll (KERNEL-216): when it is next due, the reads that failed in a row, and its last read
   * and when that last changed. Kept in memory, so a restart reads every PR at the full rate again.
   */
  private polls = new Map<string, { due: number; failures: number; seen?: string; changedAt: number }>()
  private polling?: Promise<void>
  /** Each PR's last full read as `fingerprintOf` puts it, which the batch read is compared with (KERNEL-388). */
  private prints = new Map<string, string>()

  /** A read of the PR: gh answered, or it didn't for a workspace that has a PR, which is gh failing or GitHub out of reach. */
  private noteRead(id: string, ws: Workspace, info: PrInfo | null) {
    const now = Date.now()
    const p = this.polls.get(id) ?? { due: 0, failures: 0, changedAt: now }
    if (!info && ws.prNumber) { this.polls.set(id, { ...p, failures: p.failures + 1 }); return }
    const seen = JSON.stringify(info)
    this.polls.set(id, { due: p.due, failures: 0, seen, changedAt: seen === p.seen ? p.changedAt : now })
  }

  private offline() { return this.k.account.network?.online === false }

  /** How long until the poll reads this PR again. */
  private waitFor(ws: Workspace, p: { failures: number; changedAt: number }) {
    if (p.failures) return Math.min(this.pollMs * 2 ** p.failures, this.maxBackoffMs)
    const quiet = (ws.prState === 'ready' || ws.prState === 'draft') && Date.now() - p.changedAt >= this.quietAfterMs
    return quiet ? this.quietMs : this.pollMs
  }

  /**
   * Reads the open PRs. One poll at a time: a poll still waiting on gh is the one that runs, since another would only start
   * more gh processes behind it. Nothing is read while the Mac is offline (KERNEL-216) or a rate limit holds the poll off
   * (KERNEL-388). `chores` also flushes held Lead updates and retries waits, as every call but the timer's own does.
   */
  pollPrs(o: { chores?: boolean } = {}): Promise<void> {
    return (this.polling ??= this.pollOnce(o).finally(() => { this.polling = undefined }))
  }

  private async pollOnce(o: { chores?: boolean }) {
    const start = Date.now()
    // A pause that ran out ends here, on the poll its timer brought (KERNEL-401).
    this.syncGitHub()
    if (!this.offline() && !this.cadence.paused()) {
      const open: Workspace[] = []
      for (const ws of this.store.workspaces()) {
        if (ws.status === 'archived' || ['none', 'merged', 'closed'].includes(ws.prState)) { this.polls.delete(ws.id); continue }
        open.push(ws)
      }
      await this.readBatched(open, start)
    }
    if (o.chores ?? true) {
      // Updates held for a busy or paused Lead go out once it can take them.
      this.leadUpdates.flushAll()
      // A rebase message that couldn't go out, or a release that failed, tries again (KERNEL-259). After the flush, since a
      // release can fetch and rerun setup.
      void this.retryWaits()
      this.cadence.choresRan()
    }
    // The reads this poll made reach the window together.
    this.syncGitHub()
  }

  /** One PR's full read when it is due on its own schedule: its backoff, and the quiet rate of a PR that waits on someone (KERNEL-216). */
  private async readOne(ws: Workspace, start: number) {
    if ((this.polls.get(ws.id)?.due ?? 0) > start) return
    // The quick re-check reads it within 15 seconds, after this poll (KERNEL-283).
    if (this.rechecks.get(ws.id) === 'queued') return
    await this.k.refreshPr(ws.id).catch(() => {
      const p = this.polls.get(ws.id) ?? { due: 0, failures: 0, changedAt: Date.now() }
      this.polls.set(ws.id, { ...p, failures: p.failures + 1 })
    })
    // Counted from the poll's start, less a second for a timer that fires a little early, so a PR due every poll is
    // read every poll however long the reads before it took.
    const p = this.polls.get(ws.id)
    if (p) p.due = start + this.waitFor(this.store.workspace(ws.id) ?? ws, p) - 1000
  }

  /**
   * One read per project for every PR it has open, then the full read, with review comments and conflicting files, only for a
   * PR whose batch read differs from Kernel's last full read or moves its state (KERNEL-388). A workspace with no PR number
   * yet, or whose PR the batch didn't return, is read on its own schedule. A PR whose full reads fail keeps its backoff.
   * A project whose host can't read many PRs at once has each read on its own schedule.
   */
  private async readBatched(open: Workspace[], start: number) {
    const projects = new Map<string, Workspace[]>()
    for (const ws of open) projects.set(ws.projectId, [...(projects.get(ws.projectId) ?? []), ws])
    for (const [projectId, list] of projects) {
      const project = this.store.project(projectId)
      if (!project) continue
      const host = this.k.codeHost.hostFor(project)
      if (!host.prs) { for (const ws of list) await this.readOne(ws, start); continue }
      if (this.cadence.paused()) continue
      // A branch switched by hand drops the old branch's PR, and the workspace is read on its own below (KERNEL-68).
      const current = await Promise.all(list.map((ws) => this.syncBranch(ws.id).catch(() => ws)))
      const numbers = [...new Set(current.flatMap((ws) => (ws.prNumber ? [ws.prNumber] : [])))]
      let probe = new Map<number, PrInfo>()
      if (numbers.length) {
        try {
          const optional = await this.optionalOf(projectId)
          const read = await host.prs(project.path, numbers, optional.length ? { optional } : {})
          probe = read.infos
          if (read.rate) { this.cadence.rated(read.rate); this.syncGitHub() }
          this.cadence.ok()
          this.noteGitHub(projectId)
        } catch (e) {
          if (e instanceof GhReadError && e.rateLimited) await this.limited(e, host, project.path)
          if (e instanceof GhReadError) this.noteGitHub(projectId, e.kind)
          // The project is read again on the next poll.
          continue
        }
      }
      for (const ws of current) {
        if (ws.status === 'archived' || ['none', 'merged', 'closed'].includes(ws.prState)) continue
        const got = ws.prNumber ? probe.get(ws.prNumber) : undefined
        if (!got) { await this.readOne(ws, start); continue }
        if (!this.changed(ws, got)) continue
        const p = this.polls.get(ws.id)
        if (p?.failures && p.due > start) continue
        await this.k.refreshPr(ws.id).catch(() => {
          const q = this.polls.get(ws.id) ?? { due: 0, failures: 0, changedAt: Date.now() }
          this.polls.set(ws.id, { ...q, failures: q.failures + 1 })
        })
        const after = this.polls.get(ws.id)
        if (after) after.due = after.failures ? start + this.waitFor(this.store.workspace(ws.id) ?? ws, after) - 1000 : 0
      }
    }
  }

  /** Whether a batch read says the PR moved since Kernel last read it in full, or would move the workspace's state. */
  private changed(ws: Workspace, got: PrInfo) {
    return fingerprintOf(got) !== this.prints.get(ws.id) || this.nextState(ws, got, !this.agentBusy(ws)) !== ws.prState
  }

  private retrying?: Promise<void>

  /**
   * The poll's retry of waits, one at a time and outside `polling`. A release can rerun setup, which may take the whole
   * script timeout, and the PR reads don't wait for it (KERNEL-216).
   */
  private retryWaits(): Promise<void> {
    return (this.retrying ??= this.k.waits.retryWaits().catch(() => undefined).finally(() => { this.retrying = undefined }))
  }


  /**
   * PRs GitHub said it was still checking for conflicts, read once more on one shared timer since GitHub settles within
   * seconds, as when a merge makes it check every other PR again. `ran` is a quick read that still read unknown: the 45
   * second poll takes over until a settled read clears it, so a PR GitHub takes long over isn't read every few seconds (KERNEL-283).
   */
  private rechecks = new Map<string, 'queued' | 'ran'>()
  private recheckTimer?: NodeJS.Timeout
  recheckMs = 15_000

  private recheckSoon(id: string) {
    if (this.rechecks.has(id)) return
    this.rechecks.set(id, 'queued')
    this.recheckTimer ??= setTimeout(() => void this.recheck(), this.recheckMs)
  }

  /**
   * Waits for a poll still running, so the two never read GitHub at once, and reads nothing offline: the poll reads
   * those PRs once the Mac is back (KERNEL-216).
   */
  private async recheck() {
    this.recheckTimer = undefined
    await this.polling
    const ids = [...this.rechecks].flatMap(([id, s]) => (s === 'queued' ? [id] : []))
    for (const id of ids) this.rechecks.set(id, 'ran')
    if (this.offline()) return
    for (const id of ids) await this.k.refreshPr(id).catch(() => undefined)
  }

  /** Drops the workspace from the quick read, as when GitHub has settled on it. */
  cancelRecheck(id: string) { this.rechecks.delete(id) }

  /** Forgets everything the poll kept about the workspace's PR, as when it is archived. */
  forgetPr(id: string) {
    this.cancelRecheck(id)
    this.weighed.delete(id)
    this.retries.delete(id)
    this.updates.delete(id)
    this.polls.delete(id)
    this.prints.delete(id)
    this.infos.delete(id)
  }

  /** How often the poll runs and when it holds off for GitHub's rate limit (KERNEL-388). Tests shorten `cadence.c`. */
  cadence = new PrCadence()
  private live = false
  private timer?: NodeJS.Timeout
  private nextAt = 0
  private lastPollAt = 0
  /** When a read last moved a PR's state. The poll stays fast a little after, since one change often brings another. */
  private changedAt = 0

  /**
   * Reads the open PRs while Kernel runs: every 10 seconds while one is moving, every 30 when all wait on someone, slower
   * near the rate limit (KERNEL-388). The first poll comes 30 seconds in, and nothing goes to the Lead before 45.
   */
  start() {
    this.live = true
    this.cadence.started()
    this.syncGitHub()
    this.schedule(this.cadence.c.calmMs)
  }

  private schedule(ms: number) {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.live) return
    this.nextAt = Date.now() + ms
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private async tick() {
    this.timer = undefined
    this.lastPollAt = Date.now()
    await this.pollPrs({ chores: this.cadence.choresDue() }).catch(() => undefined)
    // A pollSoon while this poll ran keeps the timer it set.
    if (!this.timer) this.schedule(this.cadence.delay(this.moving()))
  }

  /**
   * Reads the open PRs within a second or so: the window came back, the Mac woke, or a merge moved the base. Never twice
   * within `minGapMs`, and nothing before `start()` (KERNEL-388).
   */
  pollSoon() {
    if (!this.live) return
    const at = Math.max(Date.now() + this.cadence.c.soonMs, this.lastPollAt + this.cadence.c.minGapMs)
    if (this.timer && this.nextAt <= at) return
    this.schedule(at - Date.now())
  }

  /** Whether a PR is likely to read differently soon: one changed just now, GitHub is checking one, or one is in motion. */
  private moving() {
    if (Date.now() - this.changedAt < 2 * this.cadence.c.fastMs) return true
    if ([...this.rechecks.values()].includes('queued')) return true
    return this.store.workspaces().some((ws) => ws.status !== 'archived' && MOVING.includes(ws.prState))
  }

  stop() {
    this.live = false
    clearTimeout(this.timer)
    this.timer = undefined
    this.polls.clear()
    this.prints.clear()
    this.infos.clear()
    clearTimeout(this.recheckTimer)
    this.recheckTimer = undefined
    this.rechecks.clear()
    this.weighed.clear()
    this.retries.clear()
  }
  handlers() {
    return {
      'pr.create': async ({ workspaceId, draft }) => this.createPr(workspaceId, draft),
      'pr.refresh': async ({ workspaceId }) => this.k.refreshPr(workspaceId),
      'pr.merge': async ({ workspaceId, override }) => this.mergePr(workspaceId, { override }),
      'pr.resolve': async ({ workspaceId }) => { await this.resolvePr(workspaceId); return { ok: true } },
      'pr.update': async ({ workspaceId }) => { await this.updateBranch(workspaceId); return { ok: true } },
      'pr.get': async ({ workspaceId }) => this.getPr(workspaceId),
      'github.status': async () => this.githubStatus(),
      'pr.continue': async ({ workspaceId }) => this.continuePr(workspaceId),
      'pr.ready': async ({ workspaceId }) => this.readyPr(workspaceId),
      'pr.reopen': async ({ workspaceId }) => this.reopenPr(workspaceId),
      'pr.pendingAll': async () => Object.fromEntries(this.pending)
    } satisfies Partial<Handlers>
  }
}
