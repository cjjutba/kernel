import type { ReviewVerdict, Workspace } from '@shared/types'
import { bus } from '../bus'
import type { ReviewState } from '../services/leadUpdates'
import type { ReviewInput } from '../services/reviewMcp'
import { reviewRule } from '../services/handoff'
import { remoteOf } from '../services/settings'
import { resolveBaseRef } from '../services/worktrees'
import { exec } from '../services/exec'
import { Feature } from './feature'

/** Review workspaces: where they start, the rule they get, and the verdicts they send (KERNEL-130, KERNEL-330). */
export class Reviews extends Feature {
  /** Where a review worktree starts: the reviewed workspace's branch, or its copy on the remote when the local one is gone. */
  async reviewBase(repo: string, branch: string, remote: string): Promise<string> {
    try { return await resolveBaseRef(repo, branch, { strict: true, remote }) } catch { return resolveBaseRef(repo, `${remote}/${branch}`, { fetch: true, strict: true, remote }) }
  }

  /** The rule appended to a review workspace's prompt, naming the work it reviews. */
  reviewRuleFor(ws: Workspace): string | undefined {
    const of = ws.reviewOf ? this.store.workspace(ws.reviewOf) : undefined
    if (!of) return undefined
    const author = this.agentsSync(ws.roomId).find((a) => a.id === of.agentId)?.name ?? of.agentId
    // With a PR, the review is of what the PR holds on GitHub, the commit verdicts are checked against. Before one, it is
    // of the author's local branch, or the remote's copy when the local one was gone (reviewBase).
    const room = this.store.room(ws.roomId)
    const remote = remoteOf({ workspace: { remote: room && this.k.config['roomRemotes'].get(room.path) } }, this.settings)
    const resetTo = of.prNumber ? `${remote}/${of.branch}` : ws.baseRef
    return reviewRule({ author, task: of.title ?? of.name, workspaceId: of.id, branch: of.branch, resetTo, base: of.baseRef, ...(of.prNumber ? { pr: { number: of.prNumber, url: of.prUrl } } : {}) }, remote)
  }

  /**
   * A reviewer's submit_review. The verdict is saved on the reviewed workspace with the review worktree's HEAD, so a later
   * push makes it stale, and replaces that review workspace's earlier verdict. The Lead hears about it.
   */
  async submitReview(reviewWorkspaceId: string, review: ReviewInput): Promise<string> {
    const rws = this.mustWs(reviewWorkspaceId)
    const of = rws.reviewOf ? this.store.workspace(rws.reviewOf) : undefined
    if (!of || of.status === 'archived') throw new Error('the work under review is no longer open.')
    const sha = (await exec('git', ['-C', rws.path, 'rev-parse', 'HEAD'])).stdout.trim()
    // Read again after the await, so a verdict another reviewer saved meanwhile isn't lost.
    const fresh = this.mustWs(of.id)
    const verdict: ReviewVerdict = {
      workspaceId: rws.id, agentId: rws.agentId, verdict: review.verdict, summary: review.summary.trim(),
      ...(review.verdict === 'blockers' && review.blockers?.length ? { blockers: review.blockers } : {}),
      ...(/^[0-9a-f]{40}$/.test(sha) ? { sha } : {}), ...(fresh.prNumber ? { prNumber: fresh.prNumber } : {}), ts: Date.now()
    }
    const saved = this.updateWs(of.id, { reviews: [...(fresh.reviews ?? []).filter((v) => v.workspaceId !== rws.id), verdict] })
    this.leadUpdates.reviewed(rws, saved, verdict)
    const what = saved.prNumber ? `PR #${saved.prNumber}` : saved.name
    bus.activity({ kind: 'note', roomId: rws.roomId, workspaceId: saved.id, agentId: rws.agentId, text: review.verdict === 'approved' ? 'approved' : 'found blockers in', object: what })
    return review.verdict === 'approved' ? `Saved: you approved ${what}. The Lead hears about it.` : `Saved: ${verdict.blockers?.length ?? 0} blocker(s) in ${what}. The Lead passes them on.`
  }

  /** Verdicts on the workspace's PR, and those of them on its head commit, as far as either is known. */
  private verdicts(ws: Workspace) {
    const verdicts = (ws.reviews ?? []).filter((v) => !v.prNumber || !ws.prNumber || v.prNumber === ws.prNumber)
    return { verdicts, current: verdicts.filter((v) => !v.sha || !ws.prHead || v.sha === ws.prHead) }
  }

  /**
   * The reviewer a merge waits for under "require Reviewer approval" (KERNEL-115): the one whose current verdict found
   * blockers, else whoever reviewed last when no verdict approves the head commit. Undefined when nobody reviewed the PR,
   * or a current approval stands with no current blockers.
   */
  mergeHolder(ws: Workspace): string | undefined {
    const { verdicts, current } = this.verdicts(ws)
    const latest = (vs: ReviewVerdict[]) => vs.reduce((a, b) => (b.ts > a.ts ? b : a))
    const blocking = current.filter((v) => v.verdict === 'blockers')
    const holder = blocking.length ? latest(blocking) : verdicts.length && !current.some((v) => v.verdict === 'approved') ? latest(verdicts) : undefined
    return holder && (this.agentsSync(ws.roomId).find((a) => a.id === holder.agentId)?.name ?? holder.agentId)
  }

  /** What Kernel knows about reviews of a workspace's PR, for the Lead's updates. */
  reviewState(ws: Workspace): ReviewState {
    const name = (id: string) => this.agentsSync(ws.roomId).find((a) => a.id === id)?.name ?? id
    const { verdicts, current } = this.verdicts(ws)
    const blockers = current.some((v) => v.verdict === 'blockers')
    const reviews = this.store.workspaces(ws.roomId).filter((r) => r.reviewOf === ws.id && r.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt)
    // A review runs while its setup runs, or while its reviewer works on it and hasn't sent a verdict on the head commit.
    // A review whose setup failed isn't running: it waits for the user.
    const busy = (r: Workspace) => r.status === 'setup' || (r.status === 'ready' && this.chatTabs(r.id).some((c) => this.sessions.isRunning(c.id) || this.sessions.queued(c.id).length > 0))
    const open = reviews[0]
    return {
      approvedBy: blockers ? [] : current.filter((v) => v.verdict === 'approved').map((v) => name(v.agentId)),
      blockers,
      inProgress: reviews.some((r) => busy(r) && !current.some((v) => v.workspaceId === r.id)),
      stale: verdicts.length > 0 && current.length === 0,
      ...(open ? { open: { workspaceId: open.id, agentId: open.agentId, name: name(open.agentId), ...(open.status === 'failed' ? { failed: true } : {}) } } : {})
    }
  }
}
