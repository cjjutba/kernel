import type { AgentDef, Approval, Notification, Overlap, Room } from '@shared/types'

export type InboxTab = 'all' | 'needs' | 'updates'

export interface InboxItem {
  n: Notification
  /** The live approval behind an approval row, so the detail pane answers the current state, not a snapshot. */
  approval?: Approval
  /** The open overlap behind an overlap row (D-104). */
  overlap?: Overlap
}

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** "Kai", "Kai and Noor", "Kai, Noor and Ivy". */
export const names = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`)
export const fileName = (path: string) => path.split('/').pop() ?? path
/** "Two agents changed the same file". */
export const overlapTitle = (o: Overlap) => `${cap(NUMBERS[o.parties.length] ?? String(o.parties.length))} agents changed the same file`

const label = (a: Approval) => (a.kind === 'plan' || a.toolName === 'ExitPlanMode' ? 'Plan review' : a.kind === 'question' ? 'Question' : a.kind === 'agent' ? 'Hire' : 'Permission')

/** A row for a pending approval that main has not turned into a notification yet. Same shape main writes (services/notifications.ts). */
function fromApproval(a: Approval, rooms: Room[]): Notification {
  const room = rooms.find((r) => r.id === a.roomId)
  return {
    id: `n-approval-${a.id}`, kind: 'approval', roomId: a.roomId, workspaceId: a.workspaceId, agentId: a.agentId, approvalId: a.id,
    title: a.title, sub: `${label(a)}${room ? ` · ${room.name}` : ''}`, needsYou: true, read: false, createdAt: a.createdAt
  }
}

/** A row for agents changing the same file in different worktrees. It lasts until the overlap clears or Rowan takes it (D-104). */
function fromOverlap(o: Overlap, rooms: Room[]): Notification {
  const room = rooms.find((r) => r.id === o.roomId)
  return {
    id: `n-overlap-${o.id}`, kind: 'overlap', roomId: o.roomId, title: overlapTitle(o),
    sub: `${fileName(o.path)}${room ? ` · ${room.name}` : ''}`, needsYou: true, read: false, createdAt: o.ts
  }
}

/**
 * Everything the Inbox lists, newest first. Stored notifications plus pending approvals that have no row yet, so a count never lags
 * an approval, plus open overlaps, which the floor used to show.
 */
export function inboxItems(notifications: Notification[], approvals: Approval[], rooms: Room[], overlaps: Overlap[] = []): InboxItem[] {
  const byApproval = new Map(approvals.map((a) => [a.id, a]))
  const have = new Set(notifications.map((n) => n.approvalId).filter(Boolean))
  const extra = approvals.filter((a) => a.status === 'pending' && !have.has(a.id)).map((a) => fromApproval(a, rooms))
  const open = overlaps.filter((o) => !o.resolved)
  const byOverlap = new Map(open.map((o) => [`n-overlap-${o.id}`, o]))
  return [...notifications, ...extra, ...open.map((o) => fromOverlap(o, rooms))]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((n) => ({ n, approval: n.approvalId ? byApproval.get(n.approvalId) : undefined, overlap: byOverlap.get(n.id) }))
}

/** Every room's overlaps in one list, for `inboxItems`. */
export const allOverlaps = (byRoom: Record<string, Overlap[]>) => Object.values(byRoom).flat()

/** Waiting on the user. An approval row follows its approval, in case the notification event has not caught up. */
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
