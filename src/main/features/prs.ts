import type { PrInfo, PrState, Workspace } from '@shared/types'
import { bus } from '../bus'
import { type AppSettings, loadRepoSettings, prInstructions } from '../services/settings'
import { branchExists, currentBranch, fetchOrigin, folderGone, freeBranch, stripRemote } from '../services/worktrees'
import { git } from '../services/exec'
import { prNote, resolveFile } from '../services/github'
import { mergeableState, mergeBlock, mergeNeedsPr } from '@shared/merge'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** Each workspace's pull request: opening, reading, merging and following its branch (KERNEL-330). */
export class Prs extends Feature {
  private prTimer?: NodeJS.Timeout

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

  /** One button, three situations: conflicts, failing checks, or review comments. Each sends its own instructions, with what GitHub reports. */
  async resolvePr(id: string) {
    const ws = await this.syncBranch(id)
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    if (ws.prState !== 'conflict' && ws.prState !== 'cifail' && ws.prState !== 'changes') throw new Error('This pull request has nothing to fix.')
    const info = await this.k.github.info(ws.path, ws.branch, id, { remote: await this.k.config.remoteOfWs(ws) })
    if (info) bus.push({ type: 'pr.info', info })
    const [name, text] = resolveFile(ws.prState, await this.prTexts(ws), info)
    this.k.lead.userSpoke(chat.id)
    await this.sessions.send(chat.id, [{ type: 'file', name, text }])
    this.setPrState(ws, 'resolving')
  }

