import type { MergeAllResult, MergeQueue, PrInfo, PrState, Workspace } from '@shared/types'
import { bus } from '../bus'
import { type AppSettings, loadRepoSettings, prInstructions } from '../services/settings'
import { branchExists, currentBranch, fetchOrigin, folderGone, freeBranch, stripRemote } from '../services/worktrees'
import { git } from '../services/exec'
import { fingerprintOf, GhReadError, prNote, resolveFile } from '../services/github'
import { PrCadence } from '../services/prCadence'
import { mergeableState, mergeBlock, mergeNeedsPr } from '@shared/merge'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** PR states whose next read is likely to differ soon, so the poll runs at its fast rate (KERNEL-388). */
const MOVING: PrState[] = ['creating', 'checks', 'merging', 'resolving']

/** Each workspace's pull request: opening, reading, merging and following its branch (KERNEL-330). */
export class Prs extends Feature {

  /** Workspaces whose merge Kernel is running, so the poll doesn't overwrite `merging`. */
  private merging = new Set<string>()
  /** The method of a merge Kernel ran, until the PR is seen merged, so the note says how it landed. */
  private mergedWith = new Map<string, AppSettings['pr']['mergeMethod']>()

  private setPrState(ws: Workspace, prState: PrState) {
    const before = this.mustWs(ws.id).prState
    const next = this.updateWs(ws.id, { prState })
    if (next.prState !== before) bus.push({ type: 'pr', workspaceId: ws.id, state: prState })
    return next
  }

  /** The PR instructions for a workspace: its room's, else Settings > Pull requests (KERNEL-190). */
  private async prTexts(ws: Workspace) {
    return prInstructions(this.settings.pr, (await loadRepoSettings(this.mustRoom(ws.roomId).path)).pr)
  }

  /** Sends `create-pr.md` (the room's or Settings > PRs) to the agent. The header shows Creating until its turn ends. */
  async createPr(id: string, draft = false) {
    const ws = this.mustWs(id)
    if (ws.prState !== 'none') throw new Error('This workspace already has a pull request.')
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    const text = (await this.prTexts(ws)).createInstructions + (draft || this.settings.pr.draft ? '\nOpen as draft' : '')
    await this.sessions.send(chat.id, [{ type: 'file', name: 'create-pr.md', text }])
    return this.setPrState(ws, 'creating')
  }

  /** The checks a room never counts, from its `[pr] optional_checks` (KERNEL-388). */
  private async optionalOf(roomId: string): Promise<string[]> {
    const room = this.store.room(roomId)
    return room ? (await loadRepoSettings(room.path).catch(() => undefined))?.pr?.optionalChecks ?? [] : []
  }

  /**
   * The full read of the workspace's PR, with the room's optional checks. Null when there is no PR; rejects with GhReadError
   * when GitHub couldn't be read, after telling the poll to hold off when it was the rate limit (KERNEL-388).
   */
  private async read(ws: Workspace, cwd: string, ref: string, o: { conflicts?: boolean; remote?: string } = {}): Promise<PrInfo | null> {
    try {
      const optional = await this.optionalOf(ws.roomId)
      return await this.k.github.info(cwd, ref, ws.id, { ...o, ...(optional.length ? { optional } : {}) })
    } catch (e) {
      if (e instanceof GhReadError && e.rateLimited) await this.limited(e, cwd)
      throw e
    }
  }

  /** A read GitHub refused for its rate limit. The primary limit's reset comes from `gh api rate_limit`, which costs nothing. */
  private async limited(e: GhReadError, cwd: string) {
    const resetAt = e.secondary ? undefined : (await this.k.github.rateLimit?.(cwd).catch(() => undefined))?.resetAt
    this.cadence.limited({ secondary: e.secondary, resetAt })
    this.syncGitHub()
  }

  /** The GitHub pause as last pushed, so the window hears each start, move and end once (KERNEL-401). */
  private pushedGitHub = '{}'

  /**
   * Pushes the GitHub pause to the window when it starts, moves or ends, for the footer (KERNEL-401). The poll's own timer
   * runs at the pause's end, so main says when it is over and the window never times it out itself.
   */
  private syncGitHub() {
    const status = this.cadence.status()
    const key = JSON.stringify(status)
    if (key === this.pushedGitHub) return
    this.pushedGitHub = key
    bus.push({ type: 'github', status })
  }

