import type { AppSettings, Approval, Chat, Notification, PrState, Workspace } from '@shared/types'
import type { TurnBy } from './sessions'
import type { PushEvent } from '@shared/ipc'
import type { Store } from '../db'
import { bus } from '../bus'

type Deps = {
  store: Store
  settings: () => AppSettings
  /** Name of an agent in a room, for "Noor wants to run ...". */
  agentName: (roomId: string | undefined, agentId: string | undefined) => string | undefined
  /** Show a macOS notification. Not called while the app has focus. */
  show?: (n: Notification, o: { silent: boolean }) => void
  /** True while no Kernel window has focus. */
  inBackground?: () => boolean
  now?: () => number
  /** How long after a finished turn an agent counts as idle. Ten minutes; tests shorten it. */
  idleAfterMs?: number
}

/**
 * A finished turn, as Kernel reports it. `lead` and `queued` come from outside: the team and the chat's queue. `by` sent
 * the message that started it (KERNEL-116).
 */
export interface TurnDone { ok: boolean; interrupted: boolean; lead: boolean; queued: boolean; by: TurnBy }

const IDLE_AFTER_MS = 10 * 60_000

/** The start of the agent's last reply, for the detail pane: its first paragraph, cut at about 300 characters. */
export function replyExcerpt(text: string, max = 300): string {
  const first = text.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ')
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

/** The inbox row that carries an approval. One per approval, so a decision updates it in place. */
export const approvalNotificationId = (approvalId: string) => `n-approval-${approvalId}`

/** "22:00" to 22 * 60. */
const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h || 0) * 60 + (m || 0) }

/** True when `at` falls in quiet hours. A window that crosses midnight (22:00 to 07:00) works. */
export function inQuietHours(q: { from: string; to: string } | null, at: Date): boolean {
  if (!q) return false
  const now = at.getHours() * 60 + at.getMinutes(), from = minutes(q.from), to = minutes(q.to)
  return from <= to ? now >= from && now < to : now >= from || now < to
}

const outcome = (a: Approval): string => {
  switch (a.status) {
    case 'allowed': return 'You approved this.'
    case 'denied': return 'You denied this.'
    case 'answered': return a.answer ? `You answered: ${a.answer}` : 'You answered this.'
    case 'expired': return 'This request timed out before you answered. Claude Code asks in its own terminal instead.'
    default: return ''
  }
}

const kindLabel = (a: Approval) => (a.kind === 'plan' || a.toolName === 'ExitPlanMode' ? 'Plan review' : a.kind === 'question' ? 'Question' : a.kind === 'agent' ? 'Hire' : 'Permission')

/**
 * Turns bus events into inbox rows (Inbox.png) and, when the app is in the background, macOS notifications.
 * Approvals and PR events land here. Every item reaches the inbox; Settings > Notifications only gates the macOS banner.
 */
export class Notifications {
  private off: () => void = () => undefined
  /** Idle checks waiting to fire, by workspace. The workspace's next turn cancels its check. */
  private idle = new Map<string, NodeJS.Timeout>()
  constructor(private d: Deps) {}

  attach() {
    const on = (e: PushEvent) => {
      if (e.type === 'approval') this.onApproval(e.approval)
      else if (e.type === 'pr') this.onPr(e.workspaceId, e.state)
      else if (e.type === 'chat.running' && e.running) { const ws = this.d.store.chat(e.chatId)?.workspaceId; if (ws) this.cancelIdle(ws) }
    }
    bus.on('push', on)
    this.off = () => bus.off('push', on)
    // Approvals that were pending before this run (or before notifications existed) still need a row.
    for (const a of this.d.store.approvals({ pendingOnly: true })) if (!this.d.store.notification(approvalNotificationId(a.id))) this.onApproval(a, false)
  }

  detach() { this.off(); for (const id of [...this.idle.keys()]) this.cancelIdle(id) }

  /**
   * A teammate's turn ended with nothing left to do: a "Finished" row in Inbox > Updates (Inbox.png), one per workspace,
   * replaced by the next. The Lead's turns, interrupted or failed turns, and turns with a message queued or an
   * approval pending don't count. With "An agent is idle for 10 minutes" on, an idle row follows if nothing happens.
   */
  turnDone(asked: Workspace, chat: Chat, t: TurnDone) {
    const ws = this.d.store.workspace(asked.id) ?? asked
    if (t.lead || !t.ok || t.interrupted || t.queued || ws.status === 'archived') return
    if (this.d.store.approvals({ pendingOnly: true }).some((a) => a.chatId === chat.id)) return
    const room = this.d.store.room(ws.roomId)
    const who = this.d.agentName(ws.roomId, ws.agentId) ?? 'An agent'
    const task = ws.title ?? ws.name
    const reply = [...this.d.store.items(chat.id)].reverse().find((i) => i.kind === 'text')
    const now = this.d.now?.() ?? Date.now()
    const n = this.save({
      id: `n-finished-${ws.id}`, kind: 'finished', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId,
      title: `Finished ${task}`, sub: `Workspace ready${room ? ` · ${room.name}` : ''}`,
      heading: `${who} finished ${task}`, body: reply?.kind === 'text' ? replyExcerpt(reply.text) : undefined,
      needsYou: false, read: false, createdAt: now
    })
    this.alert(n, 'finished')
    this.cancelIdle(ws.id)
    if (!this.d.settings().notifications.idle) return
    this.idle.set(ws.id, setTimeout(() => this.idleNow(ws.id, who, task), this.d.idleAfterMs ?? IDLE_AFTER_MS))
  }

