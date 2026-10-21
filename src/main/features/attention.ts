import type { Approval, AttentionKind, PlanAttention } from '@shared/types'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

const mergeKey = (workspaceId: string) => `attention.merge.${workspaceId}`

const kindOf = (a: Approval): AttentionKind | undefined => {
  if (a.kind === 'plan' || a.toolName === 'ExitPlanMode') return 'plan'
  if (a.kind === 'question') return 'question'
  if (a.kind === 'tool') return 'tool'
  return undefined
}

/**
 * What a plan needed from the user: the approvals they decided in its step workspaces and in the review workspaces of their
 * PRs, and the Lead's questions that name one of those workspaces, and the merges they started (KERNEL-1067). `blocker` stays in `byKind` at 0, since a failed check, a change request
 * or a ready row the teammate settled never needed the user.
 */
export class Attention extends Feature {
  /**
   * The user started a merge of this workspace's PR, from the Merge button or by asking the Lead. Called before the merge
   * runs and kept whatever its refresh reports, since GitHub can merge while the read fails or lags. The merge counts once
   * the PR reads as merged. An auto-merge never calls this.
   */
  userMerging(workspaceId: string) {
    this.store.saveMeta(mergeKey(workspaceId), true)
  }

  plan(approvalId: string): PlanAttention {
    const plan = this.store.approval(approvalId)
    if (!plan || plan.kind !== 'plan' || !plan.steps?.length) throw new Error('This is not an approved plan.')
    const byKind: Record<AttentionKind, number> = { plan: 0, tool: 0, question: 0, blocker: 0, merge: 0 }
    let prsMerged = 0
    let finished = plan.status === 'allowed'
    const ids = new Set<string>()
    for (const step of plan.steps) {
      if (!step.workspaceId) { finished = false; continue }
      ids.add(step.workspaceId)
    }
    const reviews = this.store.workspaces().filter((w) => w.reviewOf && ids.has(w.reviewOf)).map((w) => w.id)
    for (const id of ids) {
      const ws = this.store.workspace(id)
      if (ws?.prState === 'merged') prsMerged++
      else if (ws && ws.prState !== 'closed') finished = false
      if (ws?.prState === 'merged' && this.store.meta<boolean>(mergeKey(id))) byKind.merge++
    }
    const mine = new Set([...ids, ...reviews])
    for (const id of mine) {
      for (const a of this.store.approvals({ workspaceId: id })) {
        const kind = a.status === 'pending' || a.status === 'expired' ? undefined : kindOf(a)
        if (kind) byKind[kind]++
      }
    }
    // A question the Lead asked about this plan's work sits in the Lead's workspace, and counts when it names one of these.
    if (plan.projectId) {
      for (const a of this.store.approvals({ projectId: plan.projectId })) {
        if (a.kind === 'question' && a.status === 'answered' && !mine.has(a.workspaceId ?? '') && a.about?.some((id) => mine.has(id))) byKind.question++
      }
    }
    const needed = Object.values(byKind).reduce((a, b) => a + b, 0)
    return { prsMerged, needed, byKind, finished }
  }

  handlers() {
    return {
      'attention.plan': async ({ approvalId }) => this.plan(approvalId)
    } satisfies Partial<Handlers>
  }
}