  /** The PR's checks, review comments and conflicts, for the Checks tab and the review card. */
  private async getPr(id: string) {
    const ws = await this.syncBranch(id)
    if (!ws.prNumber) return null
    const info = await this.k.github.info(ws.path, ws.branch, id, { remote: await this.k.config.remoteOfWs(ws) })
    if (info) bus.push({ type: 'pr.info', info })
    return info
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
    const info = await folderGone(asked.path)
      ? await this.k.github.info(this.mustRoom(asked.roomId).path, asked.prNumber ? String(asked.prNumber) : asked.branch, id, { conflicts: false })
      : await this.k.github.info(asked.path, asked.branch, id, { remote })
    if (info) bus.push({ type: 'pr.info', info })
    // gh takes seconds. Decide on the workspace as it is now: it may have been archived, or a merge may have started.
    const ws = this.mustWs(id)
    if (ws.status === 'archived') return ws
    this.noteRead(id, ws, info)
    const settle = o.settle ?? !this.agentBusy(ws)
    const hold = this.merging.has(id) || (!settle && (ws.prState === 'creating' || ws.prState === 'resolving'))
    let state: PrState
    if (hold) state = ws.prState
    else if (!info) state = ws.prState === 'creating' || !ws.prNumber ? 'none' : ws.prState === 'resolving' ? 'open' : ws.prState
    else if (!ws.prNumber && (info.state === 'merged' || info.state === 'closed')) state = 'none'
    // A conflict holds until GitHub has checked the PR again. The rest of the read is real (KERNEL-283).
    else if (info.conflictsUnknown && ws.prState === 'conflict') state = 'conflict'
    else state = info.state
    const adopt = info && state !== 'none'
    const patch: Partial<Workspace> = {
      prState: state,
      ...(adopt ? { prNumber: info.number, prUrl: info.url, prTitle: info.title || ws.prTitle, ...(info.head ? { prHead: info.head } : {}) } : {}),
      ...(state === 'merged' && !ws.mergedAt ? { mergedAt: Date.now() } : {})
    }
    // A read that changes nothing isn't saved or pushed, so each poll doesn't redraw the window and refresh every task (KERNEL-216).
    const same = (Object.keys(patch) as (keyof Workspace)[]).every((key) => patch[key] === ws[key])
    const next = same ? ws : this.updateWs(id, patch)
    if (info?.conflictsUnknown) this.recheckSoon(id)
    else if (info) this.cancelRecheck(id)
    this.guardOnReady(id, ws.prState, next.prState, info)
    if (next.prState !== ws.prState) {
      bus.push({ type: 'pr', workspaceId: id, state: next.prState })
      bus.activity({ kind: 'pr.changed', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: `PR is ${next.prState}`, object: next.prNumber ? `#${next.prNumber}` : undefined })
      const text = prNote(next, info, this.mergedWith.get(id), remote)
      if (text) this.note(id, text, next.prState === 'merged' || next.prState === 'closed' || next.prState === 'cifail' ? next.prState : undefined)
      if (next.prState === 'merged') { this.mergedWith.delete(id); void this.overlaps.check(ws.roomId).catch(() => undefined) }
    }
    return next
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
   * checks, ready counts once they ran, even if the state read ready all along.
   */
  private guardOnReady(id: string, before: PrState, after: PrState, info: PrInfo | null | undefined) {
    if (info?.checks.length) this.hasChecks.add(id)
    if (after !== 'ready') { this.readyUnchecked.delete(id); if (after !== 'checks') this.guardReadyOn.delete(id); return }
    if (!info?.checks.length && this.hasChecks.has(id)) { this.readyUnchecked.add(id); return }
    // Ready again on the commit the guard started over on, after only checks, isn't the work moving on. GitHub checks a
    // PR for conflicts again each time its base moves, and it reads as checks until then (KERNEL-283).
    const again = before === 'checks' && !!info?.head && this.guardReadyOn.get(id) === info.head
    if ((before !== 'ready' && !again) || this.readyUnchecked.delete(id)) {
      this.nudges.reset(id, ...this.k.autoArchive.reviewsOf(id))
      if (info?.head) this.guardReadyOn.set(id, info.head)
    }
  }

  /**
   * Merges with the method from Settings > PRs once `mergeBlock` finds nothing in the way: green checks and a reviewer's
   * approval of the latest commit, as far as Settings > Pull requests asks for them (KERNEL-115).
   */
  async mergePr(id: string) {
    const ws = await this.syncBranch(id)
    const rules = this.settings.pr
    // GitHub is read only when the rule needs it, and never for a PR that isn't ready, which mergeBlock refuses anyway.
    const info = mergeableState(ws.prState) && mergeNeedsPr(ws, rules)
      ? await this.k.github.info(ws.path, ws.branch, id, { remote: await this.k.config.remoteOfWs(ws) })
      : undefined
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
    return this.k.refreshPr(id, { settle: true })
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
    const branch = await freeBranch(room.path, stem !== ws.branch && await branchExists(room.path, stem) ? stem : ws.branch)
    await git(ws.path, 'checkout', '-b', branch, ws.baseRef)
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

  /** How often the poll runs. Each open PR is read on it unless its own wait below says not yet. */
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
   * Reads the open PRs that are due. One poll at a time: a poll still waiting on gh is the one that runs, since another
   * would only start more gh processes behind it. Nothing is read while the Mac is offline (KERNEL-216).
   */
  pollPrs(): Promise<void> {
    return (this.polling ??= this.pollOnce().finally(() => { this.polling = undefined }))
  }

  private async pollOnce() {
    const start = Date.now()
    if (!this.offline()) {
      for (const ws of this.store.workspaces()) {
        if (ws.status === 'archived' || ['none', 'merged', 'closed'].includes(ws.prState)) { this.polls.delete(ws.id); continue }
        if ((this.polls.get(ws.id)?.due ?? 0) > start) continue
        // The quick re-check reads it within 15 seconds, after this poll (KERNEL-283).
        if (this.rechecks.get(ws.id) === 'queued') continue
        await this.k.refreshPr(ws.id).catch(() => {
          const p = this.polls.get(ws.id) ?? { due: 0, failures: 0, changedAt: Date.now() }
          this.polls.set(ws.id, { ...p, failures: p.failures + 1 })
        })
        // Counted from the poll's start, less a second for a timer that fires a little early, so a PR due every poll is
        // read every poll however long the reads before it took.
        const p = this.polls.get(ws.id)
        if (p) p.due = start + this.waitFor(this.store.workspace(ws.id) ?? ws, p) - 1000
      }
    }
    // Updates held for a busy or paused Lead go out once it can take them.
    this.leadUpdates.flushAll()
    // A rebase message that couldn't go out, or a release that failed, tries again (KERNEL-259). After the flush, since a
    // release can fetch and rerun setup.
    void this.retryWaits()
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

  /** Drops the workspace from the quick read, as when it is archived. */
  cancelRecheck(id: string) { this.rechecks.delete(id) }

  /** Reads the open PRs from GitHub every 45 seconds while Kernel runs, each as often as `waitFor` says. */
  start() { this.prTimer = setInterval(() => void this.pollPrs(), this.pollMs) }
  stop() {
    clearInterval(this.prTimer)
    this.polls.clear()
    clearTimeout(this.recheckTimer)
    this.recheckTimer = undefined
    this.rechecks.clear()
  }
  handlers() {
    return {
      'pr.create': async ({ workspaceId, draft }) => this.createPr(workspaceId, draft),
      'pr.refresh': async ({ workspaceId }) => this.k.refreshPr(workspaceId),
      'pr.merge': async ({ workspaceId }) => this.mergePr(workspaceId),
      'pr.resolve': async ({ workspaceId }) => { await this.resolvePr(workspaceId); return { ok: true } },
      'pr.get': async ({ workspaceId }) => this.getPr(workspaceId),
      'pr.continue': async ({ workspaceId }) => this.continuePr(workspaceId),
      'pr.ready': async ({ workspaceId }) => this.readyPr(workspaceId),
      'pr.reopen': async ({ workspaceId }) => this.reopenPr(workspaceId)
    } satisfies Partial<Handlers>
  }
}
