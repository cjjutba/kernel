import type { AgentDef, Chat, PrState, TeamEventKind, TeamUpdate, TeamUpdateRow, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Store } from '../db'
import { bus } from '../bus'
import { UPDATE_HEADER } from './handoff'
import type { TurnDone } from './notifications'
import type { TurnBy } from './sessions'
import { capText } from './text'

/**
 * Tells the Lead what its teammates did (KERNEL-72). Without it, Rowan hands off and never hears back: nobody asks the
 * reviewer when a PR is ready, and nobody tells the user. Events are collected per Lead chat, the one that handed the
 * workspace off (KERNEL-105), and sent as one message once things go quiet, only to a Lead chat that already exists and
 * is idle. A busy, queued or paused chat gets them later, and doesn't hold up the others. Nothing is dropped except when
 * the room has no open Lead chat at all, because then there is nobody to tell.
 *
 * Events are typed (KERNEL-117). At send time each workspace's events collapse into one block, a PR state the PR has
 * already left is dropped, and the message carries the Team update card's data next to the text the Lead reads.
 *
 * Only events that need the Lead start a turn (KERNEL-121): a failure, a question, a PR to review or to merge, the last
 * merge of a plan. The rest wait and go out with the next update that does, so the Lead isn't woken to say "I'll wait".
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
  /** Sends Kernel's message into the Lead chat, with the card's data. False when the Lead can't take it now (`Sessions.post`). */
  post: (chatId: string, text: string, update: TeamUpdate) => boolean
  /** Called after a delivered update, for the room log. */
  delivered?: (roomId: string, chat: Chat, update: TeamUpdate) => void
  /** What Kernel knows about reviews of the workspace's PR. Unknown until reviews are linked (KERNEL-130). */
  reviewState?: (ws: Workspace) => ReviewState | undefined
  /** The team's reviewer, the first agent with a review role that isn't the Lead. */
  reviewer?: (roomId: string) => AgentDef | undefined
  /** How long to wait for more events before sending. Five seconds; tests shorten it. */
  delayMs?: number
}

/** One thing that happened in a teammate's workspace, kept until it reaches the Lead. */
export interface TeamEvent {
  /** Order across every chat's events, so a message that mixes several knows which are newest. */
  n: number
  workspaceId: string
  kind: TeamEventKind
  /** The PR's number and title when it happened. */
  pr?: number
  prTitle?: string
  /** A finished turn: the teammate's last reply. */
  reply?: string
  /** Who started the teammate's turn. */
  by?: TurnBy
}

/** Events waiting for one Lead chat, or for a room's first Lead chat when `owner` is unset. */
interface Pending { roomId: string; owner?: string; events: TeamEvent[] }

/** PR states GitHub reports. Moving into one of these from none or creating means the PR was just opened. */
const ON_GITHUB: PrState[] = ['draft', 'open', 'checks', 'cifail', 'changes', 'conflict', 'ready', 'merged', 'closed']

/** PR states worth telling the Lead about, and the event each one is. */
const PR_EVENT: Partial<Record<PrState, TeamEventKind>> = { ready: 'pr.ready', cifail: 'pr.cifail', changes: 'pr.changes', conflict: 'pr.conflict', merged: 'pr.merged', closed: 'pr.closed' }

/** The PR state a state event stands for. Only the last of these counts, and only while the PR is still in it. */
const STATE_OF: Partial<Record<TeamEventKind, PrState>> = { 'pr.ready': 'ready', 'pr.cifail': 'cifail', 'pr.changes': 'changes', 'pr.conflict': 'conflict' }

/** How a turn ended. Only the last of these counts. */
const TURN_ENDS = new Set<TeamEventKind>(['turn', 'error', 'crash'])

/** Events that say something only once. */
const ONCE = new Set<TeamEventKind>(['pr.opened', 'pr.merged', 'pr.closed'])

/** The most workspaces one update carries. Older ones are counted, so a long absence can't flood the Lead. */
const MAX_BLOCKS = 8

/** A reply is cut to this many characters, and all of one message's replies share `REPLY_BUDGET`. */
const REPLY_MAX = 1500
const REPLY_BUDGET = 6000

/** A reply is kept up to this long while it waits, so the saved queue stays small. */
const REPLY_KEPT = 4000

