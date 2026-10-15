import { randomUUID } from 'node:crypto'
import type { Approval, Decision, PlanStep } from '@shared/types'
import type { Store } from '../db'
import { bus } from '../bus'
import { toolAsk, toolView } from '@shared/toolView'

/** A live waiter, with the chat and kind of its approval so the quit prompt can tell a plan card from work (KERNEL-827). */
type Pending = { resolve: (d: Decision | null) => void; timer?: NodeJS.Timeout; chatId?: string; plan: boolean }

/** Request changes on a plan as the user wrote it: the notes before Kernel's lines for the images, and the images. */
export type Typed = { notes?: string; images?: Approval['images'] }

/** Why a plan card expired, which the card says. */
export type ExpiredBy = NonNullable<Approval['expiredBy']>

/** A plan card: ExitPlanMode or the Lead's `request_plan_approval`, the same test as the composer's `isPlanApproval`. */
const isPlan = (a: Approval) => a.kind === 'plan' || a.toolName === 'ExitPlanMode'

/**
 * One queue for everything that needs the user: tool permissions (from canUseTool or the PermissionRequest
 * hook), plan approvals and questions from the Lead. request() waits until decide() is called, or the timeout
 * passes and it resolves null so the caller can fall back (hooks fall back to Claude Code's own prompt).
 */
export class Approvals {
  private pending = new Map<string, Pending>()
  /** Kernel is quitting (`expirePending`): nothing new waits, and nothing is saved, since the database is about to close. */
  private closed = false
  /** Kernel is quitting (`quitting`): a plan card whose waiter ends now stays pending for the next launch (plan-cards-survive-restart). */
  private keepPlans = false
  /** Chats whose open turn waited on a tool permission or a question when Kernel last quit or closed (`waitedOnUser`). */
  private waited = new Set<string>()
  constructor(private store?: Store) {}

  request(a: Omit<Approval, 'id' | 'status' | 'createdAt'>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): { approval: Approval; decision: Promise<Decision | null> } {
    const approval: Approval = { ...a, id: randomUUID(), status: 'pending', createdAt: Date.now() }
    // A hook request that lands while Kernel quits gets the fallback answer at once, so Claude Code asks in its own window.
    if (this.closed) return { approval: { ...approval, status: 'expired' }, decision: Promise.resolve(null) }
    this.store?.saveApproval(approval)
    bus.push({ type: 'approval', approval })
    bus.activity({ kind: 'approval.requested', projectId: a.projectId, workspaceId: a.workspaceId, agentId: a.agentId, text: a.title, object: a.toolName })
    const decision = new Promise<Decision | null>((resolve) => {
      const entry: Pending = { resolve, chatId: a.chatId, plan: a.kind === 'plan' }
      if (opts.timeoutMs) entry.timer = setTimeout(() => this.finish(approval.id, null, 'expired'), opts.timeoutMs)
      opts.signal?.addEventListener('abort', () => this.finish(approval.id, null, 'expired'), { once: true })
      this.pending.set(approval.id, entry)
    })
    return { approval, decision }
  }

  /**
   * `typed`: on a plan's Request changes, what the user typed, before Kernel added lines for the images, and the images it
   * saved. The notes default to the message.
   */
  decide(id: string, decision: Decision, typed?: Typed): Approval | undefined {
    const status = decision.behavior === 'allow' ? 'allowed' : decision.behavior === 'deny' ? 'denied' : 'answered'
    return this.finish(id, decision, status, { typed })
  }

  isPending(id: string) { return this.pending.has(id) }

  /**
   * The chat's open turn only waits on a plan card: it has a live plan waiter and no other. A quit keeps that card for the
   * next launch, so the quit prompt doesn't count the chat as working. A tool permission or a question expires on quit,
   * so a chat waiting on one still counts (KERNEL-827).
   */
  waitsOnPlan(chatId: string): boolean {
    const mine = [...this.pending.values()].filter((p) => p.chatId === chatId)
    return mine.length > 0 && mine.every((p) => p.plan)
  }

  /**
   * A plan card that waits with no waiter, as one from before a restart. `decide` can't answer it, so the caller delivers
   * the answer itself and settles the row here (plan-cards-survive-restart).
   */
  waitingPlan(id: string): Approval | undefined {
    const a = this.store?.approval(id)
    return a?.kind === 'plan' && a.status === 'pending' && !this.pending.has(id) ? a : undefined
  }

  /** Mark a waiting plan without a waiter as answered (`waitingPlan`). `typed` as in `decide`. */
  settle(id: string, decision: Decision, typed?: Typed): Approval | undefined {
    const prev = this.waitingPlan(id)
    if (!prev) return undefined
    const next = settledAs(prev, decision, typed)
    return this.save(next, `${next.status} ${prev.title}`)
  }

