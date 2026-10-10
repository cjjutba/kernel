import type { AgentDef, Chat, PrState, ReviewVerdict, TeamEventKind, TeamUpdate, TeamUpdateRow, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Store } from '../db'
import { bus } from '../bus'
import { UPDATE_HEADER } from './handoff'
import type { TurnDone } from './notifications'
import type { TurnBy } from './sessions'
import { capText, firstLine } from './text'
import { isBroken } from './waits'

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
  /** A crash: what Claude Code said as it went, when it said anything. */
  reason?: string
  /** A crash after which a message waiting for the teammate started a new session at once, so it is working again. */
  resumed?: boolean
  /** A failed setup: its exit code, or null when it was stopped. */
  code?: number | null
  /** A failed setup the Lead already heard about in create_workspace's result. It doesn't wake the Lead again. */
  told?: boolean
  /** A review: the verdict, and the work it is about, with its author's name and PR number (KERNEL-130). */
  review?: { verdict: ReviewVerdict['verdict']; summary: string; blockers?: ReviewVerdict['blockers']; total?: number; of: string; ofName: string; ofPr?: number; sha?: string; current: boolean }
  /** A wait on other PRs (KERNEL-259), and on a setup that passed while one stands. */
  wait?: WaitNews
}

/**
 * What a wait event says (KERNEL-259). `label` names the PRs ("PR #164 by Noor"). `held`: the brief hasn't gone out, as
 * opposed to a teammate that already started. `target` and `gone`: the PR that broke the wait and how. `told`: the Lead
 * read it in its own tool's result, so it rides along. `why`: what a teammate that set its own wait said it needs (KERNEL-262).
 */
export interface WaitNews { on: string[]; label: string; held?: boolean; target?: string; gone?: 'closed' | 'archived'; told?: boolean; why?: string }

/** Events waiting for one Lead chat, or for a room's first Lead chat when `owner` is unset. */
interface Pending { roomId: string; owner?: string; events: TeamEvent[] }

/** What waits for the Lead, saved under the meta key `leadUpdates` so a quit doesn't lose it (KERNEL-123). */
interface Saved { v: 1; seq: number; pending: [string, Pending][]; stopped: string[] }
const SAVED = 'leadUpdates'

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

/** A verdict's blockers in one update: the first few, each cut to a few lines. The rest are counted. */
const MAX_BLOCKERS = 10
const BLOCKER_MAX = 300

/** What a teammate says it needs from the PR it waits for, kept this long (KERNEL-262). */
const WHY_MAX = 300

/** "PR #54", or "the PR" before it has a number. */
const prOf = (e: TeamEvent) => (e.pr ? `PR #${e.pr}` : 'the PR')
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The event as a sentence for the Lead. `status` is where a PR that passed checks stands with its review. */
function sentence(e: TeamEvent, name: string, status = ''): string {
  const pr = prOf(e)
  switch (e.kind) {
    case 'pr.opened': return `Opened ${e.pr ? `PR #${e.pr}` : 'a pull request'}${e.prTitle ? ` "${e.prTitle}"` : ''}.`
    case 'pr.ready': return `${upper(pr)} passed checks and has no conflicts.${status ? ` ${status}` : ''}`
    case 'pr.cifail': return `Checks failed on ${pr}.`
    case 'pr.changes': return `Changes were requested on ${pr}.`
    case 'pr.conflict': return `${upper(pr)} has conflicts with its base branch.`
    case 'pr.merged': return `${upper(pr)} was merged.`
    case 'pr.closed': return `${upper(pr)} was closed without merging.`
    case 'turn': return 'Finished a turn.'
    case 'error': return 'Stopped with an error. Open the workspace to see it.'
    case 'crash': return `${name}'s session ended unexpectedly${e.reason ? ` (${e.reason})` : ''}, partway through a turn. ${e.resumed ? `A message waiting for ${name} started a new session, so ${name} is working again.` : 'The worktree and chat are saved; the user can restart it from the workspace.'}`
    case 'setup.failed': return `Setup failed${e.code === null ? ' (it was stopped)' : e.code !== undefined ? ` with exit code ${e.code}` : ''}, so ${name} hasn't started. The brief waits until the user fixes setup and clicks Run again in that workspace.`
    case 'setup.passed': return e.wait ? `Setup passed on Run again. ${name} still waits for ${e.wait.label} to merge, and Kernel sends the brief then.` : `Setup passed on Run again, and ${name}'s brief was released.`
    case 'wait.started': return `Waits for ${e.wait?.label ?? 'another PR'} to merge.${e.wait?.why ? ` ${name} says: ${e.wait.why}` : ''} Kernel ${e.wait?.held === false ? `tells ${name} to rebase onto it` : `sends ${name} the brief`} when it does.`
    case 'wait.released': return `${upper(e.wait?.label ?? 'the PR it waited for')} merged, so Kernel ${e.wait?.held === false ? `told ${name} to rebase onto it and carry on` : `sent ${name} the brief`}.`
    case 'wait.broken': return `${name} is waiting for ${e.wait?.label ?? 'a PR'}, which was ${e.wait?.gone ?? 'closed'} without merging.`
    case 'review': {
      const r = e.review
      if (!r) return 'Sent a review.'
      const what = `${r.ofPr ? `PR #${r.ofPr} by ${r.ofName}` : `${r.ofName}'s work`} (workspace ${r.of})`
      if (r.verdict === 'approved') return `Approved ${what}${r.current ? ', at its latest commit' : ''}.`
      const list = (r.blockers ?? []).map((x, i) => `  ${i + 1}. ${x.file ? `${x.file}${x.line ? `:${x.line}` : ''}: ` : ''}${x.text}`)
      const total = r.total ?? list.length
      return [`Found ${total} ${total === 1 ? 'blocker' : 'blockers'} in ${what}${total > list.length ? ` (the first ${list.length} below)` : ''}:`, ...list].join('\n')
    }
  }
}