/** "PR #54", or "the PR" before it has a number. */
const prOf = (e: TeamEvent) => (e.pr ? `PR #${e.pr}` : 'the PR')
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The event as a sentence for the Lead. */
function sentence(e: TeamEvent, name: string): string {
  const pr = prOf(e)
  switch (e.kind) {
    case 'pr.opened': return `Opened ${e.pr ? `PR #${e.pr}` : 'a pull request'}${e.prTitle ? ` "${e.prTitle}"` : ''}.`
    case 'pr.ready': return `${upper(pr)} passed checks and has no conflicts.`
    case 'pr.cifail': return `Checks failed on ${pr}.`
    case 'pr.changes': return `Changes were requested on ${pr}.`
    case 'pr.conflict': return `${upper(pr)} has conflicts with its base branch.`
    case 'pr.merged': return `${upper(pr)} was merged.`
    case 'pr.closed': return `${upper(pr)} was closed without merging.`
    case 'turn': return 'Finished a turn.'
    case 'error': return 'Stopped with an error. Open the workspace to see it.'
    case 'crash': return `${name}'s session ended unexpectedly.`
    case 'setup.failed': return `Setup failed, so ${name} hasn't started.`
    case 'setup.passed': return `Setup passed, and ${name} started.`
    case 'review': return 'Sent a review.'
  }
}

/** The event in a few words, for the card. */
function cardText(e: TeamEvent): string {
  switch (e.kind) {
    case 'pr.opened': return e.pr ? `Opened PR #${e.pr}` : 'Opened a pull request'
    case 'pr.ready': return 'Passed checks, no conflicts'
    case 'pr.cifail': return 'Checks failed'
    case 'pr.changes': return 'Changes requested'
    case 'pr.conflict': return 'Has conflicts with its base branch'
    case 'pr.merged': return e.pr ? `Merged PR #${e.pr}` : 'Merged'
    case 'pr.closed': return `Closed ${prOf(e)} without merging`
    case 'turn': return 'Finished a turn'
    case 'error': return 'Stopped with an error'
    case 'crash': return 'Session ended unexpectedly'
    case 'setup.failed': return 'Setup failed'
    case 'setup.passed': return 'Setup passed'
    case 'review': return 'Sent a review'
  }
}

/**
 * One workspace's events as they are worth sending now, oldest first: the last turn end, PR events once, and the last PR
 * state event only while the PR is still in that state. A checks failure fixed since, or a ready PR whose checks run
 * again, says nothing.
 */
