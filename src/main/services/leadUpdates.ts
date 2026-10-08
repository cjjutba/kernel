import type { Chat, PrState, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Store } from '../db'
import { bus } from '../bus'
import { UPDATE_HEADER } from './handoff'
import { replyExcerpt } from './notifications'
import type { TurnDone } from './notifications'

/**
 * Tells the Lead what its teammates did (KERNEL-72). Without it, Rowan hands off and never hears back: nobody asks the
 * reviewer when a PR is ready, and nobody tells the user. Events are collected per room and sent as one message once
 * things go quiet, only to a Lead chat that already exists and is idle. A busy, queued or paused Lead gets them later;
 * nothing is dropped except when the room has no Lead chat at all, because then there is nobody to tell.
 */
export interface LeadUpdateDeps {
  store: Store
  enabled: () => boolean
  /** The room's Lead chat when it exists. Never creates one. */
  leadChat: (roomId: string) => Chat | undefined
  /** Whether the workspace is the Lead's own. Its events are never reported back to it. */
  isLead: (ws: Workspace) => boolean
  agentName: (roomId: string, agentId: string) => string | undefined
  /** Sends Kernel's message into the Lead chat. False when the Lead can't take it now (`Sessions.post`). */
  post: (chatId: string, text: string) => boolean
  /** Called after a delivered update, for the room log. */
  delivered?: (roomId: string, chat: Chat, lines: string[]) => void
  /** How long to wait for more events before sending. Five seconds; tests shorten it. */
  delayMs?: number
}

/** PR states GitHub reports. Moving into one of these from none or creating means the PR was just opened. */
const ON_GITHUB: PrState[] = ['draft', 'open', 'checks', 'cifail', 'changes', 'conflict', 'ready', 'merged', 'closed']

/** What a PR state means for the Lead, or nothing when it isn't worth a turn. `pr` is "PR #54", or "the PR" before it has a number. */
function prLine(state: PrState, pr: string): string | undefined {
  switch (state) {
    case 'ready': return `${pr} is ready to merge`
    case 'cifail': return `checks failed on ${pr}`
    case 'changes': return `changes were requested on ${pr}`
    case 'conflict': return `${pr} has conflicts with its base`
    case 'merged': return `${pr} was merged`
    case 'closed': return `${pr} was closed without merging`
    default: return undefined
  }
}

/** The most lines one update carries; older ones are summarized, so a long absence can't flood the Lead. */
const MAX_LINES = 20

export class LeadUpdates {
  private pending = new Map<string, string[]>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** The last PR state seen per workspace, to tell "opened" from a later change. */
  private prev = new Map<string, PrState>()
  private off: () => void = () => undefined

  constructor(private d: LeadUpdateDeps) {}

  attach() {
    for (const w of this.d.store.workspaces()) this.prev.set(w.id, w.prState)
    const on = (e: PushEvent) => { if (e.type === 'pr') this.onPr(e.workspaceId, e.state) }
    bus.on('push', on)
    this.off = () => bus.off('push', on)
  }

  detach() {
    this.off()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** A turn ended. A teammate's finished turn is news for the Lead; the end of the Lead's own turn is a chance to deliver. */
  turnDone(ws: Workspace, chat: Chat, t: TurnDone) {
    if (t.lead || this.d.isLead(ws)) { this.flush(ws.roomId); return }
    if (t.interrupted || t.queued) return
    const reply = [...this.d.store.items(chat.id)].reverse().find((i) => i.kind === 'text')
    const said = reply?.kind === 'text' ? `: "${replyExcerpt(reply.text, 160)}"` : ''
    this.add(ws, t.ok ? `finished a turn${said}` : 'stopped with an error. Open the workspace to see it')
  }

  private onPr(workspaceId: string, state: PrState) {
    const before = this.prev.get(workspaceId) ?? 'none'
    this.prev.set(workspaceId, state)
    const ws = this.d.store.workspace(workspaceId)
    if (!ws || this.d.isLead(ws)) return
    const pr = ws.prNumber ? `PR #${ws.prNumber}` : 'the PR'
    const opened = (before === 'none' || before === 'creating') && ON_GITHUB.includes(state) && state !== 'merged' && state !== 'closed'
    if (opened) this.add(ws, `opened ${pr}${ws.prTitle ? ` "${ws.prTitle}"` : ''}`)
    const line = prLine(state, pr)
    if (line) this.add(ws, line)
  }

  private add(ws: Workspace, what: string) {
    if (!this.d.enabled()) return
    const who = this.d.agentName(ws.roomId, ws.agentId) ?? ws.agentId
    const line = `- ${who} · ${ws.title ?? ws.name} (workspace ${ws.id}): ${what}`
    this.pending.set(ws.roomId, [...(this.pending.get(ws.roomId) ?? []), line])
    const old = this.timers.get(ws.roomId)
    if (old) clearTimeout(old)
    this.timers.set(ws.roomId, setTimeout(() => { this.timers.delete(ws.roomId); this.flush(ws.roomId) }, this.d.delayMs ?? 5000))
  }

  /** Sends what's waiting for the room, if its Lead can take it now. Kernel also calls this on its PR poll, so a pause or a busy Lead only delays it. */
  flush(roomId: string) {
    const lines = this.pending.get(roomId)
    if (!lines?.length || this.timers.has(roomId)) return
    if (!this.d.enabled()) { this.pending.delete(roomId); return }
    const chat = this.d.leadChat(roomId)
    if (!chat) { this.pending.delete(roomId); return }
    const shown = lines.length > MAX_LINES ? [`- ${lines.length - MAX_LINES} earlier updates are left out.`, ...lines.slice(-MAX_LINES)] : lines
    if (!this.d.post(chat.id, [UPDATE_HEADER, ...shown].join('\n'))) return
    this.pending.delete(roomId)
    this.d.delivered?.(roomId, chat, lines)
  }

  flushAll() { for (const roomId of [...this.pending.keys()]) this.flush(roomId) }
}
