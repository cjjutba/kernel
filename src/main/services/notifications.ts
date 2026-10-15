import type { AppSettings, Approval, Chat, Notification, PrState, Workspace } from '@shared/types'
import type { TurnBy } from './sessions'
import type { PushEvent } from '@shared/ipc'
import type { Store } from '../db'
import { bus } from '../bus'

type Deps = {
  store: Store
  settings: () => AppSettings
  /** Name of an agent in a project, for "Noor wants to run ...". */
  agentName: (projectId: string | undefined, agentId: string | undefined) => string | undefined
  /** Show a macOS notification. Not called while the app has focus. */
  show?: (n: Notification, o: { silent: boolean; sound?: string }) => void
  /** True while no Kernel window has focus. */
  inBackground?: () => boolean
  now?: () => number
  /** How long after a finished turn an agent counts as idle. Ten minutes; tests shorten it. */
  idleAfterMs?: number
}

/**
 * A finished turn, as Kernel reports it. `lead` and `queued` come from outside: the team and the chat's queue. `by` sent
 * the message that started it (KERNEL-116). `account` is the one it ran on, undefined for the CLI's own login, and `limit`
 * says a usage limit cut it off, so it carries on by itself later (KERNEL-777).
 */
export interface TurnDone { ok: boolean; interrupted: boolean; lead: boolean; queued: boolean; by: TurnBy; account?: string; limit?: true }

const IDLE_AFTER_MS = 10 * 60_000
/** How long a row that no longer needs you stays in the inbox (D-137). */
export const KEEP_SETTLED_MS = 7 * 24 * 60 * 60_000
const PRUNE_EVERY_MS = 24 * 60 * 60_000

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
    // Only a hook approval has a terminal to fall back to. An agent's own request just ends (D-137).
    case 'expired': return a.source === 'sdk' ? 'This request ended before you answered.' : 'This request timed out before you answered. Claude Code asks in its own terminal instead.'
    default: return ''
  }
}

const kindLabel = (a: Approval) => (a.kind === 'plan' || a.toolName === 'ExitPlanMode' ? 'Plan review' : a.kind === 'question' ? 'Question' : a.kind === 'agent' ? 'Create agent' : 'Permission')

/**
 * Turns bus events into inbox rows (Inbox.png) and, when the app is in the background, macOS notifications.
 * Approvals and PR events land here. Every item reaches the inbox; Settings > Notifications only gates the macOS banner.
 */
export class Notifications {
  private off: () => void = () => undefined
  /** Idle checks waiting to fire, by workspace. The workspace's next turn cancels its check. */
  private idle = new Map<string, NodeJS.Timeout>()
  private pruneTimer?: NodeJS.Timeout
  /** The head commit each PR was on when its ready row was made, until the PR leaves ready and checks (KERNEL-283). */
  private readyOn = new Map<string, string>()
  constructor(private d: Deps) {}