export function collapse(events: TeamEvent[], ws: Workspace | undefined): TeamEvent[] {
  const sorted = [...events].sort((a, b) => a.n - b.n)
  const last = (test: (e: TeamEvent) => boolean) => sorted.filter(test).at(-1)
  const turn = last((e) => TURN_ENDS.has(e.kind))
  const state = last((e) => !!STATE_OF[e.kind])
  const setup = last((e) => e.kind === 'setup.failed' || e.kind === 'setup.passed')
  const review = last((e) => e.kind === 'review')
  // Once per PR: after Continue moved the workspace on, its new PR's opening is news too.
  const seen = new Set<string>()
  return sorted.filter((e) => {
    if (TURN_ENDS.has(e.kind)) return e === turn
    // Without the workspace, as while events wait, the last state event is kept whatever the PR does next.
    if (STATE_OF[e.kind]) return e === state && (!ws || ws.prState === STATE_OF[e.kind])
    if (e.kind === 'setup.failed' || e.kind === 'setup.passed') return e === setup
    if (e.kind === 'review') return e === review
    if (ONCE.has(e.kind)) { const key = `${e.kind}:${e.pr ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true }
    return true
  })
}

/** One workspace in an update. `from` is the closed Lead chat it came from, when it isn't the target's own; `owner` handed it off. */
interface Block { ws: Workspace; name: string; events: TeamEvent[]; reply?: string; latest: number; from?: Chat; owner?: string; wake: Set<TeamEvent>; todo: string[] }

/** Events from one source chat: the target's own, or a closed chat's that now go to the target. `owner` handed them off. */
interface Source { events: TeamEvent[]; from?: Chat; owner?: string }

/** Reviews of a workspace's PR as Kernel knows them (KERNEL-130). */
export interface ReviewState {
  /** Reviewers whose verdict on the PR's latest commit approved it. */
  approvedBy: string[]
  /** A verdict on the latest commit found blockers. */
  blockers: boolean
  /** A linked review workspace is setting up or working. */
  inProgress: boolean
}

/** PR states that mean the PR is still being created or checked, so a turn that just ended isn't news on its own. */
const SETTLING: PrState[] = ['creating', 'checks', 'resolving', 'merging']

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
    if (!t.ok) { this.add(ws, { kind: 'error', by: t.by }); return }
    const reply = [...this.d.store.items(chat.id)].reverse().find((i) => i.kind === 'text')
    this.add(ws, { kind: 'turn', by: t.by, reply: reply?.kind === 'text' ? capText(reply.text, REPLY_KEPT) : undefined })
  }

  private onPr(workspaceId: string, state: PrState) {
    const before = this.prev.get(workspaceId) ?? 'none'
    this.prev.set(workspaceId, state)
    const ws = this.d.store.workspace(workspaceId)
    if (!ws || this.d.isLead(ws)) return
    const opened = (before === 'none' || before === 'creating') && ON_GITHUB.includes(state) && state !== 'merged' && state !== 'closed'
    if (opened) this.add(ws, { kind: 'pr.opened' })
    const kind = PR_EVENT[state]
    if (kind) this.add(ws, { kind })
    // A PR that moved on without news, as checks starting again, still waits for things to settle before its events go.
    else if (!opened) this.rearm(ws)
  }

  private keyOf(ws: Workspace) { return ws.leadChatId ?? `room:${ws.roomId}` }

  private add(ws: Workspace, e: Omit<TeamEvent, 'n' | 'workspaceId' | 'pr' | 'prTitle'>) {
    if (!this.d.enabled()) return
    const key = this.keyOf(ws)
    const p = this.pending.get(key) ?? { roomId: ws.roomId, owner: ws.leadChatId, events: [] }
    p.events.push({ ...e, n: this.seq++, workspaceId: ws.id, ...(ws.prNumber ? { pr: ws.prNumber } : {}), ...(ws.prTitle ? { prTitle: ws.prTitle } : {}) })
    // Events that wait for something to wake the Lead can wait a long time. Only what could still be sent is kept, so a
    // workspace holds a handful of events however long it waits (KERNEL-121).
    const mine = p.events.filter((x) => x.workspaceId === ws.id)
    const kept = new Set(collapse(mine, undefined))
    p.events = p.events.filter((x) => x.workspaceId !== ws.id || kept.has(x))
    this.pending.set(key, p)
    this.arm(key, ws.roomId)
  }

  private arm(key: string, roomId: string) {
    const old = this.timers.get(key)
    if (old) clearTimeout(old)
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); this.flush(roomId) }, this.d.delayMs ?? 5000))
  }

  /** Waits again for a workspace with events still pending. */
  private rearm(ws: Workspace) {
    const key = this.keyOf(ws)
    if (this.pending.get(key)?.events.some((e) => e.workspaceId === ws.id)) this.arm(key, ws.roomId)
  }

  /**
   * Sends what's waiting in the room to each Lead chat that can take it now, one message per chat. A chat waits until
   * every batch headed for it has gone quiet, so a closed chat's updates ride along with its own. Kernel also calls this
   * on its PR poll, so a pause or a busy Lead chat only delays its own updates.
   */
  flush(roomId: string) {
    const waiting = [...this.pending].filter(([, p]) => p.roomId === roomId && p.events.length)
    if (!waiting.length) return
    if (!this.d.enabled()) { for (const [key] of waiting) if (!this.timers.has(key)) this.pending.delete(key); return }
    const byChat = new Map<string, { chat: Chat; sources: Source[]; keys: string[]; quiet: boolean }>()
    for (const [key, p] of waiting) {
      const t = this.d.target(roomId, p.owner)
      if (!t) { if (!this.timers.has(key)) this.pending.delete(key); continue }
      const group = byChat.get(t.chat.id) ?? { chat: t.chat, sources: [], keys: [], quiet: true }
      group.sources.push({ events: p.events, from: t.closed, owner: p.owner })
      group.keys.push(key)
      group.quiet &&= !this.timers.has(key)
      byChat.set(t.chat.id, group)
    }
    for (const g of byChat.values()) {
      if (!g.quiet) continue
      const message = this.compose(roomId, g.sources)
      // Everything that waited was overtaken, as a failed check fixed since. There is nothing left to say.
      if (!message) { for (const key of g.keys) this.pending.delete(key); continue }
      // Nothing needs the Lead yet. It all waits for the next update that does (KERNEL-121).
      if (!message.wakes) continue
      if (!this.d.post(g.chat.id, message.text, message.update)) continue
      for (const key of g.keys) this.pending.delete(key)
      this.d.delivered?.(roomId, g.chat, message.update)
    }
  }

  flushAll() { for (const roomId of new Set([...this.pending.values()].map((p) => p.roomId))) this.flush(roomId) }

  /**
   * The text the Lead reads and the card's data, or nothing when no workspace has anything left to say. `wakes` is
   * whether any of it needs the Lead now.
   */
  private compose(roomId: string, sources: Source[]): { text: string; update: TeamUpdate; wakes: boolean } | undefined {
    const blocks: Block[] = []
    for (const source of sources) {
      const byWs = new Map<string, TeamEvent[]>()
      for (const e of source.events) byWs.set(e.workspaceId, [...(byWs.get(e.workspaceId) ?? []), e])
      for (const [id, events] of byWs) {
        const ws = this.d.store.workspace(id)
        if (!ws || this.d.isLead(ws)) continue
        const kept = collapse(events, ws)
        if (!kept.length) continue
        const turn = kept.find((e) => e.kind === 'turn')
        const name = this.d.agentName(roomId, ws.agentId) ?? ws.agentId
        const block: Block = { ws, name, events: kept, reply: turn?.reply, latest: Math.max(...events.map((e) => e.n)), from: source.from, owner: source.owner, wake: new Set(), todo: [] }
        if (source.owner) {
          const decided = decide({ ws, name, events: kept, fromChat: source.from?.title }, {
            review: this.d.reviewState?.(ws), reviewer: this.d.reviewer?.(ws.roomId), allMerged: () => this.allMerged(ws.roomId, source.owner!)
          })
          block.wake = decided.wake
          block.todo = decided.todo
        }
        blocks.push(block)
      }
    }
    if (!blocks.length) return undefined
    // Blocks that need the Lead come first, then the newest of the rest.
    const rank = (b: Block) => (b.wake.size ? 1 : 0)
    const kept = [...blocks].sort((a, b) => rank(b) - rank(a) || b.latest - a.latest).slice(0, MAX_BLOCKS).sort((a, b) => a.latest - b.latest)
    const omitted = blocks.length - kept.length
    const replies = kept.filter((b) => b.reply).length
    const max = Math.min(REPLY_MAX, Math.floor(REPLY_BUDGET / Math.max(1, replies)))
    const shown = kept.map((b) => ({ ...b, reply: b.reply ? capText(b.reply, max) : undefined }))

    // The target's own work first, then each closed chat's under its name. The card's rows follow the same order.
    const lines: string[] = [UPDATE_HEADER]
    const order: Block[] = []
    for (const b of shown.filter((x) => !x.from)) { lines.push('', ...blockLines(b)); order.push(b) }
    for (const from of [...new Set(shown.map((b) => b.from).filter((c): c is Chat => !!c))]) {
      lines.push('', `From "${from.title}", a Lead chat that is now closed. This work is yours now.`)
      for (const b of shown.filter((x) => x.from === from)) { lines.push('', ...blockLines(b)); order.push(b) }
    }
    if (omitted) lines.push('', `Kernel left out updates on ${omitted} more ${omitted === 1 ? 'workspace' : 'workspaces'}. Call list_workspaces to see where they stand.`)
    const todo = [...new Set(order.flatMap((b) => b.todo))]
    if (todo.length) lines.push('', 'To do:', ...todo.map((t) => `- ${t}`))

    const rows = order.map((b): TeamUpdateRow => {
      const prNumber = b.ws.prNumber ?? b.events.find((e) => e.pr)?.pr
      return {
        workspaceId: b.ws.id, agentId: b.ws.agentId, name: b.name, task: b.ws.title ?? b.ws.name,
        ...(prNumber ? { prNumber } : {}),
        events: b.events.map((e) => ({ kind: e.kind, text: cardText(e), actionable: b.wake.has(e) })),
        ...(b.reply ? { reply: b.reply } : {}),
        ...(b.from ? { fromChat: b.from.title } : {})
      }
    })
    const allMerged = order.some((b) => b.events.some((e) => e.kind === 'pr.merged' && b.wake.has(e)))
    return { text: lines.join('\n'), update: { rows, ...(omitted ? { omitted } : {}), ...(allMerged ? { allMerged } : {}) }, wakes: order.some((b) => b.wake.size > 0) }
  }

  /**
   * Every workspace the Lead chat `owner` handed off has merged. Left out: review workspaces, the Lead's own, work archived
   * without merging, and the reviewer's own workspaces that never opened a PR, which before the review link (KERNEL-130)
   * are reviews nothing marks as such.
   */
  private allMerged(roomId: string, owner: string): boolean {
    const reviewer = this.d.reviewer?.(roomId)?.id
    const handed = this.d.store.workspaces(roomId).filter((w) => w.leadChatId === owner && !w.reviewOf && !this.d.isLead(w)
      && (w.status !== 'archived' || !!w.mergedAt) && !(w.agentId === reviewer && !w.prNumber))
    return handed.length > 0 && handed.every((w) => w.prState === 'merged' || !!w.mergedAt)
  }
}

/** What `decide` needs to know beyond the events: reviews of the PR, the team's reviewer, and whether this merge was the last. */
export interface WakeContext { review?: ReviewState; reviewer?: AgentDef; allMerged: () => boolean }

/**
 * Which of one workspace's events need the Lead, and what to do about each (KERNEL-121). Called only for work a Lead chat
 * handed off. A turn the user started in the teammate's own chat, and an error in one, are between them and never wake it.
 * `fromChat` is the closed Lead chat the work came from, for the merge line.
 */
export function decide(b: { ws: Workspace; name: string; events: TeamEvent[]; fromChat?: string }, c: WakeContext): { wake: Set<TeamEvent>; todo: string[] } {
  const { ws, name } = b
  const out = { wake: new Set<TeamEvent>(), todo: [] as string[] }
  const at = `(workspace ${ws.id})`
  for (const e of b.events) {
    const pr = e.pr ? `PR #${e.pr}` : 'the PR'
    const wake = (todo: string) => { out.wake.add(e); out.todo.push(todo) }
    switch (e.kind) {
      case 'error': if (e.by !== 'user') wake(`${name} stopped with an error. Ask ${name} what happened with message_agent ${at}, or tell the user.`); break
      case 'crash': wake(`${name}'s session ended. Tell the user they can restart it from the workspace.`); break
      case 'setup.failed': wake(`Setup failed in ${name}'s workspace. Tell the user to fix it and click Run again there.`); break
      case 'review': wake(`Read ${name}'s review and pass on what it found.`); break
      case 'pr.cifail': wake(`Tell ${name} about the failed checks on ${pr} with message_agent ${at}.`); break
      case 'pr.changes': wake(`Tell ${name} about the changes requested on ${pr} with message_agent ${at}.`); break
      case 'pr.conflict': wake(`Ask ${name} to resolve the conflicts on ${pr} with message_agent ${at}.`); break
      case 'pr.closed': if (ws.prState === 'closed') wake(`${upper(pr)} was closed without merging. Ask the user whether ${name}'s work is still wanted.`); break
      case 'pr.merged':
        if (c.allMerged()) wake(b.fromChat ? `Every task handed off in the closed Lead chat "${b.fromChat}" has merged. Tell the user in one line.` : ALL_MERGED)
        break
      case 'pr.ready': {
        const review = c.review
        if (review?.blockers || review?.inProgress) break
        if (review?.approvedBy.length) { wake(`${upper(pr)} passed checks, has no conflicts and ${review.approvedBy.join(' and ')} approved it. Tell the user it is ready to merge.`); break }
        if (!c.reviewer) { wake(`${upper(pr)} passed checks and has no conflicts. No reviewer is on this team, so tell the user it is ready for them to review and merge.`); break }
        wake(`${upper(pr)} needs a review. ${c.reviewer.name} (${c.reviewer.id}) reviews on this team: hand it over with create_workspace (agent "${c.reviewer.id}"), unless a review of it is already running.`)
        break
      }
      case 'turn':
        // A turn whose PR is being created or checked, or that a newer PR event follows, has that event to speak for it.
        if (e.by === 'user' || SETTLING.includes(ws.prState) || b.events.some((x) => x.n > e.n && x.kind.startsWith('pr.'))) break
        wake(`Read ${name}'s reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`)
        break
      default: break
    }
  }
  return out
}

/** The To do line once the last task a chat handed off has merged. */
const ALL_MERGED = 'Every task you handed off in this chat has merged. Tell the user in one line.'

/** One workspace's block in the Lead's text: who and what, each event, then the reply quoted. A reply says the turn ended. */
function blockLines(b: Block): string[] {
  const lines = [`${b.name} (${b.ws.agentId}) · ${b.ws.title ?? b.ws.name} · workspace ${b.ws.id}`]
  for (const e of b.events) if (!(e.kind === 'turn' && b.reply)) lines.push(`- ${sentence(e, b.name)}`)
  if (b.reply) {
    lines.push(`- ${b.name}'s last reply:`)
    for (const l of b.reply.split('\n')) lines.push(l.trim() ? `  > ${l}` : '  >')
  }
  return lines
}
