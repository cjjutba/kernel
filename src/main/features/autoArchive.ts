import type { Workspace } from '@shared/types'
import { bus } from '../bus'
import { archiveSkip } from '../services/archiveGuard'
import { firstLine } from '../services/text'
import { reviewedByBase } from '../services/kernelMcp'
import { loadRepoSettings } from '../services/settings'
import { exec } from '../services/exec'
import { unpushedCommits } from '../services/archive'
import { Feature } from './feature'

/** Workspaces Kernel archives on its own: reviews of finished work, and work whose PR merged (KERNEL-131, KERNEL-114, KERNEL-330). */
export class AutoArchive extends Feature {
  /**
   * Workspaces Kernel archives on its own and hasn't yet, most often because they were working: reviews whose reviewed
   * work merged or closed (KERNEL-131), and work whose PR merged (KERNEL-114). They go when their turn ends. Saved under
   * the meta key `reviewsToArchive`, so a quit doesn't keep them open, and only these are swept at start, so a workspace
   * the user restored stays restored.
   */
  readonly reviewsToArchive = new Set<string>()

  /** The open review workspaces of a workspace's work. */
  reviewsOf(id: string) { return this.store.workspaces().filter((w) => w.reviewOf === id && w.status !== 'archived').map((w) => w.id) }

  private markReview(id: string) { if (!this.reviewsToArchive.has(id)) { this.reviewsToArchive.add(id); this.saveReviewsToArchive() } }
  unmarkReviews(...ids: string[]) { if (ids.map((id) => this.reviewsToArchive.delete(id)).some(Boolean)) this.saveReviewsToArchive() }
  private saveReviewsToArchive() { this.store.saveMeta('reviewsToArchive', [...this.reviewsToArchive]) }

  /**
   * The work a review looked at merged or closed, so its review workspaces are done (KERNEL-131). They go through the same
   * checks as archive_workspace. One still working is archived when its turn ends; one that would lose uncommitted work is
   * kept, with a note in the log, and Kernel doesn't try again.
   */
  async archiveReviews(ofId: string, only?: string) {
    const of = this.store.workspace(ofId)
    const reviews = this.store.workspaces().filter((w) => w.reviewOf === ofId && w.status !== 'archived' && (!only || w.id === only))
    if (!of || (of.prState !== 'merged' && of.prState !== 'closed')) { this.unmarkReviews(...reviews.map((r) => r.id)); return }
    // Archive on merge covers review cleanup too: off, nothing archives on its own (KERNEL-114).
    if (!reviews.length) return
    if (!(await this.archiveOnMerge(of.roomId))) { this.unmarkReviews(...reviews.map((r) => r.id)); return }
    for (const r of reviews) this.markReview(r.id)
    for (const r of reviews) await this.archiveDone(r, 'kept the review workspace', 'The work it reviewed is done')
  }

  /**
   * Settings, Git's Archive on merge, with the room's own value first (KERNEL-114). It covers the work whose PR merged and
   * the reviews of work that merged or closed.
   */
  private async archiveOnMerge(roomId: string) {
    const room = this.store.room(roomId)
    const own = room ? (await loadRepoSettings(room.path).catch(() => undefined))?.workspace.archiveOnMerge : undefined
    return typeof own === 'boolean' ? own : this.settings.workspace.archiveOnMerge
  }

  /**
   * The workspace's PR merged, so with Archive on merge on it is done (KERNEL-114). It goes through the same checks as a
   * review, and is also kept when its branch has commits GitHub doesn't. Only a worktree goes: a workspace on the room's
   * own checkout, as the Lead's is, can't be checked for uncommitted changes, and that holds even before the team is read.
   * A closed PR keeps its workspace, because its author may reopen it. Reviews go through `archiveReviews`.
   */
  async archiveMerged(id: string) {
    const ws = this.store.workspace(id)
    if (ws?.mode !== 'worktree') { this.unmarkReviews(id); return }
    if (ws.status === 'archived' || ws.reviewOf) return
    const lead = !!this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.lead
    if (ws.prState !== 'merged' || lead || !(await this.archiveOnMerge(ws.roomId))) { this.unmarkReviews(id); return }
    this.markReview(id)
    await this.archiveDone(ws, 'kept the workspace', `Its PR${ws.prNumber ? ' #' + ws.prNumber : ''} merged`)
  }

  /** A marked workspace whose turn ended, or whose session died, or that a quit left marked. */
  archiveMarked(id: string) {
    const ws = this.store.workspace(id)
    if (!ws || ws.status === 'archived') { this.unmarkReviews(id); return Promise.resolve() }
    return ws.reviewOf ? this.archiveReviews(ws.reviewOf, id) : this.archiveMerged(id)
  }

