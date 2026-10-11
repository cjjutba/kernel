/** A line in the room logs and the source of every floor animation. */
export interface ActivityEvent {
  id: string
  ts: number
  roomId?: string
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
    | 'agent.joined' | 'agent.talk' | 'agent.retired' | 'room.paused' | 'room.resumed' | 'brief' | 'overlap' | 'checkpoint.reverted'
    | 'limit' | 'note'
  text: string
  object?: string
  /** A quoted brief or message under the line (FloorSent.png). */
  quote?: string
  /** Shows the object as something that needs the user. */
  warn?: boolean
  /** `agent.talk` carries `from` and `to` (agent ids) and `workspaceId`; `overlap` carries `overlapId` and `workspaceIds`. */
  data?: Record<string, unknown>
}

/** Inbox rows that are not approvals: merge ready, a failed check, a finished workspace, a standup, system news (Inbox.png). */
export type NotificationKind = 'approval' | 'merge' | 'blocked' | 'check' | 'finished' | 'idle' | 'standup' | 'system' | 'overlap'

export interface Notification {
  id: string
  kind: NotificationKind
  roomId?: string
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
  createdAt: number
}
