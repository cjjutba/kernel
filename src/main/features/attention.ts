import type { Approval, AttentionKind, Notification, PlanAttention } from '@shared/types'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

type Recorded = Record<string, Extract<AttentionKind, 'blocker' | 'merge'>>

const metaKey = (workspaceId: string) => `attention.${workspaceId}`

const kindOf = (a: Approval): AttentionKind | undefined => {
  if (a.kind === 'plan' || a.toolName === 'ExitPlanMode') return 'plan'
  if (a.kind === 'question') return 'question'
  if (a.kind === 'tool') return 'tool'
  return undefined
}
export class Attention extends Feature {
  onNotification(n: Notification) {
    if (!n.workspaceId || !n.needsYou) return
    const kind = n.kind === 'check' ? 'blocker' : n.kind === 'merge' ? 'merge' : undefined
    if (!kind) return
    const key = metaKey(n.workspaceId)
    const seen = this.store.meta<Recorded>(key) ?? {}
    if (seen[n.id]) return
    this.store.saveMeta(key, { ...seen, [n.id]: kind })
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
    for (const id of ids) {
      const ws = this.store.workspace(id)
      if (ws?.prState === 'merged') prsMerged++
      else if (ws && ws.prState !== 'closed') finished = false
      for (const a of this.store.approvals({ workspaceId: id })) {
        const kind = a.status === 'expired' ? undefined : kindOf(a)
        if (kind) byKind[kind]++
      }
      const rows = Object.values(this.store.meta<Recorded>(metaKey(id)) ?? {})
      byKind.blocker += rows.filter((k) => k === 'blocker').length
      if (rows.includes('merge')) byKind.merge++
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
