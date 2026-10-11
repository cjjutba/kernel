import type { Chat, Effort, ModelId, Workspace } from '@shared/types'
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
  protected get home() { return this.k['home'] }
  protected get stopped() { return this.k['stopped'] }

  protected mustRoom(id: string) { return records.mustRoom(this.k.store, id) }
  protected mustWs(id: string) { return records.mustWs(this.k.store, id) }
  protected mustChat(chatId: string) { return records.mustChat(this.k.store, chatId) }
  protected chatTabs(workspaceId: string) { return records.chatTabs(this.k.store, workspaceId) }
  protected saveWs(ws: Workspace) { return records.saveWs(this.k.store, ws) }
  protected updateWs(id: string, patch: Partial<Workspace>, o: { archived?: boolean } = {}) { return records.updateWs(this.k.store, id, patch, o) }
  protected saveChat(chat: Chat) { return records.saveChat(this.k.store, chat) }
  protected newChat(workspaceId: string, title: string, o: { model: ModelId; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal'; terminal?: Chat['terminal'] }) { return records.newChat(this.k.store, workspaceId, title, o) }
  protected prChat(id: string) { return records.prChat(this.k.store, id) }
  protected note(workspaceId: string, text: string, pr?: 'merged' | 'closed' | 'cifail') { return records.note(this.k.store, workspaceId, text, pr) }

  // The team's, so code that moves out of kernel.ts keeps calling them as it did (KERNEL-326).
  protected agentsSync(roomId: string) { return this.k.team.agentsSync(roomId) }
  protected isLeadWorkspace(ws: Workspace) { return this.k.team.isLeadWorkspace(ws) }
}
