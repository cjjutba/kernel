import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Chat, ChatPart } from '@shared/types'
import type { TurnBy } from '../services/sessions'
import { seatDir } from '../services/seatLaunch'
import { Feature } from './feature'
import { turnFinished } from './sessionDeps'

/** A pasted message goes in as one bracketed paste, then Enter, so a multi-line message is one prompt. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const ENTER_AFTER_MS = 150

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * What a terminal can be handed as text: the words, and a file that carries its own text (an issue the tracker read). A file
 * that is only a path, or an image, can't be pasted into a prompt, so a hand-off that has one runs in Kernel (KERNEL-1004).
 */
export function pastable(parts: ChatPart[] | undefined): boolean {
  return (parts ?? []).every((p) => p.type === 'text' || (p.type === 'file' && !p.dir && p.text !== undefined))
}

export function partsText(parts: ChatPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? `<${p.name}>\n${p.text ?? ''}\n</${p.name}>` : '')).filter(Boolean).join('\n\n')
}

/**
 * A teammate that runs in a terminal tab instead of Kernel's chat (KERNEL-1004). Its tab is a seat (KERNEL-998) started as
 * `claude "<brief>"`. Kernel writes into it only between turns: a message waits for `Stop`, and only if the user has typed
 * nothing since their last prompt. Memory only, so a restart forgets a message that hadn't gone in.
 */
export class TeammateSeats extends Feature {
  /** Seats in a turn, the ones Kernel started included: they count toward the agent limit. */
  private working = new Set<string>()
  /** Seats whose last turn ended and nothing has started since. */
  private idle = new Set<string>()
  /** Seats whose user typed something since their last prompt. */
  private typed = new Set<string>()
  /** Seats whose next prompt is Kernel's own: the brief or a pasted message. */
  private ours = new Set<string>()
  /** The turn in progress started with a Kernel prompt. */
  private turnBy = new Map<string, TurnBy>()
  private pending = new Map<string, ChatPart[][]>()
  /** Briefs waiting for a free slot, in the order they came. */
  private waiting = new Map<string, ChatPart[]>()

  seatOf(workspaceId: string): Chat | undefined {
    return this.store.chats(workspaceId).find((c) => c.terminal?.handoff && !c.closed)
  }

  /** Starts the seat with the brief, or holds it for a free slot. Returns the reason it waits. */
  async start(chat: Chat, brief: ChatPart[]): Promise<'capacity' | undefined> {
    if (this.sessions.atLimit(chat.id)) { this.waiting.set(chat.id, brief); return 'capacity' }
    await this.launch(chat, brief)
    return undefined
  }

  /** Setup passed or a wait ended: what the chat's queue held (the brief and the Lead's messages) goes out as the brief. */
  async release(chat: Chat) {
    const queue = this.sessions.queued(chat.id)
    const parts = queue.flatMap((m) => m.parts)
    for (const m of queue) this.sessions.unqueue(chat.id, m.id)
    this.sessions.release(chat.id)
    await this.start(chat, parts)
  }

  private async launch(chat: Chat, brief: ChatPart[]) {
    const dir = seatDir(this.o.dataDir, chat.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'brief.txt')
    writeFileSync(file, partsText(brief))
    // The brief is read from a file so no quoting of its words can reach the shell. The command is plain `claude` again once
    // the seat has seen it, so a restart resumes the session and doesn't send the brief twice.
    this.saveChat({ ...this.mustChat(chat.id), terminal: { ...this.mustChat(chat.id).terminal!, command: `claude "$(cat ${quote(file)})"` } })
    await this.k.chats.startSeat(chat.id)
    // After the start: a pty that starts clears what the last one left (`exited`), and the brief is this one's.
    this.ours.add(chat.id)
    this.idle.delete(chat.id)
    this.working.add(chat.id)
  }

  /** The seat's tab got keystrokes from the user. The terminal's own replies (focus, cursor position) are not keystrokes. */
  typedIn(chatId: string, data: string) { if (!/^\x1b\[(?:[IO]|[?\d;]*[Rc])$/.test(data)) this.typed.add(chatId) }
  /** How many seats are in a turn, for the agent limit. */
  busy(except?: string): number { return [...this.working].filter((id) => id !== except).length }

  /** The seat's agent started a turn: its prompt was Kernel's, or the user's. */
  turnStarted(chat: Chat) {
    const id = chat.id
    const mine = this.ours.delete(id)
    this.turnBy.set(id, mine ? 'lead' : 'user')
    this.typed.delete(id)
    this.idle.delete(id)
    this.working.add(id)
    if (mine && chat.terminal?.command !== 'claude') this.saveChat({ ...chat, terminal: { ...chat.terminal!, command: 'claude' } })
  }

  /** The seat's turn ended. The Lead hears of it as of any teammate's, then a message that waited goes in. */
  async turnEnded(chat: Chat) {
    const id = chat.id
    this.working.delete(id)
    this.idle.add(id)
    const by = this.turnBy.get(id) ?? 'user'
    this.turnBy.delete(id)
    // The reply is read from the transcript before the Lead's update looks for it.
    await this.k.chats.transcripts.sync(id).catch(() => undefined)
    const ws = this.store.workspace(chat.workspaceId)
    const now = this.store.chat(id)
    if (ws && now && ws.status !== 'archived') turnFinished(this.k, ws, now, { ok: true, interrupted: false, by })
    this.deliver(id)
    this.startWaiting()
  }

  /** The seat's pty exited or started again. What was waiting to go in stays, for the next time it is between turns. */
  exited(chatId: string) {
    this.working.delete(chatId)
    this.idle.delete(chatId)
    this.typed.delete(chatId)
    this.ours.delete(chatId)
    this.turnBy.delete(chatId)
    this.startWaiting()
  }

  /** A seat's tab closed or its workspace archived: nothing of it is left. */
  gone(chatId: string) {
    this.exited(chatId)
    this.pending.delete(chatId)
    this.waiting.delete(chatId)
    this.startWaiting()
  }

  /** A message for the seat. It goes in at once when the seat is between turns and the user has typed nothing, else at a later Stop. */
  message(chat: Chat, parts: ChatPart[]): 'sent' | 'waiting' {
    const queue = this.pending.get(chat.id) ?? []
    queue.push(parts)
    this.pending.set(chat.id, queue)
    return this.deliver(chat.id) ? 'sent' : 'waiting'
  }

  private deliver(chatId: string): boolean {
    const queue = this.pending.get(chatId)
    if (!queue?.length) return false
    if (!this.idle.has(chatId) || this.typed.has(chatId) || !this.ptys.has(chatId)) return false
    this.pending.delete(chatId)
    this.idle.delete(chatId)
    this.ours.add(chatId)
    const text = queue.map(partsText).join('\n\n')
    this.ptys.write(chatId, `${PASTE_START}${text}${PASTE_END}`)
    setTimeout(() => { if (!this.stopped) this.ptys.write(chatId, '\r') }, ENTER_AFTER_MS)
    return true
  }

  /** Starts the briefs that waited for a slot, as many as now fit. */
  startWaiting() {
    for (const [id, brief] of [...this.waiting]) {
      if (this.sessions.atLimit(id)) return
      this.waiting.delete(id)
      const chat = this.store.chat(id)
      if (chat && !chat.closed) void this.launch(chat, brief).catch(() => undefined)
    }
  }

  /** Whether the seat's brief waits for a free slot. */
  waitsForSlot(chatId: string) { return this.waiting.has(chatId) }
}