  /** The chat's plan cards still waiting, newest first, such as one a restart left up. */
  waitingPlans(chatId: string, projectId: string): Approval[] {
    return (this.store?.approvals({ projectId, pendingOnly: true }) ?? []).filter((a) => a.chatId === chatId && a.kind === 'plan')
  }

  /**
   * Kernel is quitting. Its sessions stop next, and a plan card whose waiter ends on the way keeps its row pending, so it
   * shows again at the next launch. Every other kind still ends as expired (KERNEL-215).
   */
  quitting() {
    this.keepPlans = true
    // The turns stop next and end their waiters, so the chats that waited on the user are written down now for the
    // next launch's note (`waitedOnUser`).
    const waiting = [...this.pending.values()].flatMap((p) => (p.chatId && !p.plan ? [p.chatId] : []))
    this.store?.saveMeta(WAITED, [...new Set(waiting)])
  }

  /**
   * The chat's open turn waited on a tool permission or a question when Kernel last quit or closed, so the agent wasn't
   * working: the user was. Known after `expireStale`, from what a quit wrote down or, after a crash, the rows it expired.
   */
  waitedOnUser(chatId: string): boolean { return this.waited.has(chatId) }

  /** Change a saved approval and tell every window, for example to link a plan step to the workspace it was handed to. */
  update(id: string, patch: Partial<Approval>): Approval | undefined {
    const prev = this.store?.approval(id)
    if (!prev) return undefined
    const next = { ...prev, ...patch }
    this.store?.saveApproval(next)
    bus.push({ type: 'approval', approval: next })
    return next
  }

  /**
   * At start: every approval saved as pending belongs to an earlier run, whose waiter is gone, so nobody can answer it
   * (D-137). Each one is marked expired, except a plan whose chat is still open in a workspace that isn't archived: it
   * shows again, and its answer goes to the chat as a message (plan-cards-survive-restart). Call before
   * `Notifications.attach()`, which then settles their rows.
   */
  expireStale(): Approval[] {
    const stale = (this.store?.approvals({ pendingOnly: true }) ?? []).filter((a) => !this.pending.has(a.id) && !this.outlivesQuit(a))
    const crashed = stale.flatMap((a) => (a.chatId && !isPlan(a) ? [a.chatId] : []))
    this.waited = new Set([...(this.store?.meta<string[]>(WAITED) ?? []), ...crashed])
    this.store?.saveMeta(WAITED, [])
    return stale.map((a) => this.expire(a, this.staleBy(a)))
  }

  /** Why a plan from an earlier run can't show again: its workspace was archived or its chat closed meanwhile. */
  private staleBy(a: Approval): ExpiredBy | undefined {
    if (!isPlan(a) || !a.chatId || !this.store) return undefined
    const chat = this.store.chat(a.chatId)
    if (chat && this.store.workspace(chat.workspaceId)?.status === 'archived') return 'archived'
    return chat?.closed ? 'closed' : undefined
  }

  private outlivesQuit(a: Approval): boolean {
    if (a.kind !== 'plan' || !a.chatId || !this.store) return false
    const chat = this.store.chat(a.chatId)
    const ws = chat && this.store.workspace(chat.workspaceId)
    return !!chat && !chat.closed && !!ws && ws.status !== 'archived'
  }

  /**
   * An archived workspace's pending approvals end (D-137). One with a waiter resolves null, so its session or hook falls
   * back instead of waiting on a workspace that is gone.
   */
  expireWorkspace(workspaceId: string): Approval[] {
    return (this.store?.approvals({ workspaceId, pendingOnly: true }) ?? []).map((a) => this.finish(a.id, null, 'expired', { by: 'archived' }) ?? this.expire(a, 'archived'))
  }

  /**
   * The turn or the session that put these approvals up is gone (KERNEL-563). Each one still pending ends as expired: one
   * with a waiter resolves null, as in `expireWorkspace`, and one left without a waiter is marked expired. One already
   * answered keeps its answer. A quit leaves them to `expirePending`. `by` is why, which a plan card keeps (`expiredBy`).
   */
  expireIds(ids: Iterable<string>, by?: ExpiredBy): Approval[] {
    if (this.closed) return []
    return [...ids].flatMap((id) => {
      const ended = this.finish(id, null, 'expired', { by })
      if (ended) return [ended]
      const row = this.store?.approval(id)
      return row?.status === 'pending' ? [this.expire(row, by)] : []
    })
  }

  /**
   * Kernel is quitting: every approval still waiting ends as expired, while the database is still open, and its waiter
   * resolves null, so a hook falls back to Claude Code's own prompt. An abort that arrives after the database closes,
   * as a dropped hook connection's does, then finds nothing pending. Requests after this answer null at once without
   * saving anything (KERNEL-215). A plan's waiter resolves null too, and its row stays pending for the next launch.
   */
  expirePending(): Approval[] {
    this.keepPlans = true
    this.closed = true
    return [...this.pending.keys()].flatMap((id) => this.finish(id, null, 'expired') ?? [])
  }