  attach() {
    // A ready PR that already has its row keeps it across a restart, so the next base move doesn't alert again.
    const rows = this.d.store.notifications()
    // One GitHub blocks has no row to keep, so its unblock makes one (KERNEL-401).
    for (const w of this.d.store.workspaces()) if (w.prState === 'ready' && w.prHead && !w.prBlocked && rows.some((n) => n.workspaceId === w.id && n.kind === 'merge')) this.readyOn.set(w.id, w.prHead)
    const on = (e: PushEvent) => {
      if (e.type === 'approval') this.onApproval(e.approval)
      else if (e.type === 'pr') this.onPr(e.workspaceId, e.state)
      else if (e.type === 'pr.blocked') this.onBlocked(e.workspaceId, !!e.blocked)
      else if (e.type === 'chat.running' && e.running) { const ws = this.d.store.chat(e.chatId)?.workspaceId; if (ws) this.cancelIdle(ws) }
    }
    bus.on('push', on)
    this.off = () => bus.off('push', on)
    // A row whose approval ended while no one listened, as the ones `Approvals.expireStale` ends at start, settles now.
    for (const n of this.d.store.openApprovalNotifications()) {
      const a = this.d.store.approval(n.approvalId!)
      if (a && a.status !== 'pending') this.onApproval(a)
    }
    // Approvals that were pending before this run (or before notifications existed) still need a row.
    for (const a of this.d.store.approvals({ pendingOnly: true })) if (!this.d.store.notification(approvalNotificationId(a.id))) this.onApproval(a, false)
    this.prune()
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_EVERY_MS)
  }

  /** Set by `detach()`, which runs when Kernel stops. Work that outlives it reaches the closed database only through here. */
  private detached = false

  detach() { this.detached = true; this.off(); clearInterval(this.pruneTimer); for (const id of [...this.idle.keys()]) this.cancelIdle(id) }

  /**
   * At start and once a day: deletes the rows of archived and deleted workspaces, and rows created more than a week ago
   * that no longer need you (D-137). A row that needs you stays however old.
   */
  prune(): string[] {
    const now = this.d.now?.() ?? Date.now()
    return this.removed([...this.d.store.deleteOrphanNotifications(), ...this.d.store.deleteSettledNotifications(now - KEEP_SETTLED_MS)])
  }

  /** An archived workspace's rows go at once (D-137). History still has the workspace. */
  forgetWorkspace(workspaceId: string): string[] {
    this.cancelIdle(workspaceId)
    return this.removed(this.d.store.deleteWorkspaceNotifications(workspaceId))
  }

  private removed(ids: string[]): string[] {
    if (ids.length) bus.push({ type: 'notification.removed', ids })
    return ids
  }

  /**
   * A teammate's turn ended with nothing left to do: a "Finished" row in Inbox > Updates (Inbox.png), one per workspace,
   * replaced by the next. The Lead's turns, interrupted or failed turns, and turns with a message queued or an
   * approval pending don't count. With "An agent is idle for 10 minutes" on, an idle row follows if nothing happens.
   */
  turnDone(asked: Workspace, chat: Chat, t: TurnDone) {
    const ws = this.d.store.workspace(asked.id) ?? asked
    if (t.lead || !t.ok || t.interrupted || t.queued || ws.status === 'archived') return
    if (this.d.store.approvals({ pendingOnly: true }).some((a) => a.chatId === chat.id)) return
    const project = this.d.store.project(ws.projectId)
    const who = this.d.agentName(ws.projectId, ws.agentId) ?? 'An agent'
    const task = ws.title ?? ws.name
    const reply = [...this.d.store.items(chat.id)].reverse().find((i) => i.kind === 'text')
    const now = this.d.now?.() ?? Date.now()
    const n = this.save({
      id: `n-finished-${ws.id}`, kind: 'finished', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId,
      title: `Finished ${task}`, sub: `Workspace ready${project ? ` · ${project.name}` : ''}`,
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
    const project = this.d.store.project(ws.projectId)
    const n = this.save({
      id: `n-idle-${ws.id}`, kind: 'idle', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId,
      title: `${who} is idle`, sub: `${task}${project ? ` · ${project.name}` : ''}`,
      heading: `${who} has been idle for 10 minutes`, body: `Nothing has happened in ${task} since ${who}'s last turn.`,
      needsYou: false, read: false, createdAt: this.d.now?.() ?? Date.now()
    })
    this.alert(n, 'idle')
  }

  /**
   * A row in Inbox > Updates that asks nothing of the user, such as the weekly usage warning (KERNEL-220), and a macOS banner
   * while the app is in the background. The feature that sends it has its own switch, so Settings > Notifications' per-kind
   * switches don't apply, and quiet hours and the sound setting still do. One row per `id`: a second call with it changes nothing,
   * unless `replace`, which updates the row in place, as a project's list of chats waiting on the user does (KERNEL-844). A row
   * that comes to need the user again is unread and alerts again.
   */
  notice(n: Pick<Notification, 'id' | 'title' | 'sub'> & Partial<Pick<Notification, 'heading' | 'body' | 'projectId' | 'workspaceId' | 'needsYou' | 'resolved'>>, o: { replace?: boolean } = {}): Notification {
    const made: Notification = { kind: 'system', needsYou: false, read: false, createdAt: this.d.now?.() ?? Date.now(), ...n }
    if (this.detached) return made
    const had = this.d.store.notification(n.id)
    if (had && !o.replace) return had
    const again = !!n.needsYou && !had?.needsYou
    const row = this.save(had ? { ...had, resolved: undefined, ...n, read: had.read && !again } : made)
    if (!had || again) this.alert(row, 'usage')
    return row
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
    const project = a.projectId ? this.d.store.project(a.projectId) : undefined
    const who = this.d.agentName(a.projectId, a.agentId) ?? 'An agent'
    const plan = a.kind === 'plan' || a.toolName === 'ExitPlanMode'
    const count = a.questions?.length ?? 0
    const n: Notification = {
      id, kind: 'approval', projectId: a.projectId, workspaceId: a.workspaceId, agentId: a.agentId, approvalId: a.id,
      title: plan ? `Plan ready: ${a.title.replace(/^Plan (for|to) /i, '')}` : a.kind === 'question' ? a.title : `Wants to ${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}`,
      sub: `${kindLabel(a)}${project ? ` · ${project.name}` : ''}`,
      heading: plan ? `${who} has a plan for you to review` : a.kind === 'question' ? (count > 1 ? `${who} has ${count} questions` : `${who} has a question`) : `${who} wants to ${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}`,
      needsYou: true, read: false, createdAt: a.createdAt
    }
    this.save(n)
    if (alert) this.alert(n, plan ? 'plan' : 'permission')
  }

  private onPr(workspaceId: string, state: PrState) {
    const ws = this.d.store.workspace(workspaceId)
    // A PR refresh that lands after the archive would add a row the archive already cleared (D-137).
    if (!ws || ws.status === 'archived') return
    const project = this.d.store.project(ws.projectId)
    const num = ws.prNumber ? `#${ws.prNumber}` : 'PR'
    const mine = this.d.store.notifications().filter((n) => n.workspaceId === workspaceId && (n.kind === 'merge' || n.kind === 'check'))
    // A new state settles whatever the PR was waiting on before.
    const settle = (resolved: string) => { for (const n of mine) if (n.needsYou) this.save({ ...n, needsYou: false, read: true, resolved }) }
    const make = (kind: 'merge' | 'check', title: string, heading: string, body: string, gate: 'merge' | 'checkFailed') => {
      settle('The PR changed after this.')
      const n = this.save({ id: `n-pr-${workspaceId}-${state}-${this.d.now?.() ?? Date.now()}`, kind, projectId: ws.projectId, workspaceId, agentId: ws.agentId, title, sub: `${kind === 'merge' ? 'Merge' : 'Check failed'}${project ? ` · ${project.name}` : ''}`, heading, body, needsYou: true, read: false, createdAt: this.d.now?.() ?? Date.now() })
      this.alert(n, gate)
    }
    // A ready PR GitHub won't merge isn't ready to merge. Its row waits for the block to lift, which `onBlocked` hears. This
    // comes before the check below, since a PR usually falls behind as ready again on the same head (KERNEL-401).
    if (state === 'ready' && ws.prBlocked) { this.holdMerge(workspaceId); return }
    // Ready again on the commit its row is for, after only checks, isn't news. GitHub checks a PR for conflicts again
    // each time its base moves, and it reads as checks until then (KERNEL-283).
    if (state !== 'ready' && state !== 'checks') this.readyOn.delete(workspaceId)
    if (state === 'ready' && ws.prHead && this.readyOn.get(workspaceId) === ws.prHead) return
    if (state === 'ready' && ws.prHead) this.readyOn.set(workspaceId, ws.prHead)
    if (state === 'ready') make('merge', `PR ${num} is ready to merge`, `PR ${num} is ready to merge`, `${ws.prTitle ?? ws.name} has passing checks and no open review comments.`, 'merge')
    else if (state === 'cifail') make('check', `Checks failed on PR ${num}`, `Checks failed on PR ${num}`, `${ws.prTitle ?? ws.name} has a failing check. Open the workspace to see which one.`, 'checkFailed')
    else if (state === 'changes') make('check', `Changes requested on PR ${num}`, `Changes requested on PR ${num}`, `A reviewer asked for changes on ${ws.prTitle ?? ws.name}.`, 'checkFailed')
    else if (state === 'merged') settle('Merged.')
    else if (state === 'closed') settle('The PR was closed.')
  }

  /**
   * GitHub started or stopped blocking a ready PR (KERNEL-401). A block takes back its "ready to merge" row; the end of one
   * makes the row a ready PR gets.
   */
  private onBlocked(workspaceId: string, blocked: boolean) {
    const ws = this.d.store.workspace(workspaceId)
    if (!ws || ws.status === 'archived' || ws.prState !== 'ready') return
    if (blocked) this.holdMerge(workspaceId)
    else this.onPr(workspaceId, 'ready')
  }

  /** Settles the PR's open rows, a "ready to merge" one as one GitHub blocks, and forgets the head its row was for. */
  private holdMerge(workspaceId: string) {
    this.readyOn.delete(workspaceId)
    for (const n of this.d.store.notifications()) {
      if (n.workspaceId !== workspaceId || !n.needsYou || (n.kind !== 'merge' && n.kind !== 'check')) continue
      this.save({ ...n, needsYou: false, read: true, resolved: n.kind === 'merge' ? 'GitHub blocks the merge.' : 'The PR changed after this.' })
    }
  }

  /** `usage` has no switch here: a warning is on or off in Settings, Account. */
  private alert(n: Notification, gate: 'permission' | 'plan' | 'merge' | 'checkFailed' | 'finished' | 'idle' | 'usage') {
    const s = this.d.settings().notifications
    if ((gate !== 'usage' && !s[gate]) || !this.d.show || !this.d.inBackground?.()) return
    if (inQuietHours(s.quietHours, new Date(this.d.now?.() ?? Date.now()))) return
    this.d.show(n, bannerSound(s.sound))
  }
}

/** The macOS system sound Chime plays. Subtle is the system's default banner sound (KERNEL-538). */
export const CHIME_SOUND = 'Glass'

/** How a banner sounds, by Settings, Notifications, Sound: Subtle plays the default, Chime its own, None nothing (KERNEL-538). */
export function bannerSound(sound: AppSettings['notifications']['sound']): { silent: boolean; sound?: string } {
  return sound === 'none' ? { silent: true } : sound === 'chime' ? { silent: false, sound: CHIME_SOUND } : { silent: false }
}
