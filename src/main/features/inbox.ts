import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Decision } from '@shared/types'
import type { Handlers } from '../kernel'
import { planChanges } from '../services/handoff'
import { attachmentNote, planExists, saveAttachments, savePlan } from '../services/plans'
import { Feature } from './feature'

/** What the Inbox and the activity log read: notifications, approvals, tasks and the log itself (KERNEL-325). */
export class Inbox extends Feature {
  /** A plan's file for Open in editor, written again from the approval when it is missing (D-092). */
  private async planFile(id: string): Promise<{ path: string; relative: string }> {
    const a = this.store.approval(id)
    const text = a ? String(a.detail || (a.input as { plan?: unknown } | undefined)?.plan || '') : ''
    if (!a || !text.trim()) throw new Error('This plan has no text to save.')
    const ws = a.workspaceId ? this.store.workspace(a.workspaceId) : undefined
    if (!ws || !(await stat(ws.path).then(() => true, () => false))) throw new Error('Its workspace folder is gone. Copy the plan instead.')
    if (a.planFile && (await planExists(ws.path, a.planFile))) return { path: join(ws.path, a.planFile), relative: a.planFile }
    const relative = await savePlan(ws.path, text, { fallback: a.title, reuse: a.planFile })
    if (relative !== a.planFile) this.approvals.update(a.id, { planFile: relative })
    return { path: join(ws.path, relative), relative }
  }

  /**
   * A plan's change request with images: saves them in the workspace and names their paths in the message (D-134).
   * A plan is ExitPlanMode or the Lead's `request_plan_approval`, the same test as the composer's `isPlanApproval`.
   */
  private async withAttachments(id: string, decision: Decision): Promise<Decision> {
    if (decision.behavior !== 'deny' || !decision.images?.length) return decision
    const { images, ...rest } = decision
    const a = this.store.approval(id)
    if (!a || (a.kind !== 'plan' && a.toolName !== 'ExitPlanMode') || (!this.approvals.isPending(id) && !this.approvals.waitingPlan(id))) return rest
    const ws = a.workspaceId ? this.store.workspace(a.workspaceId) : undefined
    if (!ws || !(await stat(ws.path).then(() => true, () => false))) throw new Error("The workspace folder is gone, so the images can't be saved.")
    return { ...rest, message: attachmentNote(rest.message, await saveAttachments(ws.path, images)) }
  }

  /**
   * A plan card with no turn left waiting on it, since Kernel restarted (plan-cards-survive-restart). The
   * answer goes to the chat as Kernel's message, which waits in the queue like any other while something holds the chat.
   * Approve leaves plan mode and arms a Lead's hand-off as a live approval does. Request changes names the plan's file,
   * which the revision overwrites.
   */
  private async answerPlan(id: string, decision: Decision) {
    const a = this.approvals.waitingPlan(id)!
    const chat = a.chatId ? this.store.chat(a.chatId) : undefined
    if (!chat || chat.closed) throw new Error('This request already timed out or was answered.')
    // Kernel's message names the approval, so the chat shows the user's answer in its place.
    const typed = decision.behavior === 'deny' ? decision.message ?? '' : undefined
    if (decision.behavior === 'allow') await this.sessions.planApproved(chat.id, { queue: true, restarted: true, approvalId: id })
    else {
      decision = await this.withAttachments(id, decision)
      const notes = (decision.behavior === 'deny' ? decision.message : decision.behavior === 'answer' ? decision.text : undefined)?.trim() || 'no details'
      await this.sessions.send(chat.id, [{ type: 'text', text: planChanges(notes, a.planFile) }], { from: 'kernel', approvalId: id })
    }
    return this.approvals.settle(id, decision, typed)!
  }

  handlers() {
    return {
      'notifications.list': async () => this.notifications.list(),
      'notifications.read': async ({ ids }) => this.notifications.read(ids),
      'approvals.list': async ({ roomId }) => this.store.approvals({ roomId }),
      'approvals.decide': async ({ id, decision }) => {
        if (this.approvals.waitingPlan(id)) return this.answerPlan(id, decision)
        // Request changes keeps what the user typed, without the lines Kernel adds for the images.
        const a = this.approvals.decide(id, await this.withAttachments(id, decision), decision.behavior === 'deny' ? decision.message ?? '' : undefined)
        if (!a) throw new Error('This request already timed out or was answered.')
        return a
      },
      'approvals.planFile': async ({ id }) => this.planFile(id),
      'tasks.list': async ({ roomId }) => this.tasks.list(roomId),
      'activity.recent': async ({ roomId, limit }) => this.store.activity(roomId, limit),
      'rooms.lastActivity': async ({ roomId }) => this.store.lastActivity(roomId)
    } satisfies Partial<Handlers>
  }
}