  /** One button, three situations: conflicts, failing checks, or review comments. Each sends its own instructions, with what GitHub reports. */
  async resolvePr(id: string) {
    const ws = await this.syncBranch(id)
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    if (ws.prState !== 'conflict' && ws.prState !== 'cifail' && ws.prState !== 'changes') throw new Error('This pull request has nothing to fix.')
    // A read that failed still sends the instructions, without what GitHub reports.
    const info = await this.read(ws, ws.path, ws.branch, { remote: await this.k.config.remoteOfWs(ws) }).catch((e) => { if (e instanceof GhReadError) return null; throw e })
    if (info) bus.push({ type: 'pr.info', info })
    const [name, text] = resolveFile(ws.prState, await this.prTexts(ws), info)
    this.k.lead.userSpoke(chat.id)
    await this.sessions.send(chat.id, [{ type: 'file', name, text }])
    this.setPrState(ws, 'resolving')
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
    if (!ws.prNumber) return null
    // An archived workspace, opened from History, keeps its state and only shows what GitHub says now.
    if (ws.status === 'archived') {
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
   * A worktree folder deleted outside Kernel can't run gh, so the room asks for the PR by number instead (KERNEL-109).
   */
  async refreshPr(id: string, o: { settle?: boolean } = {}): Promise<Workspace> {
    const asked = await this.syncBranch(id)
    if (asked.status === 'archived') return asked
    const remote = await this.k.config.remoteOfWs(asked)
    let read: PrInfo | null
    try {
      read = await folderGone(asked.path)
        ? await this.read(asked, this.mustRoom(asked.roomId).path, asked.prNumber ? String(asked.prNumber) : asked.branch, { conflicts: false })
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
    this.noteRead(id, ws, info)
    if (info) { this.prints.set(id, fingerprintOf(info)); this.infos.set(id, { info, at: Date.now() }); this.cadence.ok() }
    const settle = o.settle ?? !this.agentBusy(ws)
    const hold = this.held(ws, settle)
    const state = this.nextState(ws, info, settle)
    const adopt = info && state !== 'none'
    const patch: Partial<Workspace> = {
      prState: state,
      ...(adopt ? { prNumber: info.number, prUrl: info.url, prTitle: info.title || ws.prTitle, ...(info.head ? { prHead: info.head } : {}) } : {}),
      // GitHub's word on merging a ready PR goes with the state, and a held state keeps the last one (KERNEL-388).
      ...(info && !hold ? { prBlocked: state === 'ready' ? info.blocked : undefined } : {}),
      ...(state === 'merged' && !ws.mergedAt ? { mergedAt: Date.now() } : {})
    }
    // A read that changes nothing isn't saved or pushed, so each poll doesn't redraw the window and refresh every task (KERNEL-216).
    const same = (Object.keys(patch) as (keyof Workspace)[]).every((key) => patch[key] === ws[key])
    const next = same ? ws : this.updateWs(id, patch)
    if (info?.conflictsUnknown) this.recheckSoon(id)
    else if (info) this.cancelRecheck(id)
    this.guardOnReady(id, ws.prState, next.prState, info, ws.prBlocked === 'behind')
    if (next.prState !== ws.prState) {
      this.changedAt = Date.now()
      bus.push({ type: 'pr', workspaceId: id, state: next.prState })
      bus.activity({ kind: 'pr.changed', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: `PR is ${next.prState}`, object: next.prNumber ? `#${next.prNumber}` : undefined })
      const text = prNote(next, info, this.mergedWith.get(id), remote)
      if (text) this.note(id, text, next.prState === 'merged' || next.prState === 'closed' || next.prState === 'cifail' ? next.prState : undefined)
      if (next.prState === 'merged') {
        this.mergedWith.delete(id)
        void this.overlaps.check(ws.roomId).catch(() => undefined)
        // Main moved. A teammate with no PR yet hears it if that would conflict with its work (KERNEL-180).
        void this.k.baseWatch.check(ws.roomId, { fetch: true }).catch(() => undefined)
      }
    }
    // A ready PR GitHub started or stopped blocking, its state the same, so nothing above told anyone (KERNEL-401). A PR that
    // becomes ready already blocked goes out with its 'pr' push, which the Lead and the Inbox read prBlocked on.
    if (ws.prState === 'ready' && next.prState === 'ready' && ws.prBlocked !== next.prBlocked) {
      bus.push({ type: 'pr.blocked', workspaceId: id, ...(next.prBlocked ? { blocked: next.prBlocked } : {}) })
    }
    return next
  }

  /** Creating and Resolving hold while the agent works, and `merging` while Kernel's merge runs. */
  private held(ws: Workspace, settle: boolean) {
    return this.merging.has(ws.id) || (!settle && (ws.prState === 'creating' || ws.prState === 'resolving'))
  }

  /** The state a read moves the workspace to, after the holds. `info` null means GitHub found no PR. */
  private nextState(ws: Workspace, info: PrInfo | null, settle: boolean): PrState {
    if (this.held(ws, settle)) return ws.prState
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
   * Merges with the method from Settings > PRs once `mergeBlock` finds nothing in the way: green checks and a reviewer's
   * approval of the latest commit, as far as Settings > Pull requests asks for them (KERNEL-115).
   */
  async mergePr(id: string) {
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
    // for its answer instead of refusing, so a second Merge, or Merge all's next PR, goes through (KERNEL-411).
    for (let waited = 0; info?.conflictsUnknown && waited < Prs.conflictWait.cap; waited += Prs.conflictWait.every) {
      await new Promise((resolve) => setTimeout(resolve, Prs.conflictWait.every))
      ws = this.mustWs(id)
      info = await fresh()
    }
    if (info?.conflictsUnknown) throw new Error(`GitHub is still checking ${ws.prNumber ? `#${ws.prNumber}` : 'this pull request'} for conflicts. Try again in a moment.`)
    if (info) bus.push({ type: 'pr.info', info })
    const name = (agentId: string) => this.agentsSync(ws.roomId).find((a) => a.id === agentId)?.name ?? agentId
    const block = mergeBlock(ws, info, rules, name)
    if (block) throw new Error(block)
    const method = this.settings.pr.mergeMethod
    this.merging.add(id)
    this.setPrState(ws, 'merging')
    try {
      await this.k.github.merge(ws.path, ws.branch, method)
      this.mergedWith.set(id, method)
    } catch (e) {
      this.merging.delete(id)
      await this.k.refreshPr(id, { settle: true }).catch(() => undefined)
      throw e
    }
    this.merging.delete(id)
    // GitHub works out again whether every other PR into the base conflicts, so the poll follows them closely (KERNEL-388).
    this.pollSoon()
    return this.k.refreshPr(id, { settle: true })
  }

  /** How often and how long a merge re-reads a PR GitHub is still checking for conflicts, in ms. Tests shorten it. */
  static conflictWait = { every: 2000, cap: 30_000 }

  /** The Merge all run going in each room, by room id (KERNEL-411). */
  private queues = new Map<string, MergeQueue>()

  /**
   * Merges the room's PRs one at a time, in the order given, each through `mergePr` with its fresh read and rules, since every
   * merge moves the base the next one goes into. Stops at the first PR that can't merge and says why: nothing merges that the
   * user didn't see first. Each step goes out as `pr.queue`, so the PRs tab shows which PR merges and which come next.
   */
  async mergeAll(roomId: string, ids: string[]): Promise<MergeAllResult> {
    if (this.queues.has(roomId)) throw new Error('Merge all is already running in this room.')
    const merged: number[] = []
    const step = (current: string) => {
      const queue: MergeQueue = { ids, current }
      this.queues.set(roomId, queue)
      bus.push({ type: 'pr.queue', roomId, queue })
    }
    try {
      for (const id of ids) {
        step(id)
        const ws = this.store.workspace(id)
        try {
          if (!ws || ws.roomId !== roomId) throw new Error('It is not an open workspace in this room.')
          const after = await this.mergePr(id)
          if (after.prNumber) merged.push(after.prNumber)
        } catch (e) {
          // mergeBlock's reason is a finished sentence; a failed merge's is gh output, of which the first line is enough.
          const why = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0].trim().slice(0, 240)
          return { merged, stopped: { workspaceId: id, ...(ws?.prNumber ? { prNumber: ws.prNumber } : {}), reason: /[.!?…]$/.test(why) ? why : `${why}.` } }
        }
      }
      return { merged }
    } finally {
      this.queues.delete(roomId)
      bus.push({ type: 'pr.queue', roomId })
    }
  }

  private async readyPr(id: string) { const ws = await this.syncBranch(id); await this.k.github.ready(ws.path, ws.branch); return this.k.refreshPr(id) }
  private async reopenPr(id: string) { const ws = await this.syncBranch(id); await this.k.github.reopen(ws.path, ws.branch); return this.k.refreshPr(id) }

  /**
   * Follows the branch a worktree workspace is really on. An agent may switch or create branches in its worktree, for
   * example to a name the repo's own rules ask for, and PRs, merge, push, archive and restore must use the branch the work is on
   * (KERNEL-68). A PR belongs to its branch, so a switch drops the old branch's PR; the next refresh finds the new one.
   * A detached HEAD, or a folder git can't read, changes nothing.
   */
  async syncBranch(id: string): Promise<Workspace> {
    const ws = this.mustWs(id)
    if (ws.mode !== 'worktree' || ws.status === 'archived') return ws
    const now = await currentBranch(ws.path).catch(() => null)
    if (!now || now === 'HEAD' || now === ws.branch) return this.mustWs(id)
    const next = this.updateWs(id, { branch: now, prState: ws.prState === 'creating' ? 'creating' : 'none', prNumber: undefined, prUrl: undefined, prTitle: undefined })
    if (next.branch !== now) return next
    bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: `moved ${ws.name} to the branch`, object: now })
    if (next.prState !== ws.prState) bus.push({ type: 'pr', workspaceId: id, state: next.prState })
    return next
  }

  /** After a merge or close: a fresh branch from the base in the same worktree. The chat stays. */
  async continuePr(id: string) {
    const ws = this.mustWs(id)
    if (ws.prState !== 'merged' && ws.prState !== 'closed') throw new Error('Continue is for a merged or closed pull request.')
    if (ws.mode !== 'worktree') throw new Error('Continue needs a worktree workspace. Start a new workspace to keep going.')
    const room = this.mustRoom(ws.roomId)
    const remote = await this.k.config.remoteFor(room.path)
    if (ws.baseRef.startsWith(`${remote}/`)) await fetchOrigin(room.path, remote, { fresh: true })
    // feat/x-2 continues as feat/x-3, not feat/x-2-2.
    const stem = ws.branch.replace(/-\d+$/, '')
    const branch = await this.k.workspaces.withBranchLock(room.id, async () => {
      const free = await freeBranch(room.path, stem !== ws.branch && await branchExists(room.path, stem) ? stem : ws.branch)
      await git(ws.path, 'checkout', '-b', free, ws.baseRef)
      return free
    })
    const next = this.updateWs(id, { branch, prState: 'none', prNumber: undefined, prUrl: undefined, prTitle: undefined })
    bus.push({ type: 'pr', workspaceId: id, state: 'none' })
    this.note(id, `Continuing on ${branch} from ${stripRemote(ws.baseRef, remote)}. The chat stays.`)
    return next
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
      if (this.k.github.prs) await this.readBatched(open, start)
      else for (const ws of open) await this.readOne(ws, start)
    }
    if (o.chores ?? true) {
      // Updates held for a busy or paused Lead go out once it can take them.
      this.leadUpdates.flushAll()
      // A rebase message that couldn't go out, or a release that failed, tries again (KERNEL-259). After the flush, since a
      // release can fetch and rerun setup.
      void this.retryWaits()
      this.cadence.choresRan()
    }
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
   * One read per room for every PR it has open, then the full read, with review comments and conflicting files, only for a
   * PR whose batch read differs from Kernel's last full read or moves its state (KERNEL-388). A workspace with no PR number
   * yet, or whose PR the batch didn't return, is read on its own schedule. A PR whose full reads fail keeps its backoff.
   */
  private async readBatched(open: Workspace[], start: number) {
    const rooms = new Map<string, Workspace[]>()
    for (const ws of open) rooms.set(ws.roomId, [...(rooms.get(ws.roomId) ?? []), ws])
    for (const [roomId, list] of rooms) {
      const room = this.store.room(roomId)
      if (!room || this.cadence.paused()) continue
      // A branch switched by hand drops the old branch's PR, and the workspace is read on its own below (KERNEL-68).
      const current = await Promise.all(list.map((ws) => this.syncBranch(ws.id).catch(() => ws)))
      const numbers = [...new Set(current.flatMap((ws) => (ws.prNumber ? [ws.prNumber] : [])))]
      let probe = new Map<number, PrInfo>()
      if (numbers.length) {
        try {
          const optional = await this.optionalOf(roomId)
          const read = await this.k.github.prs!(room.path, numbers, optional.length ? { optional } : {})
          probe = read.infos
          if (read.rate) { this.cadence.rated(read.rate); this.syncGitHub() }
          this.cadence.ok()
        } catch (e) {
          if (e instanceof GhReadError && e.rateLimited) await this.limited(e, room.path)
          // The room is read again on the next poll.
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
  }
  handlers() {
    return {
      'pr.create': async ({ workspaceId, draft }) => this.createPr(workspaceId, draft),
      'pr.refresh': async ({ workspaceId }) => this.k.refreshPr(workspaceId),
      'pr.merge': async ({ workspaceId }) => this.mergePr(workspaceId),
      'pr.mergeAll': async ({ roomId, workspaceIds }) => this.mergeAll(roomId, workspaceIds),
      'pr.resolve': async ({ workspaceId }) => { await this.resolvePr(workspaceId); return { ok: true } },
      'pr.get': async ({ workspaceId }) => this.getPr(workspaceId),
      'github.status': async () => this.cadence.status(),
      'pr.continue': async ({ workspaceId }) => this.continuePr(workspaceId),
      'pr.ready': async ({ workspaceId }) => this.readyPr(workspaceId),
      'pr.reopen': async ({ workspaceId }) => this.reopenPr(workspaceId)
    } satisfies Partial<Handlers>
  }
}