  private cancelIdle(workspaceId: string) {
    const t = this.idle.get(workspaceId)
    if (t) clearTimeout(t)
    this.idle.delete(workspaceId)
  }

  private idleNow(workspaceId: string, who: string, task: string) {
    this.idle.delete(workspaceId)
    const ws = this.d.store.workspace(workspaceId)
    if (!ws || ws.status === 'archived' || !this.d.settings().notifications.idle) return
    const room = this.d.store.room(ws.roomId)
    const n = this.save({
      id: `n-idle-${ws.id}`, kind: 'idle', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId,
      title: `${who} is idle`, sub: `${task}${room ? ` · ${room.name}` : ''}`,
      heading: `${who} has been idle for 10 minutes`, body: `Nothing has happened in ${task} since ${who}'s last turn.`,
      needsYou: false, read: false, createdAt: this.d.now?.() ?? Date.now()
    })
    this.alert(n, 'idle')
  }

  list(): Notification[] { return this.d.store.notifications() }

  read(ids: string[] | 'all'): Notification[] {
    const out: Notification[] = []
    for (const n of this.d.store.notifications()) {
      if (n.read || !(ids === 'all' || ids.includes(n.id))) continue
      out.push(this.save({ ...n, read: true }))
    }
    return out
  }

  private save(n: Notification): Notification {
    this.d.store.saveNotification(n)
    bus.push({ type: 'notification', notification: n })
    return n
  }

  private onApproval(a: Approval, alert = true) {
    const id = approvalNotificationId(a.id)
    const prev = this.d.store.notification(id)
    if (a.status !== 'pending') {
      if (prev) this.save({ ...prev, needsYou: false, read: true, resolved: outcome(a) })
      return
    }
    if (prev) return
    const room = a.roomId ? this.d.store.room(a.roomId) : undefined
    const who = this.d.agentName(a.roomId, a.agentId) ?? 'An agent'
    const plan = a.kind === 'plan' || a.toolName === 'ExitPlanMode'
    const n: Notification = {
      id, kind: 'approval', roomId: a.roomId, workspaceId: a.workspaceId, agentId: a.agentId, approvalId: a.id,
      title: plan ? `Plan ready: ${a.title.replace(/^Plan (for|to) /i, '')}` : a.kind === 'question' ? a.title : `Wants to ${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}`,
      sub: `${kindLabel(a)}${room ? ` · ${room.name}` : ''}`,
      heading: plan ? `${who} has a plan for you to review` : a.kind === 'question' ? `${who} has a question` : `${who} wants to ${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}`,
      needsYou: true, read: false, createdAt: a.createdAt
    }
    this.save(n)
    if (alert) this.alert(n, plan ? 'plan' : 'permission')
  }

  private onPr(workspaceId: string, state: PrState) {
    const ws = this.d.store.workspace(workspaceId)
    if (!ws) return
    const room = this.d.store.room(ws.roomId)
    const num = ws.prNumber ? `#${ws.prNumber}` : 'PR'
    const mine = this.d.store.notifications().filter((n) => n.workspaceId === workspaceId && (n.kind === 'merge' || n.kind === 'check'))
    // A new state settles whatever the PR was waiting on before.
    const settle = (resolved: string) => { for (const n of mine) if (n.needsYou) this.save({ ...n, needsYou: false, read: true, resolved }) }
    const make = (kind: 'merge' | 'check', title: string, heading: string, body: string, gate: 'merge' | 'checkFailed') => {
      settle('The PR changed after this.')
      const n = this.save({ id: `n-pr-${workspaceId}-${state}-${this.d.now?.() ?? Date.now()}`, kind, roomId: ws.roomId, workspaceId, agentId: ws.agentId, title, sub: `${kind === 'merge' ? 'Merge' : 'Check failed'}${room ? ` · ${room.name}` : ''}`, heading, body, needsYou: true, read: false, createdAt: this.d.now?.() ?? Date.now() })
      this.alert(n, gate)
    }
    if (state === 'ready') make('merge', `PR ${num} is ready to merge`, `PR ${num} is ready to merge`, `${ws.prTitle ?? ws.name} has passing checks and no open review comments.`, 'merge')
    else if (state === 'cifail') make('check', `Checks failed on PR ${num}`, `Checks failed on PR ${num}`, `${ws.prTitle ?? ws.name} has a failing check. Open the workspace to see which one.`, 'checkFailed')
    else if (state === 'changes') make('check', `Changes requested on PR ${num}`, `Changes requested on PR ${num}`, `A reviewer asked for changes on ${ws.prTitle ?? ws.name}.`, 'checkFailed')
    else if (state === 'merged') settle('Merged.')
    else if (state === 'closed') settle('The PR was closed.')
  }

  private alert(n: Notification, gate: 'permission' | 'plan' | 'merge' | 'checkFailed' | 'finished' | 'idle') {
    const s = this.d.settings().notifications
    if (!s[gate] || !this.d.show || !this.d.inBackground?.()) return
    if (inQuietHours(s.quietHours, new Date(this.d.now?.() ?? Date.now()))) return
    this.d.show(n, { silent: s.sound === 'none' })
  }
}
