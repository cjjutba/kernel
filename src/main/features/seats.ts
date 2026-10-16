import { rm } from 'node:fs/promises'
import { buildsHere } from '@shared/leadMode'
import type { AgentDef, Chat, Workspace } from '@shared/types'
import { LEAD_INSTRUCTIONS } from '../services/kernelMcp'
import { agentPrompt } from '../services/sessions'
import { removeSeatDir, seatCommand, seatDir, seatsDir, withDirFirst, writeSeatDir, writeSeatSession } from '../services/seatLaunch'
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

  private starting?: Promise<void>

  /** Binds the endpoint, once. Nothing listens until a terminal tab first starts a pty, so a Kernel without one binds no port. */
  start(): Promise<void> {
    return (this.starting ??= (async () => {
      await rm(seatsDir(this.o.dataDir), { recursive: true, force: true }).catch(() => undefined)
      this.http = await startSeatMcp({ registry: this.registry, serve: (seat) => this.serve(seat) })
    })().catch((e) => { this.starting = undefined; throw e }))
  }

  async stop() {
    const starting = this.starting
    this.starting = undefined
    await starting?.catch(() => undefined)
    this.registry.revokeAll()
    await this.http?.close()
    this.http = undefined
    await rm(seatsDir(this.o.dataDir), { recursive: true, force: true }).catch(() => undefined)
  }

  /**
   * What a terminal chat's pty starts with when the seat is connected (KERNEL-998): the chat's id, a new token and the endpoint
   * in its environment, and a folder first on the PATH whose `claude` runs the real one wired into Kernel. `command` is what the
   * tab types, with `claude` spelled as that script, so a login shell that rewrites the PATH still starts the seat. Undefined
   * when Settings, Terminal has connect off, or the chat is not a terminal.
   */
  launch(chatId: string, env: Record<string, string>): { env: Record<string, string>; command: (typed: string | undefined) => string | undefined } | undefined {
    const chat = this.store.chat(chatId)
    const url = this.url
    if (!chat || chat.kind !== 'terminal' || !url || !this.settings.terminal.connect) return undefined
    const ws = this.mustWs(chat.workspaceId)
    const token = this.makeToken(chatId)
    const dir = seatDir(this.o.dataDir, chatId)
    const agent = this.agentFor(ws, chat)
    writeSeatDir(dir, { url, token, prompt: agentPrompt(agent, ws, this.k.tools.rulesFor(ws, agent, chat)), sessionId: chat.sessionId })
    return {
      env: { ...env, PATH: withDirFirst(dir, env.PATH), KERNEL_CHAT_ID: chatId, KERNEL_SEAT_TOKEN: token, KERNEL_MCP_URL: url },
      command: (typed) => (typed === undefined ? undefined : seatCommand(dir, typed))
    }
  }

  /** The session the seat's next `claude` resumes, once the chat has one or another (KERNEL-999 reads it from the hooks). */
  sessionChanged(chatId: string) {
    const chat = this.store.chat(chatId)
    if (chat) writeSeatSession(seatDir(this.o.dataDir, chatId), chat.sessionId)
  }

  closeWorkspace(workspaceId: string, chatIds: string[]) {
    this.registry.revokeWorkspace(workspaceId)
    for (const id of chatIds) removeSeatDir(seatDir(this.o.dataDir, id))
  }

  /** A closed tab's seat: its token and its folder. */
  closeSeat(chatId: string) {
    this.registry.revokeChat(chatId)
    removeSeatDir(seatDir(this.o.dataDir, chatId))
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
    const agent = this.agentFor(ws, chat)
    return { tools: this.k.tools.toolsFor(ws, agent, chat), instructions: agent?.lead ? LEAD_INSTRUCTIONS : undefined }
  }

  private agentFor(ws: Workspace, chat: Chat): AgentDef | undefined {
    return this.k.reviews.agentForChat(ws, chat) || this.k.team.agentOf(ws.projectId, ws.agentId)
  }
}
