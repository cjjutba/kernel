import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Decision } from '@shared/types'
import type { Handlers } from '../kernel'
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
    if (!a || (a.kind !== 'plan' && a.toolName !== 'ExitPlanMode') || !this.approvals.isPending(id)) return rest
    const ws = a.workspaceId ? this.store.workspace(a.workspaceId) : undefined
    if (!ws || !(await stat(ws.path).then(() => true, () => false))) throw new Error("The workspace folder is gone, so the images can't be saved.")
    return { ...rest, message: attachmentNote(rest.message, await saveAttachments(ws.path, images)) }
  }

  handlers() {
    return {
      'notifications.list': async () => this.notifications.list(),
      'notifications.read': async ({ ids }) => this.notifications.read(ids),
      'approvals.list': async ({ roomId }) => this.store.approvals({ roomId }),
      'approvals.decide': async ({ id, decision }) => { const a = this.approvals.decide(id, await this.withAttachments(id, decision)); if (!a) throw new Error('This request already timed out or was answered.'); return a },
      'approvals.planFile': async ({ id }) => this.planFile(id),
      'tasks.list': async ({ roomId }) => this.tasks.list(roomId),
      'activity.recent': async ({ roomId, limit }) => this.store.activity(roomId, limit),
      'rooms.lastActivity': async ({ roomId }) => this.store.lastActivity(roomId)
    } satisfies Partial<Handlers>
  }
}
