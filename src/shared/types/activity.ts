/** A line in the project logs. */
export interface ActivityEvent {
  id: string
  ts: number
  projectId?: string
  workspaceId?: string
  agentId?: string
  sessionId?: string
  taskId?: string
  /** Who did it. Agent unless set. */
  actor?: 'you' | 'agent' | 'kernel'
  kind:
    | 'session.start' | 'session.end' | 'prompt' | 'tool.start' | 'tool.end' | 'tool.failed'
    | 'turn.done' | 'approval.requested' | 'approval.decided' | 'task.created' | 'task.assigned' | 'task.completed'
    | 'workspace.created' | 'workspace.archived' | 'workspace.restored' | 'pr.changed' | 'agent.status' | 'agent.say'
    | 'agent.joined' | 'agent.talk' | 'agent.retired' | 'project.paused' | 'project.resumed' | 'brief' | 'overlap' | 'checkpoint.reverted'
    | 'limit' | 'note'
  text: string
  object?: string
  /** A quoted brief or message under the line. */
  quote?: string
  /** Shows the object as something that needs the user. */
  warn?: boolean
  /** `agent.talk` carries `from` and `to` (agent ids) and `workspaceId`; `overlap` carries `overlapId` and `workspaceIds`. */
  data?: Record<string, unknown>
}

/** Inbox rows that are not approvals: merge ready, a failed check, a finished workspace, a standup, system news (Inbox.png). `overlap` rows are built in the renderer from live state, never stored. */
export type NotificationKind = 'approval' | 'merge' | 'blocked' | 'check' | 'finished' | 'idle' | 'standup' | 'system' | 'overlap'

export interface Notification {
  id: string
  kind: NotificationKind
  projectId?: string
  workspaceId?: string
  agentId?: string
  taskId?: string
  approvalId?: string
  title: string
  /** The line under the title, for example "Merge · Client A". */
  sub: string
  /** The heading on the detail pane. */
  heading?: string
  body?: string
  /** True while the user still has to act on it. */
  needsYou: boolean
  read: boolean
  /** What the detail pane says after the user acted. */
  resolved?: string
  /** The terminal Lead tab the row is about (KERNEL-1000). */
  chatId?: string
  /** A teammate's question to a terminal Lead, which the user can answer here: `notifications.answer` sends it to the teammate (KERNEL-1000). */
  ask?: { workspaceId: string; question: string; options?: string[] }
  createdAt: number
}
