import type { Chat, Effort, Provider, NoteRef, Workspace } from '@shared/types'
import type { Kernel } from '../kernel'
import * as records from './records'

/**
 * What every feature extends (KERNEL-325). It holds the Kernel it was built with and nothing else, so its constructor does
 * no work (R1). Tests build Kernels that never start, and `settings` is undefined until `start()`. The getters read through
 * `k` each time, so a test that swaps `settings` or a service on the instance still reaches the feature. `settings` has no
 * setter on purpose. A write goes to `this.k.settings`.
 */
export abstract class Feature {
  constructor(protected readonly k: Kernel) {}

  protected get store() { return this.k.store }
  protected get sessions() { return this.k.sessions }
  protected get approvals() { return this.k.approvals }
  protected get notifications() { return this.k.notifications }
  protected get tasks() { return this.k.tasks }
  protected get settings() { return this.k.settings }
  protected get o() { return this.k.o }
  protected get home() { return this.k.home }
  protected get stopped() { return this.k.stopped }
  protected get leadUpdates() { return this.k.leadUpdates }
  protected get overlaps() { return this.k.overlaps }
  protected get nudges() { return this.k.nudges }
  protected get ptys() { return this.k.ptys }
  protected get projectIcons() { return this.k.projectIcons }
  protected get shared() { return this.k.shared }
  protected get envStore() { return this.k.envStore }

  protected mustProject(id: string) { return records.mustProject(this.k.store, id) }
  protected mustWs(id: string) { return records.mustWs(this.k.store, id) }
  protected mustChat(chatId: string) { return records.mustChat(this.k.store, chatId) }
  protected chatTabs(workspaceId: string) { return records.chatTabs(this.k.store, workspaceId) }
  protected saveWs(ws: Workspace) { return records.saveWs(this.k.store, ws) }
  protected updateWs(id: string, patch: Partial<Workspace>, o: { archived?: boolean } = {}) { return records.updateWs(this.k.store, id, patch, o) }
  protected saveChat(chat: Chat) { return records.saveChat(this.k.store, chat) }
  protected newChat(workspaceId: string, title: string, o: { provider?: Provider; model: string; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal'; terminal?: Chat['terminal']; threadId?: string }) { return records.newChat(this.k.store, workspaceId, title, o) }
  protected prChat(id: string) { return records.prChat(this.k.store, id) }
  protected note(workspaceId: string, text: string, pr?: records.NotePr, refs?: NoteRef[]) { return records.note(this.k.store, workspaceId, text, pr, refs) }
  protected noteOnce(workspaceId: string, text: string, pr: records.NotePr, prNumber: number | undefined) { return records.noteOnce(this.k.store, workspaceId, text, pr, prNumber) }

  // The team's, so code that moves out of kernel.ts keeps calling them as it did (KERNEL-326).
  protected agentsSync(projectId: string) { return this.k.team.agentsSync(projectId) }
  protected isLeadWorkspace(ws: Workspace) { return this.k.team.isLeadWorkspace(ws) }
}
