import type { AgentDef, Approval, Notification, Room } from '@shared/types'

export type InboxTab = 'all' | 'needs' | 'updates'

export interface InboxItem {
  n: Notification
  /** The live approval behind an approval row, so the detail pane answers the current state, not a snapshot. */
  approval?: Approval
}

const label = (a: Approval) => (a.kind === 'plan' || a.toolName === 'ExitPlanMode' ? 'Plan review' : a.kind === 'question' ? 'Question' : a.kind === 'agent' ? 'Hire' : 'Permission')

/** A row for a pending approval that main has not turned into a notification yet. Same shape main writes (services/notifications.ts). */
function fromApproval(a: Approval, rooms: Room[]): Notification {
  const room = rooms.find((r) => r.id === a.roomId)
  return {
    id: `n-approval-${a.id}`, kind: 'approval', roomId: a.roomId, workspaceId: a.workspaceId, agentId: a.agentId, approvalId: a.id,
    title: a.title, sub: `${label(a)}${room ? ` · ${room.name}` : ''}`, needsYou: true, read: false, createdAt: a.createdAt
  }
}

/** Everything the Inbox lists, newest first. Stored notifications plus pending approvals that have no row yet, so a count never lags an approval. */
export function inboxItems(notifications: Notification[], approvals: Approval[], rooms: Room[]): InboxItem[] {
  const byApproval = new Map(approvals.map((a) => [a.id, a]))
  const have = new Set(notifications.map((n) => n.approvalId).filter(Boolean))
  const extra = approvals.filter((a) => a.status === 'pending' && !have.has(a.id)).map((a) => fromApproval(a, rooms))
  return [...notifications, ...extra]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((n) => ({ n, approval: n.approvalId ? byApproval.get(n.approvalId) : undefined }))
}

/** Waiting on CJ. An approval row follows its approval, in case the notification event has not caught up. */
export const needsYou = (i: InboxItem) => (i.approval ? i.approval.status === 'pending' : i.n.needsYou)

export const inTab = (i: InboxItem, tab: InboxTab) => tab === 'all' || (tab === 'needs') === needsYou(i)

/** Compact age for the list: 2m, 6m, 9h, 3d. */
export function age(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export const agentOf = (n: Notification, agents: Record<string, AgentDef[]>) => (n.roomId ? agents[n.roomId]?.find((a) => a.id === n.agentId) : undefined)
