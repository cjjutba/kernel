import type { AgentDef, Approval, Notification, Overlap, Project } from '@shared/types'

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
/** "Christian", "Christian and Sean", "Christian, Sean and Teng". */
export const names = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`)
export const fileName = (path: string) => path.split('/').pop() ?? path
/** "Two agents changed the same file". */
export const overlapTitle = (o: Overlap) => `${cap(NUMBERS[o.parties.length] ?? String(o.parties.length))} agents changed the same file`

const label = (a: Approval) => (a.kind === 'plan' || a.toolName === 'ExitPlanMode' ? 'Plan review' : a.kind === 'question' ? 'Question' : a.kind === 'agent' ? 'Create agent' : 'Permission')

/** A row for a pending approval that main has not turned into a notification yet. Same shape main writes (services/notifications.ts). */
function fromApproval(a: Approval, projects: Project[]): Notification {
  const project = projects.find((r) => r.id === a.projectId)
  return {
    id: `n-approval-${a.id}`, kind: 'approval', projectId: a.projectId, workspaceId: a.workspaceId, agentId: a.agentId, approvalId: a.id,
    title: a.title, sub: `${label(a)}${project ? ` · ${project.name}` : ''}`, needsYou: true, read: false, createdAt: a.createdAt
  }
}

/** A row for agents changing the same file in different worktrees. It lasts until the overlap clears or the Lead takes it (D-104). */
function fromOverlap(o: Overlap, projects: Project[]): Notification {
  const project = projects.find((r) => r.id === o.projectId)
  return {
    id: `n-overlap-${o.id}`, kind: 'overlap', projectId: o.projectId, title: overlapTitle(o),
    sub: `${fileName(o.path)}${project ? ` · ${project.name}` : ''}`, needsYou: true, read: false, createdAt: o.ts
  }
}

/**
 * Everything the Inbox lists, newest first. Stored notifications plus pending approvals that have no row yet, so a count never lags
 * an approval, plus open overlaps.
 */
export function inboxItems(notifications: Notification[], approvals: Approval[], projects: Project[], overlaps: Overlap[] = []): InboxItem[] {
  const byApproval = new Map(approvals.map((a) => [a.id, a]))
  const have = new Set(notifications.map((n) => n.approvalId).filter(Boolean))
  const extra = approvals.filter((a) => a.status === 'pending' && !have.has(a.id)).map((a) => fromApproval(a, projects))
  const open = overlaps.filter((o) => !o.resolved)
  const byOverlap = new Map(open.map((o) => [`n-overlap-${o.id}`, o]))
  return [...notifications, ...extra, ...open.map((o) => fromOverlap(o, projects))]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((n) => ({ n, approval: n.approvalId ? byApproval.get(n.approvalId) : undefined, overlap: byOverlap.get(n.id) }))
}

/** Every project's overlaps in one list, for `inboxItems`. */
export const allOverlaps = (byProject: Record<string, Overlap[]>) => Object.values(byProject).flat()

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

export const agentOf = (n: Notification, agents: Record<string, AgentDef[]>) => (n.projectId ? agents[n.projectId]?.find((a) => a.id === n.agentId) : undefined)

/** Whether an item matches the words typed in the Inbox's filter: its title, its line under it or the agent's name, in any case. */
export function matchesFilter(i: InboxItem, query: string, agentName?: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [i.n.title, i.n.heading, i.n.sub, agentName].some((t) => t?.toLowerCase().includes(q))
}