/** The event in a few words, for the card. */
function cardText(e: TeamEvent, status = ''): string {
  switch (e.kind) {
    case 'pr.opened': return e.pr ? `Opened PR #${e.pr}` : 'Opened a pull request'
    case 'pr.ready': return `Passed checks, no conflicts${status ? `. ${status.replace(/\.$/, '')}` : ''}`
    case 'pr.cifail': return 'Checks failed'
    case 'pr.changes': return 'Changes requested'
    case 'pr.conflict': return 'Has conflicts with its base branch'
    case 'pr.merged': return e.pr ? `Merged PR #${e.pr}` : 'Merged'
    case 'pr.closed': return `Closed ${prOf(e)} without merging`
    case 'turn': return 'Finished a turn'
    case 'error': return 'Stopped with an error'
    case 'crash': return 'Session ended unexpectedly'
    case 'setup.failed': return 'Setup failed'
    case 'setup.passed': return e.wait ? 'Setup passed, still waiting' : 'Setup passed'
    case 'wait.started': return `Waits for ${e.wait?.label ?? 'another PR'}`
    case 'wait.released': return `${upper(e.wait?.label ?? 'the PR it waited for')} merged`
    case 'wait.broken': return `${upper(e.wait?.label ?? 'the PR it waited for')} ${e.wait?.gone ?? 'closed'} without merging`
    case 'review': {
      const r = e.review
      if (!r) return 'Sent a review'
      const what = r.ofPr ? `PR #${r.ofPr}` : `${r.ofName}'s work`
      const n = r.total ?? r.blockers?.length ?? 0
      return r.verdict === 'approved' ? `Approved ${what}` : `Found ${n} ${n === 1 ? 'blocker' : 'blockers'} in ${what}`
    }
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
  const wait = last((e) => e.kind.startsWith('wait.'))
  // Once per PR: after Continue moved the workspace on, its new PR's opening is news too.
  const seen = new Set<string>()
  return sorted.filter((e) => {
    if (TURN_ENDS.has(e.kind)) return e === turn
    // Without the workspace, as while events wait, the last state event is kept whatever the PR does next.
    if (STATE_OF[e.kind]) return e === state && (!ws || ws.prState === STATE_OF[e.kind])
    if (e.kind === 'setup.failed' || e.kind === 'setup.passed') return e === setup
    if (e.kind === 'review') return e === review
    if (e.kind.startsWith('wait.')) return e === wait
    // A close the PR has since left, by reopening or Continue, says nothing any more.
    if (e.kind === 'pr.closed' && ws && ws.prState !== 'closed') return false
    if (ONCE.has(e.kind)) { const key = `${e.kind}:${e.pr ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true }
    return true
  })
}

/** One workspace in an update. `from` is the closed Lead chat it came from, when it isn't the target's own; `owner` handed it off. */
interface Block { ws: Workspace; name: string; events: TeamEvent[]; reply?: string; summary?: boolean; status?: string; latest: number; from?: Chat; owner?: string; wake: Set<TeamEvent>; todo: string[] }

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
  /** Every verdict there is was of an earlier commit. */
  stale?: boolean
  /** The newest review workspace still open, to ask for another pass instead of a new one. `failed`: its setup failed. */
  open?: { workspaceId: string; agentId: string; name: string; failed?: boolean }
}

/** Where a PR that passed checks stands with its review, for the Lead's text, or nothing when Kernel can't tell. */
function reviewStatus(review: ReviewState | undefined, reviewer: AgentDef | undefined): string {
  if (!review) return ''
  if (review.inProgress) return `${review.open?.name ?? 'The reviewer'} is reviewing it.`
  if (review.approvedBy.length) return `${review.approvedBy.join(' and ')} approved it.`
  if (review.blockers) return `${review.open?.name ?? 'Its review'} found blockers.`
  if (review.stale) return `${review.open ? `${review.open.name}'s review` : 'Its last review'} was of a different commit.`
  return reviewer || review.open ? 'Nobody has reviewed it yet.' : ''
}

/** PR states that mean the PR is still being created or checked, so a turn that just ended isn't news on its own. */
const SETTLING: PrState[] = ['creating', 'checks', 'resolving', 'merging']

export class LeadUpdates {
  /** Keyed by the owning Lead chat's id, or `room:<id>` for workspaces no Lead chat handed off. */
  private pending = new Map<string, Pending>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** The last PR state seen per workspace, to tell "opened" from a later change. */
  private prev = new Map<string, PrState>()
  /**
   * Lead chats the user stopped. Stop means stop: their updates wait for the chat's next turn that ends normally,
   * usually the user's next message, instead of starting a Kernel turn right after the Stop (KERNEL-122).
   */
  private stopped = new Set<string>()
  /** Review workspaces whose running turn sent a verdict. That turn's end isn't news of its own (KERNEL-130). */
  private submitted = new Set<string>()
  /**
   * Teammate workspaces whose PR Kernel is reading after a turn ended. Their updates wait for the read, so a PR the turn
   * opened or pushed to speaks for the turn however long GitHub takes, instead of the turn waking the Lead on its own.
   */
  private reading = new Map<string, number>()
  /** Teammates whose running turn set a wait of their own. Their updates wait for that turn to end (KERNEL-262). */
  private waitTurns = new Set<string>()
  private detached = false
  private seq = 0
  private off: () => void = () => undefined

  constructor(private d: LeadUpdateDeps) {}

  attach() {
    this.detached = false
    for (const w of this.d.store.workspaces()) this.prev.set(w.id, w.prState)
    this.load()
    const on = (e: PushEvent) => { if (e.type === 'pr') this.onPr(e.workspaceId, e.state) }
    bus.on('push', on)
    this.off = () => bus.off('push', on)
  }

  detach() {
    this.detached = true
    this.off()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /**
   * What waited when Kernel last quit. Events for workspaces that are gone, or that are the Lead's own, are dropped, and
   * so are stop marks of chats that are closed or gone. Nothing is sent from here: the next event, the next Lead turn end
   * or the PR poll delivers it, so nothing goes to the Lead the moment Kernel opens. The first poll, 45 seconds in, can.
   */
  private load() {
    const saved = this.d.store.meta<Saved>(SAVED)
    if (saved?.v !== 1) return
    // A saved value Kernel can't read is dropped rather than stopping Kernel from starting.
    try {
      this.seq = Math.max(this.seq, saved.seq ?? 0)
      for (const [key, p] of saved.pending ?? []) {
        const events = (p.events ?? []).filter((e) => { const ws = this.d.store.workspace(e.workspaceId); return !!ws && !this.d.isLead(ws) })
        if (events.length) this.pending.set(key, { ...p, events })
      }
      for (const id of saved.stopped ?? []) { const chat = this.d.store.chat(id); if (chat && !chat.closed) this.stopped.add(id) }
    } catch { this.pending.clear(); this.stopped.clear() }
    this.save()
  }

  private save() {
    this.d.store.saveMeta<Saved>(SAVED, { v: 1, seq: this.seq, pending: [...this.pending], stopped: [...this.stopped] })
  }

  /**
   * A turn ended. A teammate's finished turn is news for the Lead; the end of the Lead's own turn is a chance to deliver,
   * unless the user stopped it.
   */
  turnDone(ws: Workspace, chat: Chat, t: TurnDone) {
    if (t.lead || this.d.isLead(ws)) {
      if (t.interrupted) { this.stopped.add(chat.id); this.save(); return }
      if (this.stopped.delete(chat.id)) this.save()
      this.flush(ws.roomId)
      return
    }
    this.waitTurns.delete(ws.id)
    // A reviewer's turn that sent its verdict has the verdict to speak for it, however the turn ends (KERNEL-130).
    const verdictTurn = this.submitted.delete(ws.id)
    if (t.interrupted || t.queued || verdictTurn) return
    if (!t.ok) { this.add(ws, { kind: 'error', by: t.by }); return }
    const reply = [...this.d.store.items(chat.id)].reverse().find((i) => i.kind === 'text')
    this.add(ws, { kind: 'turn', by: t.by, reply: reply?.kind === 'text' ? capText(reply.text, REPLY_KEPT) : undefined })
  }

  /** Kernel is reading the workspace's PR after a turn. Its updates wait until every read started has ended (`readPr`). */
  readingPr(workspaceId: string) { this.reading.set(workspaceId, (this.reading.get(workspaceId) ?? 0) + 1) }

  /** Kernel read the workspace's PR. Its updates go once things are quiet again. Ignored once Kernel has stopped. */
  readPr(workspaceId: string) {
    const n = this.reading.get(workspaceId)
    if (!n) return
    if (n > 1) { this.reading.set(workspaceId, n - 1); return }
    this.reading.delete(workspaceId)
    if (this.detached) return
    const ws = this.d.store.workspace(workspaceId)
    if (ws) this.rearm(ws)
  }

  /**
   * A teammate's workspace setup failed, or passed on Run again (KERNEL-126). `told` marks a failure the Lead already read in
   * create_workspace's result, which rides along instead of waking it again.
   */
  setup(ws: Workspace, ok: boolean, o: { told?: boolean; code?: number | null; wait?: WaitNews } = {}) {
    if (this.d.isLead(ws)) return
    this.add(ws, ok ? { kind: 'setup.passed', ...(o.wait ? { wait: o.wait } : {}) } : { kind: 'setup.failed', ...(o.code !== undefined ? { code: o.code } : {}), ...(o.told ? { told: true } : {}) })
  }

  /**
   * A teammate's wait on other PRs started, was released by their merge, or broke because one closed or was archived
   * without merging (KERNEL-259). Only a broken wait, and a started one the Lead didn't set itself, wake the Lead.
   */
  waits(ws: Workspace, kind: 'wait.started' | 'wait.released' | 'wait.broken', wait: WaitNews) {
    if (this.d.isLead(ws)) return
    // A teammate set it mid-turn (KERNEL-262). It waits for that turn to end, so both wake the Lead once, together.
    if (kind === 'wait.started' && !wait.told && !wait.held) this.waitTurns.add(ws.id)
    this.add(ws, { kind, wait: wait.why ? { ...wait, why: capText(wait.why, WHY_MAX) } : wait })
  }

  /** A reviewer's submit_review (KERNEL-130). It always wakes the Lead, on the reviewer's own workspace. */
  reviewed(reviewer: Workspace, of: Workspace, v: ReviewVerdict) {
    if (this.d.isLead(reviewer)) return
    // The turn that sent the verdict ends soon after; the verdict speaks for it.
    this.submitted.add(reviewer.id)
    this.add(reviewer, { kind: 'review', review: {
      verdict: v.verdict, summary: capText(v.summary, REPLY_KEPT),
      ...(v.blockers?.length ? { blockers: v.blockers.slice(0, MAX_BLOCKERS).map((b) => ({ ...b, text: capText(b.text, BLOCKER_MAX) })), total: v.blockers.length } : {}),
      of: of.id, ofName: this.d.agentName(of.roomId, of.agentId) ?? of.agentId, ...(of.prNumber ? { ofPr: of.prNumber } : {}),
      ...(v.sha ? { sha: v.sha } : {}), current: !v.sha || !of.prHead || v.sha === of.prHead
    } })
  }

  /**
   * A teammate's session died partway through a turn (KERNEL-124). Its turn never ends, so without this the Lead would
   * think the teammate is still working. The Lead's own sessions are left out: Sessions holds Kernel's messages for them.
   */
  crashed(ws: Workspace, reason: string, o: { resumed?: boolean } = {}) {
    if (this.d.isLead(ws)) return
    this.waitTurns.delete(ws.id)
    const said = firstLine(reason, 120).replace(/[.!?]+$/, '')
    this.add(ws, { kind: 'crash', ...(said ? { reason: said } : {}), ...(o.resumed ? { resumed: true } : {}) })
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
    this.save()
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
    const changed = { any: false }
    try { this.deliver(roomId, waiting, changed) } finally { if (changed.any) this.save() }
  }

  private deliver(roomId: string, waiting: [string, Pending][], changed: { any: boolean }) {
    const drop = (key: string) => { if (this.pending.delete(key)) changed.any = true }
    if (!this.d.enabled()) { for (const [key] of waiting) if (!this.timers.has(key)) drop(key); return }
    const byChat = new Map<string, { chat: Chat; sources: Source[]; keys: string[]; quiet: boolean }>()
    for (const [key, p] of waiting) {
      const t = this.d.target(roomId, p.owner)
      if (!t) { if (!this.timers.has(key)) drop(key); continue }
      const group = byChat.get(t.chat.id) ?? { chat: t.chat, sources: [], keys: [], quiet: true }
      group.sources.push({ events: p.events, from: t.closed, owner: p.owner })
      group.keys.push(key)
      group.quiet &&= !this.timers.has(key) && !p.events.some((e) => this.reading.has(e.workspaceId) || this.waitTurns.has(e.workspaceId))
      byChat.set(t.chat.id, group)
    }
    for (const g of byChat.values()) {
      if (!g.quiet || this.stopped.has(g.chat.id)) continue
      const message = this.compose(roomId, g.sources)
      // Everything that waited was overtaken, as a failed check fixed since. There is nothing left to say.
      if (!message) { for (const key of g.keys) drop(key); continue }
      // Nothing needs the Lead yet. It all waits for the next update that does (KERNEL-121).
      if (!message.wakes) continue
      if (!this.d.post(g.chat.id, message.text, message.update)) continue
      for (const key of g.keys) drop(key)
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
        // A verdict is current while the reviewed PR's head is the commit it reviewed, as of now, not as of the verdict.
        // A wait that broke and came back, as when its PR reopened, says nothing (KERNEL-259).
        const kept = collapse(events, ws).filter((e) => e.kind !== 'wait.broken' || stillBroken(ws, e, (id) => this.d.store.workspace(id))).map((e) => {
          if (!e.review?.sha) return e
          const head = this.d.store.workspace(e.review.of)?.prHead
          return { ...e, review: { ...e.review, current: !head || head === e.review.sha } }
        })
        if (!kept.length) continue
        const turn = kept.find((e) => e.kind === 'turn')
        const verdict = kept.find((e) => e.kind === 'review')?.review
        const name = this.d.agentName(roomId, ws.agentId) ?? ws.agentId
        const review = kept.some((e) => e.kind === 'pr.ready') ? this.d.reviewState?.(ws) : undefined
        const reviewer = this.d.reviewer?.(ws.roomId)
        const block: Block = {
          ws, name, events: kept, reply: verdict?.summary ?? turn?.reply, summary: !!verdict, status: reviewStatus(review, reviewer),
          latest: Math.max(...events.map((e) => e.n)), from: source.from, owner: source.owner, wake: new Set(), todo: []
        }
        if (source.owner) {
          const decided = decide({ ws, name, events: kept, fromChat: source.from?.title }, {
            review, reviewer, allMerged: () => this.allMerged(ws.roomId, source.owner!), workspace: (id) => this.d.store.workspace(id)
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
        events: b.events.map((e) => ({ kind: e.kind, text: cardText(e, b.status), actionable: b.wake.has(e) })),
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
export interface WakeContext { review?: ReviewState; reviewer?: AgentDef; allMerged: () => boolean; workspace?: (id: string) => Workspace | undefined }

/** The To do line for a PR that passed checks and was approved. The review's own line says the same, so it shows once. */
const readyToMerge = (pr: string, by: string[]) => `${upper(pr)} passed checks, has no conflicts and ${by.join(' and ')} approved it. Tell the user it is ready to merge.`

/** The To do line for a PR whose review was of another commit. The PR's own line says the same, so it shows once. */
const anotherReview = (pr: string, name: string, at: string) => `${upper(pr)} needs another review: the last one was of a different commit. Ask ${name} to review it again with message_agent (workspace ${at}).`

/**
 * Which of one workspace's events need the Lead, and what to do about each (KERNEL-121). Called only for work a Lead chat
 * handed off. A turn the user started in the teammate's own chat, and an error in one, are between them and never wake it.
 * `fromChat` is the closed Lead chat the work came from, for the merge line.
 */
export function decide(b: { ws: Workspace; name: string; events: TeamEvent[]; fromChat?: string }, c: WakeContext): { wake: Set<TeamEvent>; todo: string[] } {
  const { ws, name } = b
  const out = { wake: new Set<TeamEvent>(), todo: [] as string[] }
  const at = `(workspace ${ws.id})`
  // An archived workspace takes no more messages, and archiving it was the user's call, so only news that asks nothing
  // of it still wakes the Lead: the last merge of a plan, and a review's verdict, which is about other work.
  const archived = ws.status === 'archived'
  for (const e of b.events) {
    const pr = e.pr ? `PR #${e.pr}` : 'the PR'
    const wake = (todo: string, evenArchived = false) => { if (archived && !evenArchived) return; out.wake.add(e); out.todo.push(todo) }
    switch (e.kind) {
      case 'error': if (e.by !== 'user') wake(`${name} stopped with an error. Ask ${name} what happened with message_agent ${at}, or tell the user.`); break
      case 'crash': if (!e.resumed) wake(`${name}'s session ended. Tell the user they can restart it from the workspace.`); break
      case 'setup.failed': if (!e.told) wake(`Setup failed in ${name}'s workspace. Tell the user to fix it and click Run again there.`); break
      case 'review': {
        const r = e.review
        if (!r) { wake(`Read ${name}'s review and pass on what it found.`, true); break }
        const of = c.workspace?.(r.of)
        // The work was merged, closed or archived before the verdict came. Nobody can act on it there any more.
        if (of && (of.prState === 'merged' || of.prState === 'closed' || of.status === 'archived')) {
          const what = of.prNumber ? `PR #${of.prNumber}` : `${r.ofName}'s work`
          const when = of.prState === 'merged' ? 'merged' : of.prState === 'closed' ? 'was closed' : 'was archived'
          if (r.verdict === 'blockers') wake(`${name} found blockers in ${what} after it ${when}. Tell the user what they are in a line or two.`, true)
          break
        }
        // A review workspace the user archived can't review again, so its blockers go to the author without asking for that.
        if (r.verdict === 'blockers') { wake(`Send ${name}'s blockers to ${r.ofName} with message_agent (workspace ${r.of}).${archived ? '' : ` When ${r.ofName} is done, ask ${name} to review again with message_agent (workspace ${ws.id}).`}`, true); break }
        // An approval of a commit the PR no longer has, or doesn't have yet, says nothing about what would merge.
        if (!r.current && of?.prNumber) { wake(anotherReview(`PR #${of.prNumber}`, name, ws.id)); break }
        if (of?.prState === 'ready' && of.prNumber) { wake(readyToMerge(`PR #${of.prNumber}`, [name]), true); break }
        if (!of?.prNumber) { wake(`${name} approved ${r.ofName}'s work. Ask ${r.ofName} to open a pull request with message_agent (workspace ${r.of}).`, true); break }
        wake(`${name} approved PR #${of.prNumber}. Its checks haven't passed yet; tell the user it is ready to merge once they do.`, true)
        break
      }
      case 'pr.cifail': wake(`Tell ${name} about the failed checks on ${pr} with message_agent ${at}.`); break
      case 'pr.changes': wake(`Tell ${name} about the changes requested on ${pr} with message_agent ${at}.`); break
      case 'pr.conflict': wake(`Ask ${name} to resolve the conflicts on ${pr} with message_agent ${at}.`); break
      case 'pr.closed': if (ws.prState === 'closed') wake(`${upper(pr)} was closed without merging. Ask the user whether ${name}'s work is still wanted.`); break
      case 'wait.broken':
        if (stillBroken(ws, e, c.workspace)) {
          const label = e.wait?.label ?? 'a PR'
          wake(`${name} is waiting for ${label}, which was ${e.wait?.gone ?? 'closed'} without merging. Ask the user whether ${name} should ${e.wait?.held === false ? 'carry on without it' : 'start anyway'} (wait_for_merge with an empty list) or archive ${name}'s workspace.`)
        }
        break
      // A wait the Lead set itself is in its tool's result. One a teammate set mid-task is news (KERNEL-262).
      case 'wait.started':
        if (!e.wait?.told) wake(`${name} is waiting for ${e.wait?.label ?? 'another PR'}. Kernel ${e.wait?.held === false ? `starts ${name} again` : `sends ${name} the brief`} when it merges. Tell the user in one line that merging it unblocks ${name}.`)
        break
      // Kernel already sent the brief or the rebase, so the Lead has nothing to do.
      case 'wait.released': break
      case 'pr.merged':
        if (c.allMerged()) wake(b.fromChat ? `Every task handed off in the closed Lead chat "${b.fromChat}" has merged. Tell the user in one line.` : ALL_MERGED, true)
        break
      case 'pr.ready': {
        const review = c.review
        // Blockers come with the review's own update, and a review that runs will say what it found.
        if (review?.blockers || review?.inProgress) break
        if (review?.approvedBy.length) { wake(readyToMerge(pr, review.approvedBy)); break }
        if (review?.open?.failed) { wake(`${upper(pr)} needs a review, and setup failed in ${review.open.name}'s review workspace. Tell the user to fix it and click Run again there (workspace ${review.open.workspaceId}).`); break }
        if (review?.open) { wake(review.stale ? anotherReview(pr, review.open.name, review.open.workspaceId) : `${upper(pr)} needs a review. Ask ${review.open.name} to review it with message_agent (workspace ${review.open.workspaceId}).`); break }
        if (!c.reviewer) { wake(`${upper(pr)} passed checks and has no conflicts. No reviewer is on this team, so tell the user it is ready for them to review and merge.`); break }
        wake(`${upper(pr)} needs a review. ${c.reviewer.name} (${c.reviewer.id}) reviews on this team: call create_workspace with agent "${c.reviewer.id}" and review_of "${ws.id}".`)
        break
      }
      case 'turn':
        // A turn whose PR is being created or checked, or that a newer PR event follows, has that event to speak for it.
        if (e.by === 'user' || SETTLING.includes(ws.prState) || b.events.some((x) => x.n > e.n && (x.kind.startsWith('pr.') || x.kind === 'review'))) break
        // The turn ended by waiting for another PR. Its wait line already wakes the Lead, once (KERNEL-262).
        if (b.events.some((x) => x.kind === 'wait.started' && !x.wait?.told)) break
        wake(`Read ${name}'s reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`)
        break
      default: break
    }
  }
  return out
}

/** A wait.broken event whose PR still can't merge, and that the workspace still waits for. Unknown targets count as broken. */
function stillBroken(ws: Workspace, e: TeamEvent, workspace?: (id: string) => Workspace | undefined): boolean {
  const target = e.wait?.target
  if (!target || !ws.waitsFor?.on.includes(target)) return false
  return !workspace || isBroken(workspace(target))
}

/** The To do line once the last task a chat handed off has merged. */
const ALL_MERGED = 'Every task you handed off in this chat has merged. Tell the user in one line.'

/** One workspace's block in the Lead's text: who and what, each event, then the reply quoted. A reply says the turn ended. */
function blockLines(b: Block): string[] {
  const lines = [`${b.name} (${b.ws.agentId}) · ${b.ws.title ?? b.ws.name} · workspace ${b.ws.id}`]
  for (const e of b.events) if (!(e.kind === 'turn' && b.reply && !b.summary)) lines.push(`- ${sentence(e, b.name, b.status)}`)
  if (b.reply) {
    lines.push(`- ${b.name}'s ${b.summary ? 'summary' : 'last reply'}:`)
    for (const l of b.reply.split('\n')) lines.push(l.trim() ? `  > ${l}` : '  >')
  }
  return lines
}
