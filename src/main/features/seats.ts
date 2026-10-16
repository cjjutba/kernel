import { buildsHere } from '@shared/leadMode'
import { LEAD_INSTRUCTIONS } from '../services/kernelMcp'
import { startSeatMcp, SeatRegistry, type Seat, type SeatMcp, type SeatRole, type SeatTools } from '../services/seatMcp'
import { Feature } from './feature'

/**
 * Terminal seats on Kernel's engine (KERNEL-997). A seat is a terminal chat with a role, and its tools over local HTTP are the
 * ones `Tools.toolsFor` gives that chat, so no tool exists twice. Tokens are made when a seat's pty starts and revoked when
 * its tab closes, its workspace archives and Kernel quits.
 */
export class Seats extends Feature {
  readonly registry = new SeatRegistry()
  private http?: SeatMcp

  async start() { this.http ??= await startSeatMcp({ registry: this.registry, serve: (seat) => this.serve(seat) }) }

  async stop() {
    this.registry.revokeAll()
    await this.http?.close()
    this.http = undefined
  }

  /** Where a seat's `claude` finds the endpoint, once started. */
  get url() { return this.http?.url }

  /** The bearer token for a chat's pty. Its chat's earlier token stops working. */
  makeToken(chatId: string): string {
    const chat = this.mustChat(chatId)
    const ws = this.mustWs(chat.workspaceId)
    return this.registry.make({ chatId, workspaceId: ws.id, role: this.roleOf(chatId) })
  }

  revokeToken(token: string) { return this.registry.revoke(token) }
  revokeChat(chatId: string) { return this.registry.revokeChat(chatId) }
  revokeWorkspace(workspaceId: string) { return this.registry.revokeWorkspace(workspaceId) }

  roleOf(chatId: string): SeatRole {
    const chat = this.mustChat(chatId)
    const ws = this.mustWs(chat.workspaceId)
    if (this.k.team.agentOf(ws.projectId, ws.agentId)?.lead) return buildsHere(ws) ? 'build' : 'lead'
    return 'teammate'
  }

  private serve(seat: Seat): SeatTools | undefined {
    const ws = this.store.workspace(seat.workspaceId)
    const chat = this.store.chat(seat.chatId)
    if (!ws || !chat || chat.workspaceId !== ws.id || ws.status === 'archived') return undefined
    const agent = (chat && this.k.reviews.agentForChat(ws, chat)) || this.k.team.agentOf(ws.projectId, ws.agentId)
    return { tools: this.k.tools.toolsFor(ws, agent, chat), instructions: agent?.lead ? LEAD_INSTRUCTIONS : undefined }
  }
}