  private expire(a: Approval, by?: ExpiredBy): Approval {
    return this.save({ ...a, status: 'expired', ...expiredBy(a, by) }, `expired ${a.title}`)
  }

  private save(next: Approval, text: string): Approval {
    this.store?.saveApproval(next)
    bus.push({ type: 'approval', approval: next })
    bus.activity({ kind: 'approval.decided', projectId: next.projectId, workspaceId: next.workspaceId, agentId: next.agentId, text, object: next.toolName })
    return next
  }

  private finish(id: string, decision: Decision | null, status: Approval['status'], o: { by?: ExpiredBy; typed?: Typed } = {}): Approval | undefined {
    const p = this.pending.get(id)
    if (!p) return undefined
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve(decision)
    const prev = this.store?.approval(id)
    if (!prev) return undefined
    if (!decision && this.keepPlans && prev.kind === 'plan') return undefined
    if (!decision) return this.save({ ...prev, status, ...expiredBy(prev, o.by) }, `${status} ${prev.title}`)
    const answers = decision.behavior === 'answer' ? decision.answers ?? prev.answers : prev.answers
    return this.save({ ...prev, status, ...answerOf(prev, decision, o.typed), answers }, `${status} ${prev.title}`)
  }
}

/** The meta key `quitting` writes the chats that waited on the user to. */
const WAITED = 'waitedOnUser'

/** Only a plan card says why it expired. */
const expiredBy = (a: Approval, by?: ExpiredBy): Pick<Approval, 'expiredBy'> => (by && isPlan(a) ? { expiredBy: by } : {})

/** A waiting plan as `settle` saves it, so its answer can go in the chat before Kernel's message does. */
export function settledAs(prev: Approval, decision: Decision, typed?: Typed): Approval {
  const status = decision.behavior === 'allow' ? 'allowed' : decision.behavior === 'deny' ? 'denied' : 'answered'
  return { ...prev, status, ...answerOf(prev, decision, typed) }
}

/**
 * What the row keeps as the user's answer: an answer's text, or the notes and images of Request changes on a plan, which
 * the chat shows as the user's.
 */
function answerOf(prev: Approval, decision: Decision, typed?: Typed): Pick<Approval, 'answer' | 'images'> {
  if (decision.behavior === 'answer') return { answer: decision.text }
  if (decision.behavior === 'deny' && isPlan(prev)) {
    return { answer: (typed?.notes ?? decision.message)?.trim() || undefined, ...(typed?.images?.length ? { images: typed.images } : {}) }
  }
  return { answer: prev.answer }
}

/** Tools that are a question to the user, not a permission. No setting may answer them for the user. */
export const needsUser = (toolName: string) => toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion'

/** "T-15a PDF renderer · Noor" becomes a step with the agent's id. Lines without a known name stay as plain text. */
export function parsePlanSteps(lines: string[], agents: { id: string; name: string }[]): PlanStep[] {
  return lines.map((line) => {
    const at = line.lastIndexOf(' · ')
    const agent = at < 0 ? undefined : agents.find((a) => a.name.toLowerCase() === line.slice(at + 3).trim().toLowerCase() || a.id === line.slice(at + 3).trim().toLowerCase())
    const title = agent ? line.slice(0, at).trim() : line.trim()
    const id = /^(T-\d+[a-z]?)\b/.exec(title)?.[1]
    return { title, ...(id ? { taskId: id } : {}), ...(agent ? { agentId: agent.id } : {}) }
  })
}

/**
 * Short human title for a tool call, used in the Inbox, on Home and in notifications, which put "Noor wants to" before it.
 * It is the chat row's sentence in the verb's base form, "File issue in Linear: Export invoices as PDF" (KERNEL-785), with
 * a file's folder kept so the user sees which file. Bash shows the exact command the user is allowing, and WebFetch the
 * whole address.
 */
export function describeTool(toolName: string, input: unknown): { title: string; detail?: string } {
  const i = (input ?? {}) as Record<string, any>
  if (toolName === 'Bash') return { title: `Run ${String(i.command ?? '').split('\n')[0].slice(0, 80)}`, detail: i.description }
  const view = toolView({ name: toolName, input: i, status: 'running' })
  const ask = toolAsk(toolName, i)
  const title = view.dir && view.object && ask.endsWith(`: ${view.object}`) ? `${ask.slice(0, -view.object.length)}${view.dir}/${view.object}` : ask
  const detail = toolName === 'WebFetch' && typeof i.url === 'string' ? i.url : view.detail
  return detail ? { title, detail } : { title }
}
