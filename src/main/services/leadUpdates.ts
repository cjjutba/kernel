import type { Chat, PrState, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Store } from '../db'
import { bus } from '../bus'
import { UPDATE_HEADER } from './handoff'
import { replyExcerpt } from './notifications'
import type { TurnDone } from './notifications'

/**
 * Tells the Lead what its teammates did (KERNEL-72). Without it, Rowan hands off and never hears back: nobody asks the
 * reviewer when a PR is ready, and nobody tells the user. Events are collected per Lead chat, the one that handed the
 * workspace off (KERNEL-105), and sent as one message once things go quiet, only to a Lead chat that already exists and
 * is idle. A busy, queued or paused chat gets them later, and doesn't hold up the others. Nothing is dropped except when
 * the room has no open Lead chat at all, because then there is nobody to tell.
 */
export interface LeadUpdateDeps {
  store: Store
  enabled: () => boolean
  /**
   * The open Lead chat that hears about workspaces handed off in `owner`, or about workspaces no Lead chat handed off
   * when `owner` is unset. `closed` is the owner when it is closed and its updates go to another chat. Undefined when
   * the room has no open Lead chat. Never creates one.
   */
  target: (roomId: string, owner?: string) => { chat: Chat; closed?: Chat } | undefined
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

/** One event, numbered so a message that mixes several chats' events still knows which are newest. */
interface Line { n: number; text: string }

/** Events waiting for one Lead chat, or for a room's first Lead chat when `owner` is unset. */
interface Pending { roomId: string; owner?: string; lines: Line[] }

export class LeadUpdates {
  /** Keyed by the owning Lead chat's id, or `room:<id>` for workspaces no Lead chat handed off. */
  private pending = new Map<string, Pending>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** The last PR state seen per workspace, to tell "opened" from a later change. */
  private prev = new Map<string, PrState>()
  private seq = 0
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
    const key = ws.leadChatId ?? `room:${ws.roomId}`
    const p = this.pending.get(key) ?? { roomId: ws.roomId, owner: ws.leadChatId, lines: [] }
    p.lines.push({ n: this.seq++, text: `- ${who} · ${ws.title ?? ws.name} (workspace ${ws.id}): ${what}` })
    this.pending.set(key, p)
    const old = this.timers.get(key)
    if (old) clearTimeout(old)
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); this.flush(ws.roomId) }, this.d.delayMs ?? 5000))
  }

  /**
   * Sends what's waiting in the room to each Lead chat that can take it now, one message per chat. A chat waits until
   * every batch headed for it has gone quiet, so a closed chat's updates ride along with its own. Kernel also calls this
   * on its PR poll, so a pause or a busy Lead chat only delays its own updates.
   */
  flush(roomId: string) {
    const waiting = [...this.pending].filter(([, p]) => p.roomId === roomId && p.lines.length)
    if (!waiting.length) return
    if (!this.d.enabled()) { for (const [key] of waiting) if (!this.timers.has(key)) this.pending.delete(key); return }
    const byChat = new Map<string, { chat: Chat; own: Line[]; closed: { chat: Chat; lines: Line[] }[]; keys: string[]; quiet: boolean }>()
    for (const [key, p] of waiting) {
      const t = this.d.target(roomId, p.owner)
      if (!t) { if (!this.timers.has(key)) this.pending.delete(key); continue }
      const group = byChat.get(t.chat.id) ?? { chat: t.chat, own: [], closed: [], keys: [], quiet: true }
      if (t.closed) group.closed.push({ chat: t.closed, lines: p.lines })
      else group.own.push(...p.lines)
      group.keys.push(key)
      group.quiet &&= !this.timers.has(key)
      byChat.set(t.chat.id, group)
    }
    for (const g of byChat.values()) {
      if (!g.quiet) continue
      const all = [...g.own, ...g.closed.flatMap((c) => c.lines)]
      const kept = new Set([...all].sort((a, b) => b.n - a.n).slice(0, MAX_LINES).map((l) => l.n))
      const shown = all.length > kept.size ? [`- ${all.length - kept.size} earlier updates are left out.`] : []
      shown.push(...g.own.filter((l) => kept.has(l.n)).map((l) => l.text))
      for (const c of g.closed) {
        const lines = c.lines.filter((l) => kept.has(l.n))
        if (lines.length) shown.push(`From "${c.chat.title}", a Lead chat that is now closed:`, ...lines.map((l) => l.text))
      }
      if (!this.d.post(g.chat.id, [UPDATE_HEADER, ...shown].join('\n'))) continue
      for (const key of g.keys) this.pending.delete(key)
      this.d.delivered?.(roomId, g.chat, all.map((l) => l.text))
    }
  }

  flushAll() { for (const roomId of new Set([...this.pending.values()].map((p) => p.roomId))) this.flush(roomId) }
}