  /**
   * Archives a marked workspace through the same checks as archive_workspace. One still working goes when its turn ends.
   * One that would lose work is kept, with `text` and `done` in the log, and Kernel doesn't try again.
   */
  private async archiveDone(r: Workspace, text: string, done: string) {
    // A turn running, or a message about to start one: it goes when that turn ends.
    if (this.k.archive.working(r.id)) return
    const keep = (reason: string) => {
      this.unmarkReviews(r.id)
      bus.activity({ kind: 'note', roomId: r.roomId, workspaceId: r.id, agentId: r.agentId, actor: 'kernel', text, object: r.name, warn: true, quote: `${done}, but it wasn't archived: ${/[.!?…]$/.test(reason) ? reason : reason + '.'}` })
    }
    let why = await archiveSkip(r, { isOwnLead: (w) => this.isLeadWorkspace(w), isRunning: (id) => this.k.archive.working(id), latestPr: async (w) => w, unsaved: (id) => this.k.archive.unsavedOf(id) })
    if (why === 'its agent is still working') return
    // The git check followed the branch the work is on now. Work that moved to a fresh branch isn't the merged work.
    if (!r.reviewOf && this.store.workspace(r.id)?.prState !== 'merged') { this.unmarkReviews(r.id); return }
    // Archive keeps a branch with unpushed commits, but the work would leave the sidebar unfinished (KERNEL-114).
    if (!why && !r.reviewOf) {
      const unpushed = await this.unpushedOf(this.store.workspace(r.id) ?? r)
      if (unpushed === null) why = 'its commits could not be counted'
      else if (unpushed > 0) why = `it has ${unpushed === 1 ? 'a commit' : `${unpushed} commits`} that GitHub doesn't`
    }
    if (why) { keep(why); return }
    // Checked again after the git calls: a message may have started a turn meanwhile, the user may have restored it,
    // or another archive got there first.
    if (this.k.archive.working(r.id) || !this.reviewsToArchive.has(r.id)) return
    const now = this.store.workspace(r.id)
    if (now?.status === 'archived' || (!r.reviewOf && now?.prState !== 'merged')) { this.unmarkReviews(r.id); return }
    try { await this.k.archiveWorkspace(r.id); this.unmarkReviews(r.id) } catch (e) { keep(firstLine(e instanceof Error ? e.message : String(e))) }
  }

  /**
   * Commits on the workspace's branch that GitHub doesn't have, or null when they can't be counted. As `unpushedCommits`,
   * except that what the PR's head had counts as on GitHub: a squash merge leaves the commits off the base, and GitHub may
   * have deleted the branch.
   */
  private async unpushedOf(ws: Workspace): Promise<number | null> {
    const room = this.store.room(ws.roomId)
    if (!room) return null
    const counted = await unpushedCommits(room.path, ws.branch, ws.baseRef, await this.k.config.remoteFor(room.path))
    if (counted === 0 || !ws.prHead) return counted
    const r = await exec('git', ['-C', room.path, 'rev-list', '--count', `refs/heads/${ws.branch}`, '--not', ws.prHead])
    const n = Number(r.stdout.trim())
    if (r.code !== 0 || r.stdout.trim() === '' || !Number.isInteger(n)) return counted
    return counted === null ? n : Math.min(counted, n)
  }

  /**
   * At start: the workspaces Kernel meant to archive when it quit, as one whose turn was still running, are archived now
   * (KERNEL-131, KERNEL-114). Work that merged or closed while Kernel was closed reaches them through the first PR poll,
   * since its saved PR state is still open.
   */
  private async sweepReviews() {
    for (const id of [...this.reviewsToArchive]) await this.archiveMarked(id).catch(() => undefined)
    // Reviews the Lead started with base_ref instead of review_of are linked now (KERNEL-299). Those whose work already
    // merged or closed get no PR event, so they are archived here. Each is linked once, so a kept one is noted once. A quit
    // right after start closes the database under it.
    for (const r of await this.linkReviews().catch(() => [])) await this.archiveReviews(r.reviewOf!, r.id).catch(() => undefined)
  }

  /**
   * Once, at the first start with Archive on merge working (KERNEL-114): work whose PR merged before then gets no PR event,
   * so it is archived here, with the same checks. After that a merge archives as it lands, so a workspace the user restores
   * stays, and a kept one is noted once. Saved under the meta key `mergedSwept`.
   */
  async sweepMerged() {
    if (this.store.meta<boolean>('mergedSwept')) return
    for (const ws of this.store.workspaces()) {
      if (this.stopped) return
      if (ws.mode === 'worktree' && ws.status !== 'archived' && ws.prState === 'merged' && !ws.reviewOf) await this.archiveMerged(ws.id).catch(() => undefined)
    }
    if (!this.stopped) this.store.saveMeta('mergedSwept', true)
  }

  /** Links each open reviewer workspace with no `reviewOf` to the workspace whose branch its base names (KERNEL-299). */
  private async linkReviews() {
    const linked: Workspace[] = []
    for (const room of this.store.rooms()) {
      const agents = await this.k.team.agents(room.id).catch(() => [])
      const all = this.store.workspaces(room.id)
      for (const w of all) {
        if (w.status === 'archived' || w.reviewOf) continue
        const of = reviewedByBase(agents.find((a) => a.id === w.agentId), w.baseRef, all, { self: w.id, done: true })
        if (!of || of.reviewOf) continue
        linked.push(this.saveWs({ ...w, reviewOf: of.id }))
      }
    }
    return linked
  }

  /** At launch: the workspaces a quit left marked are archived now, or kept with a note (KERNEL-131, KERNEL-114). */
  start() {
    for (const id of this.store.meta<string[]>('reviewsToArchive') ?? []) this.reviewsToArchive.add(id)
    void this.sweepReviews()
  }
}
