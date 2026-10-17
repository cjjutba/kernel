import type { AgentDef, Chat, PrBlocked, PrState, Provider, ReviewKind, ReviewVerdict, SharedFile, SharedKind, SharedVersion, TeamEventKind, TeamUpdate, TeamUpdateRow, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Store } from '../db'
import type { Notification } from '@shared/types'
import { bus } from '../bus'
import { UPDATE_HEADER } from './handoff'
import type { TurnDone } from './notifications'
import { CRASH_REASON, QUIT_REASON, type TurnBy } from './sessions'
import { capText, firstLine } from './text'
import { isBroken } from './waits'
import { blockedWhy, kindsText, reviewPhrase, reviewsText } from '@shared/merge'
import { resetPhrase } from '@shared/usage'

/**
 * Tells the Lead what its teammates did (KERNEL-72). Without it, the Lead hands off and never hears back: nobody passes a
 * review's blockers on, and nobody tells the user a PR is ready. Events are collected per Lead chat, the one that handed the
 * workspace off (KERNEL-105), and sent as one message once things go quiet, only to a Lead chat that already exists and
 * is idle. A busy, queued or paused chat gets them later, and doesn't hold up the others. Nothing is dropped except when
 * the project has no open Lead chat at all, because then there is nobody to tell.
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
   * The open Lead tab that hears about workspaces handed off in the tab `owner`, or about workspaces no Lead tab handed off
   * when `owner` is unset. `from` names where the work came from when the owner is closed and its updates go elsewhere:
   * the closed tab, with `tab`, when another tab of its chat takes them, else the closed Lead chat (KERNEL-337). Undefined
   * when the project has no open Lead tab. Never creates one.
   */
  target: (projectId: string, owner?: string) => { chat: Chat; from?: From } | undefined
  /**
   * Opens a Lead tab for an update that needs the Lead when `target` finds none (KERNEL-365), and returns where it goes as
   * `target` would. Called only when the update goes out now, so a project with no open Lead tab gets no tab it won't use.
   */
  open?: (projectId: string, owner?: string) => { chat: Chat; from?: From } | 'opening' | undefined
  /** Whether the workspace is the Lead's own. Its events are never reported back to it, except its PR's in Build here (`ownChat`). */
  isLead: (ws: Workspace) => boolean
  /**
   * The tab of the Build here chat whose own workspace `ws` is (KERNEL-778). Its PR's news, and its reviews' verdicts, go to
   * that chat as a Team update, the way a teammate's go to the chat that handed the work off. Left out, none.
   */
  ownChat?: (ws: Workspace) => string | undefined
  agentName: (projectId: string, agentId: string) => string | undefined
  /**
   * Draws a Team update in the chat without sending it to the session: a review of the chat's own PR in Build here, which
   * costs no turn (KERNEL-990). Left out, such a verdict is dropped.
   */
  row?: (chatId: string, update: TeamUpdate) => void
  /** Sends Kernel's message into the Lead chat, with the card's data. False when the Lead can't take it now (`Sessions.post`). */
  post: (chatId: string, text: string, update: TeamUpdate) => boolean
  /** Why `post` refused the chat, for the delivery log (`Sessions.postHold`, KERNEL-637). */
  holdOf?: (chatId: string) => string | undefined
  /**
   * Raises the inbox row and the Mac notification for a terminal Lead tab with an update waiting that needs it, or settles the
   * row once the tab has it (KERNEL-1000). One row per `id`, replaced in place. Left out, a terminal tab gets none.
   */
  notify?: (n: Pick<Notification, 'id' | 'title' | 'sub'> & Partial<Pick<Notification, 'heading' | 'body' | 'projectId' | 'workspaceId' | 'chatId' | 'ask' | 'needsYou' | 'resolved'>>) => void
  /** Called after a delivered update, for the project log. */
  delivered?: (projectId: string, chat: Chat, update: TeamUpdate) => void
  /** Called after a delivered update with each workspace's events as it told them, for what the Lead now owes (KERNEL-749). */
  opened?: (chat: Chat, rows: { ws: Workspace; name: string; events: TeamEvent[] }[]) => void
  /** What Kernel knows about reviews of the workspace's PR. Unknown until reviews are linked (KERNEL-130). */
  reviewState?: (ws: Workspace) => ReviewState | undefined
  /** The team's reviewer, the first agent with a review role that isn't the Lead. */
  reviewer?: (projectId: string) => AgentDef | undefined
  /** Whether Kernel starts reviews of a PR that passed checks by itself (`pr.autoReview`, KERNEL-115, KERNEL-549). On when unset. */
  autoReview?: () => boolean
  /**
   * A batch goes `delayMs` after its newest event, two seconds, but never later than `maxDelayMs` after its oldest, five
   * seconds, so a busy team can't hold it back (KERNEL-637). Tests shorten both.
   */
  delayMs?: number
  maxDelayMs?: number
  /** Where the delivery log and delivery errors go. The console unless a test says otherwise. */
  log?: (level: 'info' | 'warn', line: string) => void
}

/** One thing that happened in a teammate's workspace, kept until it reaches the Lead. */
export interface TeamEvent {
  /** Order across every chat's events, so a message that mixes several knows which are newest. */
  n: number
  /** When it happened, for the delivery log (KERNEL-637). Unset on events saved before. */
  at?: number
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
  /** A failed setup: its exit code, null when it was stopped, or `timeout` when it ran out of time (KERNEL-216). */
  code?: number | null | 'timeout'
  /** A failed setup the Lead already heard about in create_workspace's result. It doesn't wake the Lead again. */
  told?: boolean
  /** The teammate's brief went out while setup ran, so a failure holds nothing and it keeps working without it (KERNEL-1012). */
  started?: boolean
  /**
   * A review: the verdict, its kind (KERNEL-549), and the work it is about, with its author's name and PR number (KERNEL-130).
   * `asked`: the Lead started the turn that sent it, with message_agent, and `reply` is what the reviewer wrote back in that
   * turn (feat-review-messages-reach-named).
   */
  review?: { verdict: ReviewVerdict['verdict']; lens?: ReviewKind; summary: string; blockers?: ReviewVerdict['blockers']; total?: number; of: string; ofName: string; ofPr?: number; sha?: string; current: boolean; stillBlocked?: number; asked?: boolean; reply?: string }
  /** A wait on other PRs (KERNEL-259), and on a setup that passed while one stands. */
  wait?: WaitNews
  /** A file the teammate shared, at the version it shared (KERNEL-302). `source` is its path in the workspace. */
  shared?: { sharedId: string; version: number; title: string; kind: SharedKind; source: string }
  /** `pr.blocked`: why GitHub won't merge the ready PR (KERNEL-401). */
  blocked?: PrBlocked
  /** `pr.merged` by Kernel itself, and why auto-merge allowed it (KERNEL-556): `why` for the Lead, `card` for the card. */
  auto?: AutoMerged
  /** `question`: what the teammate asked the Lead with ask_lead, and the answers it offered (KERNEL-747). */
  question?: { text: string; options?: string[] }
  /** `handoff.proposed`: the agent the teammate proposed for part of its work, by id and name, the task and why (KERNEL-747). */
  proposal?: { agentId: string; agent: string; task: string; why: string }
  /** `limit`: the usage limit that cut the turn off and what Kernel does about it. `limit.lifted`: the account it carries on on (KERNEL-777). */
  limit?: LimitNews
  /**
   * `pr.updated`: the base Kernel brought the PR up to date with before merging it by itself (KERNEL-835). `capped`: the base
   * moved past it again after that many updates, so Kernel stopped updating it.
   */
  updated?: { base: string; capped?: number }
}

/**
 * A usage limit that cut a teammate off, as `Account.limitNews` reads it (KERNEL-777). `window` names it as the limit banner
 * does ("5-hour limit"), `model` the model on a limit of that model alone, and `account` the account that ran out, or on
 * `limit.lifted` the one the teammate runs on now. `resetsAt` is in seconds (KERNEL-50), the earliest across accounts when
 * none has headroom. `switching`: Kernel is moving the provider to another account, `to` once it picked one. `stuck`: nothing
 * carries the teammate on before the reset. `full`: no account has headroom, and one that is signed out or waits on a Keychain
 * prompt counts as having none. `off`: the switch is off or was undone. `signIn`: the switch failed. `model`: the limit is on
 * its model alone. `carried`: the `limit.lifted` that followed in the same update, by its account (`foldLimits`).
 */
export interface LimitNews {
  provider: Provider
  window?: string
  model?: string
  account?: string
  resetsAt?: number
  switching?: { to?: string }
  stuck?: 'full' | 'off' | 'signIn' | 'model'
  carried?: string
}

/** Why Kernel merged a PR by itself (`autoMergeWhy`, KERNEL-556). */
export interface AutoMerged { why: string; card: string }

/**
 * What a wait event says (KERNEL-259). `label` names the PRs ("PR #164 by Sean"). `held`: the brief hasn't gone out, as
 * opposed to a teammate that already started. `target` and `gone`: the PR that broke the wait and how. `told`: the Lead
 * read it in its own tool's result, so it rides along. `why`: what a teammate that set its own wait said it needs (KERNEL-262).
 * `onto`: the base Kernel asked the teammate to bring in, which its branch doesn't contain yet (KERNEL-691). `pushed`: the
 * branch is on the remote, so it takes `onto` by a merge rather than a rebase (KERNEL-886).
 */
export interface WaitNews { on: string[]; label: string; held?: boolean; target?: string; gone?: 'closed' | 'archived'; told?: boolean; why?: string; onto?: string; pushed?: boolean }

export const seatId = (chatId: string) => `n-seat-${chatId}`
export const askId = (chatId: string, workspaceId: string) => `n-ask-${chatId}-${workspaceId}`

/** Events waiting for one Lead chat, or for a project's first Lead chat when `owner` is unset. */
interface Pending { projectId: string; owner?: string; events: TeamEvent[] }

/**
 * What waits for the Lead, saved under the meta key `leadUpdates` so a quit doesn't lose it (KERNEL-123). `toldBlocked` is
 * what the Lead last heard about GitHub's block on each ready PR, so an unblock after a restart still reaches it (KERNEL-401).
 */
interface Saved { v: 1; seq: number; pending: [string, Pending][]; stopped: string[]; toldBlocked?: [string, PrBlocked][]; toldLimit?: string[]; seatQueue?: [string, SeatUpdate[]][] }

/**
 * An update for a terminal Lead tab, composed as a chat would get it and kept until the tab's next prompt or its check_team
 * (KERNEL-1000). Kernel never types into a terminal. `asks`: the workspaces whose question it carries.
 */
interface SeatUpdate { text: string; update: TeamUpdate; told: { workspaceId: string; name: string; events: TeamEvent[] }[]; asks: string[] }
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

/**
 * The most workspaces one update carries, so a long absence can't flood the Lead. The rest are counted and wait for the next
 * update (KERNEL-637).
 */
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

/** A question or a proposed hand-off is kept this long, and each of a question's options this long (KERNEL-747). */
const ASK_MAX = 1500
const OPTION_MAX = 200
const OPTIONS_MAX = 6

/** The card's words for a question or a proposed task, cut short so the row stays one or two lines. */
const CARD_MAX = 140

/** A crash event for a teammate Kernel's own quit or crash cut off, which carries on at the next launch (KERNEL-215). */
const relaunched = (e: TeamEvent) => e.kind === 'crash' && !!e.resumed && (e.reason === QUIT_REASON || e.reason === CRASH_REASON)

/** "its 5-hour limit", "its Opus limit", or "a usage limit" when Kernel can't name it (KERNEL-777). */
const limitName = (l?: LimitNews) => (l?.window ? `its ${l.window}` : 'a usage limit')

/**
 * " until 6:20 PM", " until tomorrow at 4:00 AM", " until Friday at 9:00 AM": when the limit resets in the user's time zone,
 * as the limit banner says it, or nothing when Kernel doesn't know. `resetsAt` is in seconds (KERNEL-50).
 */
const until = (l?: LimitNews) => (l?.resetsAt ? ` until ${resetPhrase(l.resetsAt, Date.now()).replace(/^at /, '')}` : '')

/** A `limit` event as a sentence for the Lead: what ran out, then what Kernel does about it (KERNEL-777). */
function limitSentence(l?: LimitNews): string {
  const hit = `Hit ${limitName(l)}${l?.model && l.stuck === 'model' ? ` for ${l.model}` : ''}${l?.account ? ` on ${l.account}` : ''}.`
  if (l?.carried !== undefined) return `${hit} ${l.carried && l.carried !== l.account ? `Kernel moved it to ${l.carried} and it carries on.` : 'It carries on now that the limit reset.'}`
  if (l?.switching) return `${hit} Kernel is moving it to ${l.switching.to ?? 'another account'}, where it carries on.`
  if (l?.stuck === 'full') return `${hit} Every account is at its limit, so it is paused${until(l)}.`
  if (l?.stuck === 'signIn') return `${hit} Kernel couldn't move it to another account, so it is paused${until(l)}.`
  return `${hit} It is paused${until(l)}.`
}

/**
 * The To do line for a teammate a limit stopped with nothing to carry it on before the reset (KERNEL-777). Kernel carries it
 * on by itself then, and a message the Lead sent waits in its chat, so the Lead never sends it again.
 */
function pausedTodo(name: string, l?: LimitNews): string {
  const when = until(l)
  const why = l?.stuck === 'full' ? ' because every account is at its limit'
    : l?.stuck === 'model' ? ` because ${l.model ?? 'its model'} is at its limit${l.account ? ` on ${l.account}` : ''}`
    : ` by ${limitName(l)}${l?.account ? ` on ${l.account}` : ''}`
  // Kernel counts an account that is signed out or waits on a Keychain prompt as one without headroom, so the user may free one.
  const signIn = l?.stuck === 'full' || l?.stuck === 'signIn' ? ` If an account is signed out or waits for Keychain access, tell the user to sign in or allow it, and Kernel moves ${name} there.` : ''
  return `${name} is paused${when}${why}.${signIn} Kernel carries ${name} on by itself ${when ? 'then' : 'once the limit resets'}, and any message you sent waits in its chat, so don't send it again.`
}

/** The To do line once a teammate the Lead heard was paused carries on (KERNEL-777). */
const liftedTodo = (name: string, account?: string) => `${name} is working again${account ? ` on ${account}` : ''}. If you told the user it was paused, correct that in one line.`

/**
 * A limit and the carry-on that followed it in one update read as one event, the limit, with `carried` naming the account
 * the teammate carries on on (KERNEL-777). The pair wakes the Lead only to correct a pause it heard about before.
 */
export function foldLimits(events: TeamEvent[]): TeamEvent[] {
  const limit = events.find((e) => e.kind === 'limit')
  const lifted = events.find((e) => e.kind === 'limit.lifted')
  if (!limit || !lifted || lifted.n < limit.n) return events
  const { switching: _s, stuck: _t, ...was } = limit.limit ?? { provider: lifted.limit?.provider ?? 'claude' }
  return events.filter((e) => e !== lifted).map((e) => (e === limit ? { ...e, limit: { ...was, carried: lifted.limit?.account ?? '' } } : e))
}

/** How the Lead's text names each kind of shared file. */
const KIND_LABEL: Record<SharedKind, string> = { html: 'HTML', image: 'image', pdf: 'PDF', markdown: 'Markdown' }

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
    case 'pr.merged': return e.auto ? `Kernel merged ${pr} automatically, since ${e.auto.why}.` : `${upper(pr)} was merged.`
    case 'pr.closed': return `${upper(pr)} was closed without merging.`
    case 'pr.blocked': return `GitHub won't merge ${pr} yet: ${e.blocked ? blockedWhy[e.blocked] : "the branch's rules"}.`
    case 'pr.unblocked': return `GitHub no longer blocks ${pr}.`
    case 'pr.updated': {
      const base = e.updated?.base ?? 'its base'
      if (e.updated?.capped) return `${upper(pr)} fell behind ${base} again after Kernel brought it up to date ${e.updated.capped} times, so Kernel stopped updating it and won't merge it by itself.`
      return `Kernel brought ${pr} up to date with ${base}, waiting for checks.`
    }
    // A card segment only, never an event the Lead reads.
    case 'pr.review': return ''
    case 'turn': return 'Finished a turn.'
    case 'error': return 'Stopped with an error. Open the workspace to see it.'
    case 'crash':
      // Kernel itself quit or closed (KERNEL-215). Nothing went wrong in the session, and it may still wait for a hold to lift.
      if (relaunched(e)) return `${e.reason} while ${name} was partway through a turn. ${name} carries on by itself once nothing holds it, such as a paused project or the agent limit.`
      return `${name}'s session ended unexpectedly${e.reason ? ` (${e.reason})` : ''}, partway through a turn. ${e.resumed ? `A message waiting for ${name} started a new session, so ${name} is working again.` : 'The worktree and chat are saved; the user can restart it from the workspace.'}`
    case 'setup.failed': return `Setup failed${e.code === null ? ' (it was stopped)' : e.code === 'timeout' ? " (it didn't finish in time)" : e.code !== undefined ? ` with exit code ${e.code}` : ''}${e.started ? `. ${name} already started and keeps working without it. The user can fix setup and click Run again in that workspace.` : `, so ${name} hasn't started. The brief waits until the user fixes setup and clicks Run again in that workspace.`}`
    case 'setup.passed': return e.wait ? `Setup passed on Run again. ${name} still waits for ${e.wait.label} to merge, and Kernel sends the brief then.` : e.started ? `Setup passed on Run again. ${name} was working already, and Kernel told it.` : `Setup passed on Run again, and ${name}'s brief was released.`
    case 'wait.started': return `Waits for ${e.wait?.label ?? 'another PR'} to merge.${e.wait?.why ? ` ${name} says: ${e.wait.why}` : ''} Kernel ${e.wait?.held === false ? `tells ${name} to bring its branch up to date with it` : `sends ${name} the brief`} when it does.`
    case 'wait.released': return `${upper(e.wait?.label ?? 'the PR it waited for')} merged, so Kernel ${e.wait?.held === false ? `told ${name} to bring its branch up to date with it and carry on` : `sent ${name} the brief`}.`
    case 'wait.broken': return `${name} is waiting for ${e.wait?.label ?? 'a PR'}, which was ${e.wait?.gone ?? 'closed'} without merging.`
    case 'wait.rebase_missing': return `${upper(e.wait?.label ?? 'the PR it waited for')} merged and Kernel asked ${name} to bring in ${e.wait?.onto ?? 'it'}, but the turn ended with ${name}'s branch still missing it.`
    case 'question': {
      const q = e.question
      if (!q) return `Asked you a question. ${name} ended the turn and waits for your answer.`
      const options = q.options?.length ? `\n  Options: ${q.options.map((o) => `"${o}"`).join(', ')}.` : ''
      return `Asked you: "${q.text}"${options}\n  ${name} ended the turn and waits for your answer.`
    }
    case 'handoff.proposed': {
      const p = e.proposal
      if (!p) return 'Proposed handing part of the work to another teammate.'
      return `Proposed handing a task to ${p.agent} (${p.agentId}): "${p.task}". Why: ${p.why} ${name} carries on with the rest.`
    }
    case 'shared': {
      const f = e.shared
      return f ? `Shared "${f.title}" v${f.version} (${KIND_LABEL[f.kind]}, ${f.source}, id ${f.sharedId}). The user can open it from this update.` : 'Shared a file.'
    }
    case 'limit': return limitSentence(e.limit)
    case 'limit.lifted': return `Working again${e.limit?.account ? ` on ${e.limit.account}` : ''}.`
    case 'review': {
      const r = e.review
      if (!r) return 'Sent a review.'
      const what = `${r.ofPr ? `PR #${r.ofPr} by ${r.ofName}` : `${r.ofName}'s work`} (workspace ${r.of})`
      // "The security review found..." since review kinds (KERNEL-549). A verdict from before has no kind.
      const by = (verb: string) => (r.lens ? `${reviewsText([r.lens])} ${verb}` : upper(verb))
      if (r.verdict === 'approved') return `${by('approved')} ${what}${r.current ? ', at its latest commit' : ''}.`
      const list = (r.blockers ?? []).map((x, i) => `  ${i + 1}. ${x.file ? `${x.file}${x.line ? `:${x.line}` : ''}: ` : ''}${x.text}`)
      const total = r.total ?? list.length
      const stuck = r.stillBlocked ? `, and it is ${stillBlockedText(r.stillBlocked).toLowerCase()}` : ''
      return [`${by('found')} ${total} ${total === 1 ? 'blocker' : 'blockers'} in ${what}${stuck}${total > list.length ? ` (the first ${list.length} below)` : ''}:`, ...list].join('\n')
    }
  }
}

/**
 * The event in a few words, for the card. A ready PR's review is a segment of its own (`reviewCard`). `held`: the review holds
 * the ready PR back (`reviewHolds`), so it reads as what it is, a PR whose checks passed (KERNEL-608).
 */
function cardText(e: TeamEvent, held = false): string {
  switch (e.kind) {
    case 'pr.opened': return e.pr ? `Opened PR #${e.pr}` : 'Opened a pull request'
    case 'pr.ready': return held ? 'Checks passed' : 'Ready to merge'
    // Only the card has it, after a ready PR: Kernel never records one as an event.
    case 'pr.review': return ''
    case 'pr.cifail': return 'Checks failed'
    case 'pr.changes': return 'Changes requested'
    case 'pr.conflict': return 'Has conflicts with its base branch'
    case 'pr.merged': return e.auto ? 'Merged automatically' : e.pr ? `Merged PR #${e.pr}` : 'Merged'
    case 'pr.closed': return `Closed ${prOf(e)} without merging`
    case 'pr.blocked': return `Blocked on GitHub: ${e.blocked ? blockedWhy[e.blocked] : "the branch's rules"}`
    case 'pr.unblocked': return 'GitHub no longer blocks it'
    case 'pr.updated': {
      const base = e.updated?.base ?? 'its base'
      return e.updated?.capped ? `Behind ${base} again, Kernel stopped updating it` : `Brought ${e.pr ? `#${e.pr}` : 'it'} up to date with ${base}, waiting for checks`
    }
    case 'turn': return 'Finished a turn'
    case 'error': return 'Stopped with an error'
    case 'crash': return relaunched(e) ? `Stopped when ${e.reason === QUIT_REASON ? 'Kernel quit' : 'Kernel closed'}` : 'Session ended unexpectedly'
    case 'setup.failed': return 'Setup failed'
    case 'setup.passed': return e.wait ? 'Setup passed, still waiting' : 'Setup passed'
    case 'wait.started': return `Waits for ${e.wait?.label ?? 'another PR'}`
    case 'wait.released': return `${upper(e.wait?.label ?? 'the PR it waited for')} merged`
    case 'wait.broken': return `${upper(e.wait?.label ?? 'the PR it waited for')} ${e.wait?.gone ?? 'closed'} without merging`
    case 'wait.rebase_missing': return `Didn't bring in ${e.wait?.label ?? 'the PR it waited for'}`
    case 'shared': return e.shared ? `Shared "${e.shared.title}"` : 'Shared a file'
    case 'question': return e.question ? `Asks: ${capText(e.question.text, CARD_MAX)}` : 'Asked a question'
    case 'handoff.proposed': return e.proposal ? `Proposes ${e.proposal.agent} for: ${capText(e.proposal.task, CARD_MAX)}` : 'Proposed a hand-off'
    case 'limit': {
      const l = e.limit
      const hit = `Hit ${limitName(l)}`
      if (l?.carried !== undefined) return l.carried && l.carried !== l.account ? `${hit}, now on ${l.carried}` : `${hit}, working again`
      if (l?.switching) return `${hit}, moving to ${l.switching.to ?? 'another account'}`
      return `Paused by ${limitName(l)}${until(l)}`
    }
    case 'limit.lifted': return `Working again${e.limit?.account ? ` on ${e.limit.account}` : ''}`
    case 'review': {
      const r = e.review
      if (!r) return 'Sent a review'
      const what = r.ofPr ? `PR #${r.ofPr}` : `${r.ofName}'s work`
      const n = r.total ?? r.blockers?.length ?? 0
      const by = (verb: string) => (r.lens ? `${kindsText([r.lens])} review ${verb}` : upper(verb))
      return r.verdict === 'approved' ? `${by('approved')} ${what}` : `${by('found')} ${n} ${n === 1 ? 'blocker' : 'blockers'} in ${what}`
    }
  }
}

/**
 * One workspace's events as they are worth sending now, oldest first: the last turn end, PR events once, the last PR
 * state event only while the PR is still in that state, the last verdict of each kind of review, and the newest share of
 * each file. A checks failure fixed since, or a ready PR whose checks run again, says nothing.
 */
export function collapse(events: TeamEvent[], ws: Workspace | undefined): TeamEvent[] {
  const sorted = [...events].sort((a, b) => a.n - b.n)
  const last = (test: (e: TeamEvent) => boolean) => sorted.filter(test).at(-1)
  const turn = last((e) => TURN_ENDS.has(e.kind))
  const state = last((e) => !!STATE_OF[e.kind])
  const setup = last((e) => e.kind === 'setup.failed' || e.kind === 'setup.passed')
  // The last verdict of each kind of review: a review workspace runs one chat per kind (KERNEL-549).
  const reviews = new Map<ReviewKind, TeamEvent>()
  for (const e of sorted) if (e.kind === 'review') reviews.set(e.review?.lens ?? 'code', e)
  const wait = last((e) => e.kind.startsWith('wait.'))
  const block = last((e) => e.kind === 'pr.blocked' || e.kind === 'pr.unblocked')
  const shares = new Map<string, TeamEvent>()
  for (const e of sorted) if (e.kind === 'shared' && e.shared) shares.set(e.shared.sharedId, e)
  const limit = last((e) => e.kind === 'limit')
  const lifted = last((e) => e.kind === 'limit.lifted')
  const updated = last((e) => e.kind === 'pr.updated')
  // Once per PR: after Continue moved the workspace on, its new PR's opening is news too.
  const seen = new Set<string>()
  return sorted.filter((e) => {
    if (TURN_ENDS.has(e.kind)) return e === turn
    // Without the workspace, as while events wait, the last state event is kept whatever the PR does next.
    if (STATE_OF[e.kind]) return e === state && (!ws || ws.prState === STATE_OF[e.kind])
    if (e.kind === 'setup.failed' || e.kind === 'setup.passed') return e === setup
    if (e.kind === 'review') return reviews.get(e.review?.lens ?? 'code') === e
    if (e.kind.startsWith('wait.')) return e === wait
    if (e.kind === 'shared') return !!e.shared && shares.get(e.shared.sharedId) === e
    // The last limit, and a carry-on only after it: one from before a new limit is over (KERNEL-777).
    if (e.kind === 'limit') return e === limit
    if (e.kind === 'limit.lifted') return e === lifted && (!limit || e.n > limit.n)
    // Kernel's last update of the PR's branch, or its stop, is the news (KERNEL-835).
    if (e.kind === 'pr.updated') return e === updated
    // GitHub's block on a ready PR: the last word only, and only while the PR still reads that way (KERNEL-401).
    if (e.kind === 'pr.blocked' || e.kind === 'pr.unblocked') {
      if (e !== block) return false
      if (!ws) return true
      return ws.prState === 'ready' && (e.kind === 'pr.blocked' ? ws.prBlocked === e.blocked : !ws.prBlocked)
    }
    // A close the PR has since left, by reopening or Continue, says nothing any more.
    if (e.kind === 'pr.closed' && ws && ws.prState !== 'closed') return false
    if (ONCE.has(e.kind)) { const key = `${e.kind}:${e.pr ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true }
    return true
  })
}

/**
 * One workspace in an update. `from` is the closed Lead chat it came from, when it isn't the target's own; `owner` handed it
 * off. `shares` are its shared files, which the card draws apart from `events`.
 */
interface Block { ws: Workspace; name: string; raw: TeamEvent[]; events: TeamEvent[]; shares: TeamEvent[]; reply?: string; summary?: boolean; status?: string; card: string[]; held: boolean; latest: number; from?: From; owner?: string; wake: Set<TeamEvent>; todo: string[] }

/** Events from one source chat: the target's own, or a closed chat's that now go to the target. `owner` handed them off. */
interface Source { events: TeamEvent[]; from?: From; owner?: string }

/** Where routed work came from: a closed tab of the target's own chat (`tab`), or another Lead chat that is closed (KERNEL-337). */
export interface From { title: string; tab?: boolean }

/** Reviews of a workspace's PR as Kernel knows them (KERNEL-130), kind by kind (KERNEL-549). Kinds come in REVIEW_KINDS' order. */
export interface ReviewState {
  /** Kinds that approved the PR's latest commit, where no verdict of the same kind found blockers on it. */
  approved: ReviewKind[]
  /** Kinds whose verdict on the latest commit found blockers that the user didn't overrule. */
  blocking: ReviewKind[]
  /** Kinds whose blockers on the latest commit the user overruled (KERNEL-732). */
  overruled?: ReviewKind[]
  /** A verdict on the latest commit found blockers. */
  blockers: boolean
  /** Kinds whose review is setting up or working and hasn't sent a verdict on the latest commit. */
  reviewing: ReviewKind[]
  /** A review is setting up or working, or Kernel is starting one. */
  inProgress: boolean
  /** Required kinds that reviewed the PR and haven't approved its latest commit. */
  waiting: ReviewKind[]
  /** Every verdict there is was of an earlier commit. */
  stale?: boolean
  /** The newest review workspace still open, to ask for another pass instead of a new one. `failed`: its setup failed. */
  open?: { workspaceId: string; agentId: string; name: string; failed?: boolean }
  /**
   * Required kinds whose review waits for usage to drop below the limit (KERNEL-552). They count as in progress, so a merge
   * waits for them, but other kinds' blockers don't (KERNEL-633).
   */
  held?: ReviewKind[]
  /** Kernel is starting a review round (KERNEL-633). */
  starting?: boolean
  /** Optional kinds the head's review round skipped to save usage (KERNEL-552). */
  skipped?: ReviewKind[]
  /**
   * The PR is still blocked after `rounds` review rounds, `[review] rounds` or more, by `kinds`' blockers on the last round's
   * head, so Kernel starts no more by itself (KERNEL-552). Unset while a review runs.
   */
  stillBlocked?: { rounds: number; kinds: ReviewKind[] }
  /**
   * Automatic review is off, and it alone kept Kernel from starting a review of the head: the project's `[review]` asks for
   * one and nobody asked for one meanwhile (feat-automatic-review-off-by-default).
   */
  notStarted?: boolean
}

/**
 * The review holds a ready PR back: blockers on its head commit, read kind by kind as the merge rule reads them, or blockers
 * left after the last review round Kernel runs (KERNEL-608).
 */
const reviewHolds = (review: ReviewState | undefined): boolean => !!review && (review.blockers || !!review.stillBlocked)

/** A review is setting up or working, or Kernel is starting one, not only kinds waiting for usage to drop (KERNEL-633). */
const reviewRuns = (review: ReviewState): boolean => review.reviewing.length > 0 || !!review.starting || (review.inProgress && !review.held?.length)

/**
 * Every review that looked at the PR approved its latest commit or had its blockers on it overruled (KERNEL-732), and none is
 * still to report.
 */
const allApproved = (review: ReviewState | undefined): boolean => !!(review?.approved.length || review?.overruled?.length) && !review.waiting.length && !review.blockers && !review.inProgress

/** "the UX review", "the code and UX reviews", for the middle of a sentence. */
const reviewsOf = (kinds: readonly ReviewKind[]) => reviewsText(kinds).replace(/^The/, 'the')

/** "Still blocked after 2 review rounds", as the card and the Lead's text say it (KERNEL-552). */
const stillBlockedText = (n: number) => `Still blocked after ${n} review ${n === 1 ? 'round' : 'rounds'}`

/** "Skipped the UX review to save usage" (KERNEL-552). */
const skippedText = (kinds: readonly ReviewKind[]) => `Skipped ${reviewsOf(kinds)} to save usage`

/** "The code review waits for usage to drop below the limit" (KERNEL-552). */
const heldText = (kinds: readonly ReviewKind[]) => `${reviewsText(kinds)} ${kinds.length === 1 ? 'waits' : 'wait'} for usage to drop below the limit`

/** Where a PR that passed checks stands with its review, for the Lead's text, or nothing when Kernel can't tell. */
function reviewStatus(review: ReviewState | undefined): string {
  if (!review) return ''
  const skipped = review.skipped?.length ? ` ${skippedText(review.skipped)}.` : ''
  return `${reviewStanding(review)}${skipped}`
}

function reviewStanding(review: ReviewState): string {
  if (review.blockers) return `${reviewsText(review.blocking)} found blockers.${review.stillBlocked ? ` ${stillBlockedText(review.stillBlocked.rounds)}.` : ''}`
  if (review.stillBlocked) return `${stillBlockedText(review.stillBlocked.rounds)}, so Kernel didn't review its new commits.`
  if (review.inProgress) {
    const parts = [...(review.reviewing.length ? [`${reviewsText(review.reviewing)} ${review.reviewing.length === 1 ? 'is' : 'are'} running.`] : []), ...(review.held?.length ? [`${heldText(review.held)}.`] : [])]
    return parts.length ? parts.join(' ') : 'Kernel is starting its review.'
  }
  if (allApproved(review)) return [...(review.approved.length ? [`${reviewsText(review.approved)} approved it.`] : []), ...(review.overruled?.length ? [`The user overruled ${reviewsOf(review.overruled)}${review.overruled.length > 1 ? "'" : "'s"} blockers.`] : [])].join(' ')
  if (review.stale || review.waiting.length) return `${review.open ? `${review.open.name}'s review` : 'Its last review'} was of a different commit.`
  return 'Nobody has reviewed it yet.'
}

/**
 * The same review in the card's words (KERNEL-411), segments of their own after Ready to merge, or none when Kernel can't
 * tell. A review round that skipped a kind, or waits for usage, says so in a segment of its own (KERNEL-552).
 */
function reviewCard(review: ReviewState | undefined): string[] {
  if (!review) return []
  const skipped = review.skipped?.length ? [skippedText(review.skipped)] : []
  const stuck = review.stillBlocked ? [stillBlockedText(review.stillBlocked.rounds)] : []
  if (review.blockers) return [reviewPhrase({ blockers: { lenses: review.blocking } }).text, ...stuck, ...skipped]
  if (stuck.length) return [...stuck, ...skipped]
  if (review.inProgress) {
    const held = review.held?.length ? [`${kindsText(review.held)} ${review.held.length === 1 ? 'review waits' : 'reviews wait'} for usage to drop`] : []
    return [...(review.reviewing.length || !held.length ? [reviewPhrase({ reviewing: review.reviewing }).text] : []), ...held, ...skipped]
  }
  if (allApproved(review)) return [...(review.approved.length ? [reviewPhrase({ approved: review.approved }).text] : []), ...(review.overruled?.length ? ['Blockers overruled'] : []), ...skipped]
  if (review.stale || review.waiting.length) return [reviewPhrase({ stale: true }).text, ...skipped]
  return [reviewPhrase({}).text, ...skipped]
}

/** PR states that mean the PR is still being created or checked, so a turn that just ended isn't news on its own. */
const SETTLING: PrState[] = ['creating', 'checks', 'resolving', 'merging']

export class LeadUpdates {
  /** Keyed by the owning Lead chat's id, or `project:<id>` for workspaces no Lead chat handed off. */
  private pending = new Map<string, Pending>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** When the first event of the batch a timer waits on came, per key. The batch goes five seconds after it at the latest. */
  private since = new Map<string, number>()
  /** When each key's events were due to go, and why they waited since, for the delivery log (KERNEL-637). */
  private ready = new Map<string, number>()
  private heldBy = new Map<string, string>()
  /** Flushes asked for once the current step is done, by project, or `*` for every project (`flushSoon`). */
  private soon = new Map<string, NodeJS.Timeout>()
  /** The last PR state seen per workspace, to tell "opened" from a later change. */
  private prev = new Map<string, PrState>()
  /** The head commit each PR was on when an update told the Lead it was ready, until the PR leaves ready and checks. */
  private toldReady = new Map<string, string>()
  /** GitHub's block on each ready PR as the Lead last heard it, until it hears the block lifted or the PR leaves ready and checks (KERNEL-401). */
  private toldBlocked = new Map<string, PrBlocked>()
  /** Teammate workspaces whose limit woke the Lead with the paused line, until it hears they carry on (KERNEL-777). */
  private toldLimit = new Set<string>()
  /**
   * Lead chats the user stopped. Stop means stop: their updates wait for the chat's next turn that ends normally,
   * usually the user's next message, instead of starting a Kernel turn right after the Stop (KERNEL-122).
   */
  private stopped = new Set<string>()
  /**
   * Review chats whose running turn sent a verdict, or review workspaces for a verdict that named no chat. That turn's end isn't
   * news of its own (KERNEL-130). By chat, since a review workspace runs one chat per kind of review (KERNEL-549).
   */
  private submitted = new Set<string>()
  /**
   * Teammate workspaces whose PR Kernel is reading after a turn ended. Their updates wait for the read, so a PR the turn
   * opened or pushed to speaks for the turn however long GitHub takes, instead of the turn waking the Lead on its own.
   */
  private reading = new Map<string, number>()
  /** Teammates whose running turn set a wait of their own. Their updates wait for that turn to end (KERNEL-262). */
  private waitTurns = new Set<string>()
  /** PRs Kernel is merging by itself, and why, until their merge push (KERNEL-556). */
  private auto = new Map<string, AutoMerged>()
  /** Why Kernel didn't merge a ready PR by itself with the user's auto-merge on, until the PR leaves ready (KERNEL-556). */
  private refused = new Map<string, string>()
  /** Updates waiting for each terminal Lead tab, by chat id, oldest first (KERNEL-1000). */
  private seatQueue = new Map<string, SeatUpdate[]>()
  private detached = false
  private seq = 0
  private off: () => void = () => undefined

  constructor(private d: LeadUpdateDeps) {}

  attach() {
    this.detached = false
    for (const w of this.d.store.workspaces()) this.prev.set(w.id, w.prState)
    this.load()
    const on = (e: PushEvent) => {
      if (e.type === 'pr') this.onPr(e.workspaceId, e.state)
      else if (e.type === 'pr.blocked') { const ws = this.d.store.workspace(e.workspaceId); if (ws) this.blockedNews(ws) }
      // However the turn ended, a stop or archive included, which never reach turnDone (KERNEL-262).
      else if (e.type === 'chat.running' && !e.running) this.waitTurnOver(e.chatId)
    }
    bus.on('push', on)
    this.off = () => bus.off('push', on)
  }

  detach() {
    this.detached = true
    this.off()
    for (const t of [...this.timers.values(), ...this.soon.values()]) clearTimeout(t)
    this.timers.clear()
    this.soon.clear()
    this.since.clear()
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
        const events = (p.events ?? []).filter((e) => { const ws = this.d.store.workspace(e.workspaceId); return !!ws && !this.silent(ws) })
        if (events.length) { this.pending.set(key, { ...p, events }); this.ready.set(key, Date.now()) }
      }
      for (const id of saved.stopped ?? []) { const chat = this.d.store.chat(id); if (chat && !chat.closed) this.stopped.add(id) }
      for (const [id, blocked] of saved.toldBlocked ?? []) if (this.d.store.workspace(id)) this.toldBlocked.set(id, blocked)
      for (const id of saved.toldLimit ?? []) if (this.d.store.workspace(id)) this.toldLimit.add(id)
      for (const [id, queue] of saved.seatQueue ?? []) if (queue.length) this.seatQueue.set(id, queue)
    } catch (e) {
      this.warn('could not read the saved updates, so they were dropped', e)
      this.pending.clear(); this.ready.clear(); this.stopped.clear(); this.toldBlocked.clear(); this.toldLimit.clear(); this.seatQueue.clear()
    }
    this.save()
  }

  private save() {
    this.d.store.saveMeta<Saved>(SAVED, { v: 1, seq: this.seq, pending: [...this.pending], stopped: [...this.stopped], ...(this.toldBlocked.size ? { toldBlocked: [...this.toldBlocked] } : {}), ...(this.toldLimit.size ? { toldLimit: [...this.toldLimit] } : {}), ...(this.seatQueue.size ? { seatQueue: [...this.seatQueue] } : {}) })
  }

  /**
   * A turn ended. A teammate's finished turn is news for the Lead; the end of the Lead's own turn is a chance to deliver,
   * unless the user stopped it.
   */
  turnDone(ws: Workspace, chat: Chat, t: TurnDone, limit?: LimitNews) {
    if (t.lead || this.d.isLead(ws)) {
      if (t.interrupted) { this.stopped.add(chat.id); this.save(); return }
      if (this.stopped.delete(chat.id)) this.save()
      this.flush(ws.projectId)
      return
    }
    this.waitTurns.delete(ws.id)
    // A reviewer's turn that sent its verdict has the verdict to speak for it, however the turn ends (KERNEL-130). One the Lead
    // started carries the reviewer's reply too, so the Lead hears the answer to its own message (feat-review-messages-reach-named).
    const verdictTurn = this.submitted.delete(chat.id) || this.submitted.delete(ws.id)
    if (verdictTurn && t.by === 'lead') { this.askedReply(ws, chat, t.interrupted); return }
    if (t.interrupted || verdictTurn) return
    // A limit cut the turn off, and its reply is the limit's text. What Kernel does about it is the news (KERNEL-777). Messages
    // that wait in the chat wait for its carry-on.
    if (t.limit) { if (!t.refused || limit) this.add(ws, { kind: 'limit', by: t.by, ...(limit ? { limit } : {}) }); return }
    if (t.queued) return
    if (!t.ok) { this.add(ws, { kind: 'error', by: t.by }); return }
    const reply = [...this.d.store.items(chat.id)].reverse().find((i) => i.kind === 'text')
    this.add(ws, { kind: 'turn', by: t.by, reply: reply?.kind === 'text' ? capText(reply.text, REPLY_KEPT) : undefined })
  }

  /**
   * A reviewer's turn the Lead started ended after it sent its verdict. The verdict waited for the turn, and now takes the
   * reviewer's last reply with it, unless the turn was stopped.
   */
  private askedReply(ws: Workspace, chat: Chat, interrupted: boolean) {
    const kind = chat.lens?.kind ?? 'code'
    // Only what the reviewer wrote after the Lead's message, never a reply from an earlier turn.
    const items = [...this.d.store.items(chat.id)].reverse()
    const since = items.findIndex((i) => i.kind === 'user')
    const reply = interrupted ? undefined : items.slice(0, since < 0 ? undefined : since).find((i) => i.kind === 'text')
    let changed = false
    for (const p of this.pending.values()) {
      for (const e of p.events) {
        if (e.workspaceId !== ws.id || !e.review?.asked || (e.review.lens ?? 'code') !== kind || e.review.reply !== undefined) continue
        if (reply?.kind === 'text') { e.review.reply = capText(reply.text, REPLY_KEPT); changed = true }
      }
    }
    if (changed) this.save()
    this.rearm(ws)
  }

  /** A teammate's chat stopped running. A wait it set mid-turn no longer holds its updates. */
  private waitTurnOver(chatId: string) {
    const ws = this.d.store.workspace(this.d.store.chat(chatId)?.workspaceId ?? '')
    if (ws && this.waitTurns.delete(ws.id)) this.rearm(ws)
  }

  /**
   * Kernel is merging the workspace's PR by itself, and `auto` says why, so its merge reads "Merged automatically" (KERNEL-556).
   * Without `auto`, the merge it started failed.
   */
  autoMerging(workspaceId: string, auto?: AutoMerged) {
    this.refused.delete(workspaceId)
    if (auto) this.auto.set(workspaceId, auto)
    else this.auto.delete(workspaceId)
  }

  /** Why Kernel didn't merge the ready PR by itself with auto-merge on. The ready to merge line says so (KERNEL-556). */
  autoMergeRefused(workspaceId: string, why: string) { this.refused.set(workspaceId, why) }

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
    // A verdict about the PR waited for the read too (KERNEL-556).
    for (const [key, p] of this.pending) if (p.events.some((e) => e.review?.of === workspaceId)) this.arm(key, p.projectId)
  }

  /**
   * A teammate's workspace setup failed, or passed on Run again (KERNEL-126). `told` marks a failure the Lead already read in create_workspace's result, which rides along
   * instead of waking it again.
   */
  setup(ws: Workspace, ok: boolean, o: { told?: boolean; started?: boolean; code?: number | null | 'timeout'; wait?: WaitNews } = {}) {
    if (this.d.isLead(ws)) return
    this.add(ws, ok ? { kind: 'setup.passed', ...(o.wait ? { wait: o.wait } : {}), ...(o.started ? { started: true } : {}) } : { kind: 'setup.failed', ...(o.code !== undefined ? { code: o.code } : {}), ...(o.told ? { told: true } : {}), ...(o.started ? { started: true } : {}) })
  }

  /**
   * A teammate's wait on other PRs started, was released by their merge, or broke because one closed or was archived
   * without merging (KERNEL-259). Only a broken wait, and a started one the Lead didn't set itself, wake the Lead.
   */
  waits(ws: Workspace, kind: 'wait.started' | 'wait.released' | 'wait.broken' | 'wait.rebase_missing', wait: WaitNews) {
    if (this.d.isLead(ws)) return
    // A teammate set it mid-turn (KERNEL-262). It waits for that turn to end, so both wake the Lead once, together.
    if (kind === 'wait.started' && !wait.told && !wait.held) this.waitTurns.add(ws.id)
    this.add(ws, { kind, wait: wait.why ? { ...wait, why: capText(wait.why, WHY_MAX) } : wait })
  }

  /**
   * A teammate shared a file (KERNEL-302). It never wakes the Lead on its own: it goes out with the next update that does,
   * which lists it for the Lead to pass on. The Lead's own shares are in its own chat already.
   */
  shared(ws: Workspace, file: SharedFile, version: SharedVersion) {
    if (this.d.isLead(ws)) return
    this.add(ws, { kind: 'shared', shared: { sharedId: file.id, version: version.n, title: file.title, kind: file.kind, source: file.source } })
  }

  /**
   * A teammate asked the Lead with ask_lead (KERNEL-747). It ends its turn right after, so the question waits for that turn
   * to end, the way a wait it set does, and both wake the Lead once, together.
   */
  asked(ws: Workspace, text: string, options?: string[]) {
    if (this.d.isLead(ws)) return
    this.waitTurns.add(ws.id)
    const kept = options?.map((o) => capText(o.trim(), OPTION_MAX)).filter(Boolean).slice(0, OPTIONS_MAX)
    this.add(ws, { kind: 'question', question: { text: capText(text.trim(), ASK_MAX), ...(kept?.length ? { options: kept } : {}) } })
  }

  /**
   * A teammate proposed handing part of its work to another agent with propose_handoff (KERNEL-747). The teammate carries on,
   * so it doesn't wait for the turn: the Lead can take it to the user while the work goes on. Kernel never creates the workspace.
   */
  proposed(ws: Workspace, p: { agentId: string; agent: string; task: string; why: string }) {
    if (this.d.isLead(ws)) return
    this.add(ws, { kind: 'handoff.proposed', proposal: { ...p, task: capText(p.task.trim(), ASK_MAX), why: capText(p.why.trim(), ASK_MAX) } })
  }

  /**
   * A reviewer's submit_review from the chat `chatId` (KERNEL-130), on the reviewer's own workspace. `asked`: the Lead started
   * the turn with message_agent. Then the verdict waits for the turn to end and takes the reviewer's reply with it, and it
   * always wakes the Lead, which hears the answer to its own message (feat-review-messages-reach-named).
   */
  reviewed(reviewer: Workspace, of: Workspace, v: ReviewVerdict, chatId?: string, o: { asked?: boolean } = {}) {
    if (this.d.isLead(reviewer)) return
    // The turn that sent the verdict ends soon after; the verdict speaks for it.
    this.submitted.add(chatId ?? reviewer.id)
    if (o.asked) this.waitTurns.add(reviewer.id)
    this.add(reviewer, { kind: 'review', review: {
      verdict: v.verdict, ...(v.lens ? { lens: v.lens } : {}), summary: capText(v.summary, REPLY_KEPT),
      ...(v.blockers?.length ? { blockers: v.blockers.slice(0, MAX_BLOCKERS).map((b) => ({ ...b, text: capText(b.text, BLOCKER_MAX) })), total: v.blockers.length } : {}),
      of: of.id, ofName: this.d.agentName(of.projectId, of.agentId) ?? of.agentId, ...(of.prNumber ? { ofPr: of.prNumber } : {}),
      ...(v.sha ? { sha: v.sha } : {}), current: !v.sha || !of.prHead || v.sha === of.prHead, ...(o.asked ? { asked: true } : {})
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

  /**
   * A teammate a usage limit cut off carries on, on `account`: another account Kernel moved its provider to, or the same one
   * after the reset (KERNEL-777). It wakes the Lead only to correct a pause the Lead heard about.
   */
  limitLifted(ws: Workspace, limit: Pick<LimitNews, 'provider' | 'account'>) {
    if (this.d.isLead(ws)) return
    this.add(ws, { kind: 'limit.lifted', limit: { provider: limit.provider, ...(limit.account ? { account: limit.account } : {}) } })
  }

  /**
   * Kernel's move of `provider` off a limit waits: no account has headroom, or the one that does needs a sign-in or Keychain
   * access, or the switch failed (KERNEL-777). Limits held back while it moved now wake the Lead with the paused line.
   */
  /**
   * Kernel brought a teammate's PR up to date with `base` before merging it by itself, and waits for its checks (KERNEL-835).
   * It rides along with the next update that wakes the Lead. `capped`: the base moved past it again after that many updates,
   * so Kernel stopped, and the Lead tells the user.
   */
  branchUpdated(ws: Workspace, base: string, o: { capped?: number } = {}) {
    if (this.silent(ws)) return
    this.add(ws, { kind: 'pr.updated', updated: { base, ...(o.capped ? { capped: o.capped } : {}) } })
  }

  limitStuck(provider: Provider, o: { stuck: 'full' | 'signIn'; resetsAt?: number }) {
    for (const [key, p] of this.pending) {
      let changed = false
      p.events = p.events.map((e) => {
        if (e.kind !== 'limit' || e.limit?.provider !== provider || !e.limit.switching) return e
        // A teammate that already carried on has nothing to wait for.
        if (p.events.some((x) => x.kind === 'limit.lifted' && x.workspaceId === e.workspaceId && x.n > e.n)) return e
        changed = true
        const { switching: _, ...was } = e.limit
        return { ...e, limit: { ...was, stuck: o.stuck, ...(o.resetsAt ? { resetsAt: o.resetsAt } : {}) } }
      })
      if (!changed) continue
      this.save()
      this.arm(key, p.projectId)
    }
  }

  private onPr(workspaceId: string, state: PrState) {
    const before = this.prev.get(workspaceId) ?? 'none'
    this.prev.set(workspaceId, state)
    const auto = state === 'merged' ? this.auto.get(workspaceId) : undefined
    if (state === 'merged') this.auto.delete(workspaceId)
    if (state !== 'ready') this.refused.delete(workspaceId)
    const ws = this.d.store.workspace(workspaceId)
    if (!ws || this.silent(ws)) return
    const opened = (before === 'none' || before === 'creating') && ON_GITHUB.includes(state) && state !== 'merged' && state !== 'closed'
    if (opened) this.add(ws, { kind: 'pr.opened' })
    const kind = PR_EVENT[state]
    // Ready again on the commit the Lead already heard was ready, after only checks, is old news. GitHub checks a PR for
    // conflicts again each time its base moves, and it reads as checks until then (KERNEL-283).
    const again = state === 'ready' && before === 'checks' && !!ws.prHead && this.toldReady.get(workspaceId) === ws.prHead
    if (state !== 'ready' && state !== 'checks') {
      this.toldReady.delete(workspaceId)
      if (this.toldBlocked.delete(workspaceId)) this.save()
    }
    // Ready again on the same head is how a PR usually falls behind its base: the base moved and GitHub checked it again.
    // The block, or its end, is the news then (KERNEL-401).
    if (again) this.blockedNews(ws)
    if (kind && !again) this.add(ws, { kind, ...(auto ? { auto } : {}) })
    // A PR that moved on without news, as checks starting again, still waits for things to settle before its events go.
    else if (!opened) this.rearm(ws)
  }

  /**
   * GitHub's block on a ready PR against what the Lead last heard (KERNEL-401): a block, or a new reason, is news, and so is
   * the end of a block the Lead heard about. An end it never heard of is no news. Called on the 'pr.blocked' push, and on a
   * ready push that `onPr` lets pass as nothing new.
   */
  private blockedNews(ws: Workspace) {
    if (this.silent(ws) || ws.prState !== 'ready') return
    const told = this.toldBlocked.get(ws.id)
    if (ws.prBlocked && ws.prBlocked !== told) this.add(ws, { kind: 'pr.blocked', blocked: ws.prBlocked })
    else if (!ws.prBlocked && told) this.add(ws, { kind: 'pr.unblocked' })
  }

  /** The chat that hears about the workspace: the one that handed it off, or the Build here chat it is the PR of (KERNEL-778). */
  private ownerOf(ws: Workspace) { return ws.leadChatId ?? this.d.ownChat?.(ws) }

  /** The Lead's own workspace, whose news never reaches a chat. A Build here chat's PR does (KERNEL-778). */
  /** The Build here chat's own workspace, whose PR news is rows and wakes the chat only when the user has to act (KERNEL-990). */
  private isSelf(ws: Workspace) { return this.d.isLead(ws) && !!this.d.ownChat?.(ws) }

  private silent(ws: Workspace) { return this.d.isLead(ws) && !this.d.ownChat?.(ws) }

  private keyOf(ws: Workspace) { return this.ownerOf(ws) ?? `project:${ws.projectId}` }

  private add(ws: Workspace, e: Omit<TeamEvent, 'n' | 'workspaceId' | 'pr' | 'prTitle'>) {
    if (!this.d.enabled()) return
    const key = this.keyOf(ws)
    const p = this.pending.get(key) ?? { projectId: ws.projectId, owner: this.ownerOf(ws), events: [] }
    p.events.push({ ...e, n: this.seq++, at: Date.now(), workspaceId: ws.id, ...(ws.prNumber ? { pr: ws.prNumber } : {}), ...(ws.prTitle ? { prTitle: ws.prTitle } : {}) })
    // Events that wait for something to wake the Lead can wait a long time. Only what could still be sent is kept, so a
    // workspace holds a handful of events however long it waits (KERNEL-121).
    const mine = p.events.filter((x) => x.workspaceId === ws.id)
    const kept = new Set(collapse(mine, undefined))
    p.events = p.events.filter((x) => x.workspaceId !== ws.id || kept.has(x))
    this.pending.set(key, p)
    this.save()
    if (!this.since.has(key)) this.since.set(key, Date.now())
    this.arm(key, ws.projectId)
  }

  /**
   * Waits for the batch to go quiet: `delayMs` after now, but no later than `maxDelayMs` after the batch's first event, so
   * events that keep coming can't hold it back for good (KERNEL-637). A wait on purpose, as for a PR read, holds it apart.
   */
  private arm(key: string, projectId: string) {
    const old = this.timers.get(key)
    if (old) clearTimeout(old)
    const now = Date.now()
    const since = this.since.get(key) ?? now
    this.since.set(key, since)
    const due = Math.min(now + (this.d.delayMs ?? 2000), since + (this.d.maxDelayMs ?? 5000))
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      this.since.delete(key)
      if (!this.ready.has(key)) this.ready.set(key, Date.now())
      this.flush(projectId)
    }, Math.max(0, due - now)))
  }

  /** Waits again for a workspace with events still pending. */
  private rearm(ws: Workspace) {
    const key = this.keyOf(ws)
    if (this.pending.get(key)?.events.some((e) => e.workspaceId === ws.id)) this.arm(key, ws.projectId)
  }

  /**
   * Sends what's waiting in the project to each Lead chat that can take it now, one message per chat. A chat waits until
   * every batch headed for it has gone quiet, so a closed chat's updates ride along with its own. Kernel also calls this
   * on its PR poll, so a pause or a busy Lead chat only delays its own updates.
   */
  flush(projectId: string) {
    this.rehomeGone()
    const waiting = [...this.pending].filter(([, p]) => p.projectId === projectId && p.events.length)
    if (!waiting.length) return
    const changed = { any: false }
    try { this.deliver(projectId, waiting, changed) } catch (e) { this.warn(`could not deliver the updates waiting in project ${projectId}`, e) } finally { if (changed.any) this.save() }
  }

  /**
   * Flushes the project, or every project, once the current step is done (KERNEL-637). Kernel calls it when a chat stops running or
   * its queue empties, and when a pause or another hold lifts, so an update `post` refused goes the moment the Lead can take
   * it rather than at the PR poll. After the step, so a Stop or a crash has marked the chat by then.
   */
  flushSoon(projectId?: string) {
    const at = projectId ?? '*'
    if (this.detached || this.soon.has(at) || this.soon.has('*')) return
    if (![...this.pending.values()].some((p) => (!projectId || p.projectId === projectId) && p.events.length)) return
    this.soon.set(at, setTimeout(() => {
      this.soon.delete(at)
      if (this.detached) return
      if (projectId) this.flush(projectId)
      else this.flushAll()
    }, 0))
  }

  /**
   * A chat stopped running, or its queue emptied, so a Lead chat may take its update now, or a slot freed for one. Every project
   * with updates waiting tries, on the next step. It reads no database here: it runs inside the push, which must never throw.
   */
  chatFreed() { this.flushSoon() }

  private warn(what: string, e: unknown) { this.write('warn', `[lead-updates] ${what}: ${e instanceof Error ? e.message : String(e)}`) }

  private write(level: 'info' | 'warn', line: string) {
    if (this.d.log) this.d.log(level, line)
    else if (level === 'warn') console.warn(line)
    else console.info(line)
  }

  private deliver(projectId: string, waiting: [string, Pending][], changed: { any: boolean }) {
    const drop = (key: string) => { this.ready.delete(key); this.heldBy.delete(key); if (this.pending.delete(key)) changed.any = true }
    const hold = (keys: string[], why: string) => { for (const key of keys) if (this.ready.has(key)) this.heldBy.set(key, why) }
    if (!this.d.enabled()) { for (const [key] of waiting) if (!this.timers.has(key)) drop(key); return }
    const byChat = new Map<string, { chat: Chat; sources: Source[]; keys: string[]; quiet: boolean }>()
    for (const [key, p] of waiting) {
      // A verdict waits for its PR's read too, as auto-merge's, so it never calls a PR Kernel is merging ready to merge (KERNEL-556).
      const reading = p.events.some((e) => this.reading.has(e.workspaceId) || (!!e.review && this.reading.has(e.review.of)))
      const waitTurn = p.events.some((e) => this.waitTurns.has(e.workspaceId))
      const quiet = !this.timers.has(key) && !reading && !waitTurn
      if (reading) hold([key], 'reading')
      else if (waitTurn) hold([key], 'waitTurn')
      let t = this.d.target(projectId, p.owner)
      if (!t && this.d.open) {
        // No Lead tab is open. Once quiet, an update that needs the Lead opens one (KERNEL-365). The rest wait for the next
        // update that does, as they would with a tab open, and one with nothing left to say goes.
        if (!quiet) continue
        const alone = this.compose(projectId, [{ events: p.events, owner: p.owner }])
        if (alone && !alone.wakes) continue
        const opened = alone && this.d.open(projectId, p.owner)
        // Kernel is starting a Lead chat for it (KERNEL-405). The update waits for it, and goes once its setup passed.
        if (opened === 'opening') continue
        t = opened
      }
      if (!t) { if (!this.timers.has(key)) drop(key); continue }
      const group = byChat.get(t.chat.id) ?? { chat: t.chat, sources: [], keys: [], quiet: true }
      group.sources.push({ events: p.events, from: t.from, owner: p.owner })
      group.keys.push(key)
      group.quiet &&= quiet
      byChat.set(t.chat.id, group)
    }
    for (const g of byChat.values()) {
      if (!g.quiet) continue
      if (this.stopped.has(g.chat.id)) { hold(g.keys, 'stopped'); continue }
      const message = this.compose(projectId, g.sources)
      if (message?.display.length) this.show(message.display, g, changed)
      // Everything that waited was overtaken, as a failed check fixed since. There is nothing left to say.
      if (!message || !message.update.rows.length) { for (const key of g.keys) drop(key); continue }
      // Nothing needs the Lead yet. It all waits for the next update that does (KERNEL-121).
      if (!message.wakes) { hold(g.keys, 'quiet'); continue }
      // A terminal Lead is never sent a turn. What needs it waits for its next prompt or check_team (KERNEL-1000).
      const seat = g.chat.kind === 'terminal'
      if (seat) this.enqueue(g.chat, message)
      else if (!this.d.post(g.chat.id, message.text, message.update)) { hold(g.keys, this.d.holdOf?.(g.chat.id) ?? 'refused'); continue }
      // Only what went out, or what it overtook, leaves. Workspaces past the 8th wait for the next update (KERNEL-637).
      const now = Date.now()
      const due = Math.min(...g.keys.map((key) => this.ready.get(key) ?? now))
      const why = g.keys.map((key) => this.heldBy.get(key)).find((x) => x) ?? 'none'
      const at = g.sources.flatMap((s) => s.events.filter((e) => message.sent.has(e) && e.at !== undefined).map((e) => e.at!))
      let carried = 0
      for (const key of g.keys) {
        const p = this.pending.get(key)
        const rest = p?.events.filter((e) => !message.sent.has(e)) ?? []
        if (!p || !rest.length) { drop(key); continue }
        p.events = rest
        carried += rest.length
        this.ready.set(key, now)
        this.heldBy.delete(key)
        changed.any = true
      }
      // Timings only, never the message or anything from it.
      this.write('info', `[lead-updates] delivered ${JSON.stringify({ projectId, chatId: g.chat.id, workspaces: message.update.rows.length, ageMs: at.length ? now - Math.min(...at) : null, heldMs: now - due, heldBy: why, carried, leftOut: message.update.omitted ?? 0 })}`)
      for (const row of message.update.rows) {
        const w = this.d.store.workspace(row.workspaceId)
        if (w?.prHead && row.events.some((e) => e.kind === 'pr.ready')) this.toldReady.set(row.workspaceId, w.prHead)
        // What the Lead now knows of GitHub's block on the PR: a ready PR's update says it either way (KERNEL-401).
        if (row.events.some((e) => e.kind === 'pr.ready' || e.kind === 'pr.blocked' || e.kind === 'pr.unblocked')) {
          if (w?.prState === 'ready' && w.prBlocked) this.toldBlocked.set(row.workspaceId, w.prBlocked)
          else this.toldBlocked.delete(row.workspaceId)
          changed.any = true
        }
      }
      // What the Lead now knows of each teammate a limit stopped: paused, or carrying on again (KERNEL-777).
      message.told.forEach((t, i) => {
        for (const e of t.events) {
          if (e.kind === 'limit.lifted' || (e.kind === 'limit' && e.limit?.carried !== undefined)) { if (this.toldLimit.delete(t.ws.id)) changed.any = true }
          else if (e.kind === 'limit' && message.update.rows[i]?.events.some((x) => x.kind === 'limit' && x.actionable)) { this.toldLimit.add(t.ws.id); changed.any = true }
        }
      })
      if (!seat) {
        this.d.delivered?.(projectId, g.chat, message.update)
        this.d.opened?.(g.chat, message.told)
      }
    }
  }

  /** Keeps a terminal tab's update, and tells the user a tab of theirs has news that needs it (KERNEL-1000). */
  private enqueue(chat: Chat, m: { text: string; update: TeamUpdate; told: { ws: Workspace; name: string; events: TeamEvent[] }[] }) {
    const told = m.told.map((t) => ({ workspaceId: t.ws.id, name: t.name, events: t.events }))
    const asks = told.filter((t) => t.events.some((e) => e.kind === 'question')).map((t) => t.workspaceId)
    this.keep(chat, { text: m.text, update: m.update, told, asks })
  }

  /** Puts `u` on the queue of the terminal tab `chat`, and raises its inbox rows (KERNEL-1000). */
  private keep(chat: Chat, u: SeatUpdate) {
    const { told } = u
    this.seatQueue.set(chat.id, [...(this.seatQueue.get(chat.id) ?? []), u])
    this.seatChanged(chat)
    const ws = this.d.store.workspace(chat.workspaceId)
    const project = ws && this.d.store.project(ws.projectId)
    const where = project ? ` · ${project.name}` : ''
    for (const t of told) {
      const q = t.events.find((e) => e.kind === 'question')?.question
      if (!q) continue
      this.d.notify?.({ id: askId(chat.id, t.workspaceId), title: `${t.name} asks: ${capText(q.text, CARD_MAX)}`, sub: `Question${where}`, heading: `${t.name} has a question for ${chat.title}`, body: q.text, projectId: ws?.projectId, workspaceId: t.workspaceId, chatId: chat.id, ask: { workspaceId: t.workspaceId, question: q.text, ...(q.options?.length ? { options: q.options } : {}) }, needsYou: true })
    }
    this.raiseSeat(chat)
  }

  /** The inbox row that says how many updates wait for a terminal Lead tab. */
  private raiseSeat(chat: Chat) {
    const ws = this.d.store.workspace(chat.workspaceId)
    const project = ws && this.d.store.project(ws.projectId)
    const where = project ? ` · ${project.name}` : ''
    const lines = (this.seatQueue.get(chat.id) ?? []).flatMap((u) => u.update.rows.flatMap((r) => r.events.filter((e) => e.actionable).map((e) => `${r.name}: ${e.text}`)))
    const n = this.seatPending(chat.id)
    this.d.notify?.({ id: seatId(chat.id), title: `${chat.title} has ${n === 1 ? 'an update' : `${n} updates`} waiting`, sub: `Team update${where}`, heading: `Your team has news for ${chat.title}`, body: `${lines.join('\n')}\nIt reaches the terminal with your next message, or when the agent calls check_team.`.trim(), projectId: ws?.projectId, chatId: chat.id, needsYou: true })
  }

  /** The count of updates waiting for each terminal Lead tab that has any, as `seat.updates` last said (KERNEL-1029). */
  seatCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const [id, queue] of this.seatQueue) if (queue.length) counts[id] = queue.length
    return counts
  }

  /** How many updates wait for a terminal Lead tab. */
  seatPending(chatId: string): number { return this.seatQueue.get(chatId)?.length ?? 0 }

  /**
   * Returns the text of every update waiting for a terminal Lead tab, in order, and takes them off its queue, so nothing goes
   * twice (KERNEL-1000). Called by the tab's next prompt and by check_team. Undefined when none wait.
   */
  takeSeat(chatId: string): string | undefined {
    const queue = this.seatQueue.get(chatId)
    const chat = this.d.store.chat(chatId)
    if (!queue?.length) return undefined
    this.seatQueue.delete(chatId)
    this.save()
    if (chat) this.seatChanged(chat, 0)
    for (const u of queue) {
      const first = this.d.store.workspace(u.update.rows[0]?.workspaceId ?? '')
      if (!chat || !first) continue
      this.d.delivered?.(first.projectId, chat, u.update)
      this.d.opened?.(chat, u.told.flatMap((t) => { const ws = this.d.store.workspace(t.workspaceId); return ws ? [{ ws, name: t.name, events: t.events }] : [] }))
    }
    this.d.notify?.({ id: seatId(chatId), title: `${chat?.title ?? 'The tab'} has its updates`, sub: 'Team update', needsYou: false, resolved: 'The terminal has them.' })
    return queue.map((u) => u.text).join('\n\n')
  }

  /** The user answered a teammate's question in the inbox, so a Lead still waiting to hear it is told not to answer again. */
  seatAnswered(chatId: string, workspaceId: string, answer: string) {
    const queue = this.seatQueue.get(chatId)
    if (!queue) return
    for (const u of queue) if (u.asks.includes(workspaceId)) u.text += `\n\nThe user already answered this question in Kernel's inbox: "${capText(answer, ASK_MAX)}". Kernel sent the answer to the teammate, so don't answer it again.`
    this.save()
  }

  /**
   * A terminal tab's workspace was archived (KERNEL-1029). Restoring the workspace resumes the tab's session, so what waited
   * for it stays on its queue and reaches it then (`seatRestored`).
   */
  seatArchived(chatId: string) {
    if (!this.seatQueue.has(chatId)) return
    this.d.notify?.({ id: seatId(chatId), title: 'Terminal archived', sub: 'Team update', needsYou: false, resolved: 'The workspace was archived. The updates wait for it to be restored.' })
  }

  /** An archived workspace came back with the terminal tab `chat`: what waited for it is its again. */
  seatRestored(chat: Chat) {
    if (this.seatPending(chat.id)) this.raiseSeat(chat)
  }

  /**
   * A terminal tab is gone for good: closed, or its chat deleted (KERNEL-1029). What waited for it goes to the Lead chat that
   * `target` names for its work, as a Team update, or to another terminal Lead tab's queue. What no tab can take yet stays on
   * the dead tab's queue, and the next flush tries again.
   */
  rehomeSeat(chatId: string) {
    const queue = this.seatQueue.get(chatId)
    if (!queue?.length) return
    const dead = this.d.store.chat(chatId)
    const rest: SeatUpdate[] = []
    for (const u of queue) {
      const first = this.d.store.workspace(u.update.rows[0]?.workspaceId ?? '')
      if (!first) continue
      const to = this.d.target(first.projectId, chatId)
      if (!to || to.chat.id === chatId || to.chat.closed) { rest.push(u); continue }
      const text = `Kernel kept these updates from ${dead?.title ?? 'a terminal tab'}, a tab you closed.\n\n${u.text}`
      if (to.chat.kind === 'terminal') { this.keep(to.chat, { ...u, text }); continue }
      if (!this.d.post(to.chat.id, text, u.update)) { rest.push(u); continue }
      this.d.delivered?.(first.projectId, to.chat, u.update)
      this.d.opened?.(to.chat, u.told.flatMap((t) => { const ws = this.d.store.workspace(t.workspaceId); return ws ? [{ ws, name: t.name, events: t.events }] : [] }))
    }
    if (rest.length) this.seatQueue.set(chatId, rest)
    else this.seatQueue.delete(chatId)
    this.save()
    if (!rest.length) this.d.notify?.({ id: seatId(chatId), title: 'Terminal closed', sub: 'Team update', needsYou: false, resolved: 'The tab closed. Its updates went to the Lead.' })
  }

  /** Tries again for every queue whose tab is gone and found no taker. */
  private rehomeGone() {
    for (const id of [...this.seatQueue.keys()]) {
      const chat = this.d.store.chat(id)
      if (!chat || chat.closed) this.rehomeSeat(id)
    }
  }

  private seatChanged(chat: Chat | undefined, count = this.seatPending(chat?.id ?? ''), id = chat?.id) {
    this.save()
    if (id) bus.push({ type: 'seat.updates', chatId: id, count })
  }

  /** Draws the rows that cost no turn, and takes their events out of what waits, so each shows once (KERNEL-990). */
  private show(display: { update: TeamUpdate; events: TeamEvent[] }[], g: { chat: Chat; keys: string[] }, changed: { any: boolean }) {
    const gone = new Set(display.flatMap((d) => d.events.map((e) => e.n)))
    if (g.chat.kind !== 'terminal') for (const d of display) this.d.row?.(g.chat.id, d.update)
    for (const key of g.keys) {
      const p = this.pending.get(key)
      if (!p) continue
      p.events = p.events.filter((e) => !gone.has(e.n))
      changed.any = true
    }
  }

  flushAll() { for (const projectId of new Set([...this.pending.values()].map((p) => p.projectId))) this.flush(projectId) }

  /**
   * The text the Lead reads and the card's data, or nothing when no workspace has anything left to say. `wakes` is
   * whether any of it needs the Lead now.
   */
  private compose(projectId: string, sources: Source[]): { text: string; update: TeamUpdate; wakes: boolean; sent: Set<TeamEvent>; told: { ws: Workspace; name: string; events: TeamEvent[] }[]; display: { update: TeamUpdate; events: TeamEvent[] }[] } | undefined {
    const blocks: Block[] = []
    // Events the message carries, or that have nothing left to say. The rest wait for the next update (KERNEL-637).
    const sent = new Set<TeamEvent>()
    const display: { update: TeamUpdate; events: TeamEvent[] }[] = []
    for (const source of sources) {
      const byWs = new Map<string, TeamEvent[]>()
      for (const e of source.events) byWs.set(e.workspaceId, [...(byWs.get(e.workspaceId) ?? []), e])
      for (const [id, events] of byWs) {
        const ws = this.d.store.workspace(id)
        if (!ws || this.silent(ws)) { for (const e of events) sent.add(e); continue }
        // A verdict is current while the reviewed PR's head is the commit it reviewed, as of now, not as of the verdict.
        // A wait that broke and came back, as when its PR reopened, says nothing (KERNEL-259).
        // Blockers on the head after the last review round Kernel runs say so (KERNEL-552).
        const kept = foldLimits(collapse(events, ws)).filter((e) => e.kind !== 'wait.broken' || stillBroken(ws, e, (id) => this.d.store.workspace(id))).map((e) => {
          if (!e.review) return e
          const of = this.d.store.workspace(e.review.of)
          const current = e.review.sha ? !of?.prHead || of.prHead === e.review.sha : e.review.current
          const stuck = current && e.review.verdict === 'blockers' && e.review.lens && of ? this.d.reviewState?.(of)?.stillBlocked?.rounds : undefined
          return { ...e, review: { ...e.review, current, ...(stuck ? { stillBlocked: stuck } : {}) } }
        })
        if (!kept.length) { for (const e of events) sent.add(e); continue }
        const turn = kept.find((e) => e.kind === 'turn')
        const verdicts = kept.flatMap((e) => (e.kind === 'review' && e.review ? [e.review] : []))
        const name = this.d.agentName(projectId, ws.agentId) ?? ws.agentId
        const review = kept.some((e) => e.kind === 'pr.ready' || e.kind === 'pr.unblocked') ? this.d.reviewState?.(ws) : undefined
        const reviewer = this.d.reviewer?.(ws.projectId)
        const block: Block = {
          ws, name, raw: events, events: kept.filter((e) => e.kind !== 'shared'), shares: kept.filter((e) => e.kind === 'shared'), reply: verdicts.length ? summaries(verdicts) : turn?.reply, summary: verdicts.length > 0, status: reviewStatus(review), card: reviewCard(review), held: reviewHolds(review),
          latest: Math.max(...events.map((e) => e.n)), from: source.from, owner: source.owner, wake: new Set(), todo: []
        }
        if (source.owner) {
          // Work from a closed tab of this chat is this chat's own, so its last merge reads like any other.
          const decided = decide({ ws, name, events: block.events, fromChat: source.from?.tab ? undefined : source.from?.title }, {
            review, reviewer, autoReview: this.d.autoReview?.() ?? true, allMerged: () => this.allMerged(ws.projectId, source.owner!), workspace: (id) => this.d.store.workspace(id),
            stateOf: (id) => { const of = this.d.store.workspace(id); return of && this.d.reviewState?.(of) },
            refused: (id) => this.refused.get(id), toldLimit: this.toldLimit.has(ws.id),
            self: (id) => { const w = this.d.store.workspace(id); return !!w && this.isSelf(w) }
          })
          block.wake = decided.wake
          block.todo = decided.todo
        }
        // The chat's own PR keeps only the news that needs it: the rest is a row Kernel draws, never held to ride along (KERNEL-990).
        if (this.isSelf(ws)) {
          block.events = block.events.filter((e) => block.wake.has(e))
          block.shares = []
          block.reply = undefined
          if (!block.events.length) { for (const e of events) sent.add(e); continue }
        } else {
          // A review of the chat's own PR that approved its latest commit is a row with only the reviewer, not a Team update.
          const shown: TeamEvent[] = []
          const dropped = new Set<TeamEvent>()
          for (const e of block.events) {
            const of = e.kind === 'review' && e.review && !block.wake.has(e) ? this.d.store.workspace(e.review.of) : undefined
            if (!of || !this.isSelf(of) || e.review!.verdict !== 'approved' || !e.review!.current) continue
            if (of.prState === 'merged' || of.prState === 'closed' || of.status === 'archived') dropped.add(e)
            else shown.push(e)
          }
          if (shown.length) {
            const row = rowOf({ ...block, events: shown, shares: [], reply: summaries(shown.flatMap((e) => (e.review ? [e.review] : []))), summary: true, status: '', card: [], held: false, wake: new Set(), todo: [] })
            display.push({ update: { rows: [row] }, events: events.filter((x) => shown.some((e) => e.n === x.n)) })
          }
          if (shown.length || dropped.size) {
            block.events = block.events.filter((e) => !shown.includes(e) && !dropped.has(e))
            const gone = new Set([...shown, ...dropped].map((e) => e.n))
            for (const e of events) if (gone.has(e.n)) sent.add(e)
            if (!block.events.length && !block.shares.length) { for (const e of events) sent.add(e); continue }
          }
        }
        blocks.push(block)
      }
    }
    if (!blocks.length) return display.length ? { text: '', update: { rows: [] }, wakes: false, sent, told: [], display } : undefined
    // Blocks that need the Lead come first, then the newest of the rest.
    const rank = (b: Block) => (b.wake.size ? 1 : 0)
    const kept = [...blocks].sort((a, b) => rank(b) - rank(a) || b.latest - a.latest).slice(0, MAX_BLOCKS).sort((a, b) => a.latest - b.latest)
    const omitted = blocks.length - kept.length
    for (const b of kept) for (const e of b.raw) sent.add(e)
    const replies = kept.filter((b) => b.reply).length
    const max = Math.min(REPLY_MAX, Math.floor(REPLY_BUDGET / Math.max(1, replies)))
    const shown = kept.map((b) => ({ ...b, reply: b.reply ? capText(b.reply, max) : undefined }))

    // The target's own work first, then each closed tab's or closed chat's under its name. The card's rows follow the same order.
    const lines: string[] = [UPDATE_HEADER]
    const order: Block[] = []
    const fromKey = (f: From) => `${f.tab ? 'tab' : 'chat'}:${f.title}`
    for (const b of shown.filter((x) => !x.from)) { lines.push('', ...blockLines(b)); order.push(b) }
    for (const from of new Map(shown.flatMap((b) => (b.from ? [[fromKey(b.from), b.from] as const] : []))).values()) {
      lines.push('', `${fromLine(from)} This work is yours now.`)
      for (const b of shown.filter((x) => x.from && fromKey(x.from) === fromKey(from))) { lines.push('', ...blockLines(b)); order.push(b) }
    }
    if (omitted) lines.push('', `Updates on ${omitted} more ${omitted === 1 ? 'workspace' : 'workspaces'} didn't fit here. Kernel sends them in its next update.`)
    const todo = [...new Set(order.flatMap((b) => b.todo))]
    if (todo.length) lines.push('', 'To do:', ...todo.map((t) => `- ${t}`))

    const rows = order.map(rowOf)
    const allMerged = order.some((b) => b.events.some((e) => e.kind === 'pr.merged' && b.wake.has(e)))
    return { text: lines.join('\n'), update: { rows, ...(omitted ? { omitted } : {}), ...(allMerged ? { allMerged } : {}) }, wakes: order.some((b) => b.wake.size > 0), sent, told: order.map((b) => ({ ws: b.ws, name: b.name, events: b.events })), display }
  }

  /**
   * Every workspace handed off in the Lead chat of the tab `owner`, by any of its tabs, has merged (KERNEL-337). Left out: review workspaces, the Lead's own, work archived
   * without merging, and the reviewer's own workspaces that never opened a PR, which before the review link (KERNEL-130)
   * are reviews nothing marks as such.
   */
  private allMerged(projectId: string, owner: string): boolean {
    const reviewer = this.d.reviewer?.(projectId)?.id
    const tabs = new Set(this.d.store.threadTabs(owner).map((c) => c.id).concat(owner))
    const handed = this.d.store.workspaces(projectId).filter((w) => !!w.leadChatId && tabs.has(w.leadChatId) && !w.reviewOf && !this.d.isLead(w)
      && (w.status !== 'archived' || !!w.mergedAt) && !(w.agentId === reviewer && !w.prNumber))
    return handed.length > 0 && handed.every((w) => w.prState === 'merged' || !!w.mergedAt)
  }
}

/** The line over routed work, the same words the card draws (KERNEL-337). */
export const fromLine = (f: From) => (f.tab ? `From "${f.title}", a tab you closed.` : `From "${f.title}", a Lead chat that is now closed.`)

/**
 * What `decide` needs to know beyond the events: reviews of the PR, the team's reviewer (for usage data), whether Kernel
 * starts reviews of a PR that passed checks by itself (on when unset), whether this merge was the last, and the reviews of
 * another workspace's PR by its id, for a verdict about it (KERNEL-549), and why Kernel didn't merge a workspace's ready PR by
 * itself with auto-merge on (KERNEL-556). `toldLimit`: the Lead last heard this workspace's teammate was paused by a limit (KERNEL-777).
 * `self`: the workspace is the Build here chat's own, whose PR the chat fixes itself rather than through a teammate (KERNEL-778).
 */
export interface WakeContext { review?: ReviewState; reviewer?: AgentDef; autoReview?: boolean; allMerged: () => boolean; workspace?: (id: string) => Workspace | undefined; stateOf?: (id: string) => ReviewState | undefined; refused?: (id: string) => string | undefined; toldLimit?: boolean; self?: (id: string) => boolean }

/**
 * The To do line for a PR that passed checks and every review approved. The review's own line says the same, so it shows once.
 * A kind the review round skipped to save usage is the user's to know (KERNEL-552). The Lead gives the user a short merge summary
 * with it, and says why Kernel didn't merge it by itself when the user's auto-merge is on (`refused`, KERNEL-556).
 */
function readyToMerge(pr: string, kinds: ReviewKind[], skipped: ReviewKind[] = [], refused?: string, overruled: ReviewKind[] = []): string {
  const passed = kinds.length ? `${upper(pr)} passed checks, has no conflicts and ${reviewsOf(kinds)} approved it.` : `${upper(pr)} passed checks and has no conflicts.`
  const over = overruled.length ? ` The user overruled ${reviewsOf(overruled)}${overruled.length > 1 ? "'" : "'s"} blockers on its latest commit.` : ''
  const left = skipped.length ? ` Kernel skipped ${reviewsOf(skipped)} to save usage.` : ''
  const auto = refused ? ` Auto-merge is on, and Kernel didn't merge it. ${refused}` : ''
  const summary = ['what it changes', `which reviews ran${skipped.length ? ` and that ${reviewsOf(skipped)} didn't` : ''}`, ...(refused ? ["why Kernel didn't merge it"] : []), 'anything they should know']
  return `${passed}${over}${left}${auto} Tell the user it is ready to merge, with a short merge summary: ${summary.slice(0, -1).join(', ')}, and ${summary.at(-1)}.`
}

/** The To do line for a PR Kernel merged by itself (KERNEL-556). Its event's line says why. */
const autoMergedTodo = (pr: string, url: string | undefined) => `Tell the user Kernel merged ${pr} automatically and why, in a line or two${url ? `, with its link ${url}` : ''}.`

/**
 * The To do line for a PR still blocked after the review rounds `[review] rounds` allows (KERNEL-552). Kernel starts no more,
 * so the Lead brings what is open to the user instead of sending it back to the author. `pushed`: the author pushed since,
 * and Kernel didn't review the new commits. In the same words from every event that meets it, so it shows once.
 */
function stillBlockedTodo(pr: string, s: NonNullable<ReviewState['stillBlocked']>, author: string | undefined, pushed: boolean): string {
  const what = pushed ? `${upper(pr)} has new commits, but it was ${stillBlockedText(s.rounds).toLowerCase()}, so Kernel didn't review them.` : `${upper(pr)} is ${stillBlockedText(s.rounds).toLowerCase()}, so Kernel won't review it again by itself.`
  return `${what} ${author ? `Don't send it back to ${author}` : "Don't fix it again yet"}: tell the user what ${reviewsOf(s.kinds)} found that is still open, and ask with ask_user how they want to go on.`
}

/**
 * The To do line for blockers from one review round. With two kinds or more, they may pull opposite ways, and the user picks
 * rather than the author getting both (KERNEL-552). In the same words from each kind's verdict, so it shows once.
 */
function blockersTodo(kinds: ReviewKind[], author: string | undefined, at: string): string {
  const whose = `${reviewsOf(kinds)}${kinds.length > 1 ? "'" : "'s"}`
  // This chat's own PR in Build here (`author` unset): the chat fixes them itself, and Kernel reviews the new head (KERNEL-778).
  if (!author) {
    const fix = `Fix ${whose} blockers in this chat's worktree, then push. Kernel reviews the PR again once its checks pass.`
    return kinds.length < 2 ? fix : `${fix} If blockers from two reviews contradict each other, ask the user which to follow with ask_user first.`
  }
  if (kinds.length < 2) return `Send ${whose} blockers to ${author} with message_agent ${at}.`
  return `Send ${whose} blockers to ${author} in one message with message_agent ${at}. If blockers from two reviews contradict each other, don't pass both on: ask the user which to follow with ask_user first.`
}

/**
 * The To do line for a ready PR GitHub won't merge, in the same words from every event that meets it, so it shows once
 * (KERNEL-401). A branch behind its base is its agent's to update by merging `base` in: a PR's branch is pushed, and a rebase
 * would need a force push, which the team doesn't make (KERNEL-886).
 * A required review, or another rule, is the user's to know.
 */
export function blockedTodo(pr: string, name: string, at: string, blocked: PrBlocked, base: string, self = false): string {
  if (blocked === 'behind' && self) return `${selfUpdate(`Update ${pr}`, base)} GitHub won't merge it while its branch is behind.`
  if (blocked === 'behind') return `Ask ${name} to update ${pr}: fetch, merge ${base} into the branch, re-run the tests and push as usual, with message_agent ${at}. GitHub won't merge it while its branch is behind.`
  if (blocked === 'review') return `${upper(pr)} can't merge until someone approves it on GitHub. Tell the user.`
  return `GitHub's branch rules block ${pr}. Tell the user.`
}

/** How the Build here chat brings its own PR up to date with `base` (KERNEL-778), by a merge since the PR's branch is pushed (KERNEL-886). */
const selfUpdate = (what: string, base: string) => `${what} in this chat's worktree: fetch, merge ${base} into the branch, re-run the tests and push as usual.`

/**
 * What a review workspace's verdicts said, as the reply its update quotes. With more than one kind of review, each summary
 * says whose it is (KERNEL-549).
 */
function summaries(verdicts: NonNullable<TeamEvent['review']>[]): string {
  // The reply to the Lead's own message follows the summary it sent (feat-review-messages-reach-named).
  const one = (v: NonNullable<TeamEvent['review']>) => (v.reply ? `${v.summary}\n\nReply to your message: ${v.reply}` : v.summary)
  if (verdicts.length === 1) return one(verdicts[0])
  return verdicts.map((v) => `${kindsText([v.lens ?? 'code'])} review: ${one(v)}`).join('\n\n')
}

/** The To do line for a PR whose review was of another commit. The PR's own line says the same, so it shows once. */
const anotherReview = (pr: string, name: string, at: string) => `${upper(pr)} needs another review: the last one was of a different commit. Ask ${name} to review it again with message_agent (workspace ${at}).`

/** One workspace's row on the Team update card. */
function rowOf(b: Block): TeamUpdateRow {
  const prNumber = b.ws.prNumber ?? b.events.find((e) => e.pr)?.pr
  return {
    workspaceId: b.ws.id, agentId: b.ws.agentId, name: b.name, task: b.ws.title ?? b.ws.name,
    ...(prNumber ? { prNumber } : {}),
    // A ready PR's review follows as a grey segment of its own, so only "Ready to merge" is green (KERNEL-411). A review
    // that holds it back makes the PR's own event grey too (KERNEL-635).
    events: b.events.flatMap((e) => [
      { kind: e.kind, text: cardText(e, b.held), actionable: b.wake.has(e), ...(b.held && (e.kind === 'pr.ready' || e.kind === 'pr.unblocked') ? { held: true } : {}) },
      ...(e.kind === 'pr.ready' || e.kind === 'pr.unblocked' ? b.card.map((text) => ({ kind: 'pr.review' as const, text, actionable: false })) : []),
      // Why auto-merge allowed it, grey after "Merged automatically" (KERNEL-556).
      ...(e.auto ? [{ kind: 'pr.review' as const, text: e.auto.card, actionable: false }] : []),
      ...(e.review?.stillBlocked ? [{ kind: 'pr.review' as const, text: stillBlockedText(e.review.stillBlocked), actionable: false }] : [])
    ]),
    ...(b.reply ? { reply: b.reply } : {}),
    ...(b.from ? { fromChat: b.from.title, ...(b.from.tab ? { fromTab: true } : {}) } : {}),
    ...(b.shares.length ? { shared: b.shares.flatMap((e) => (e.shared ? [{ sharedId: e.shared.sharedId, version: e.shared.version, title: e.shared.title, kind: e.shared.kind }] : [])) } : {})
  }
}

/**
 * Which of one workspace's events need the Lead, and what to do about each (KERNEL-121). Called only for work a Lead chat
 * handed off. A turn the user started in the teammate's own chat, and an error in one, are between them and never wake it.
 * `fromChat` is the closed Lead chat the work came from, for the merge line.
 */
export function decide(b: { ws: Workspace; name: string; events: TeamEvent[]; fromChat?: string }, c: WakeContext): { wake: Set<TeamEvent>; todo: string[] } {
  const { ws, name } = b
  const out = { wake: new Set<TeamEvent>(), todo: [] as string[] }
  const at = `(workspace ${ws.id})`
  // This chat's own PR in Build here: the chat fixes it in its own worktree, with nobody to message (KERNEL-778).
  const self = !!c.self?.(ws.id)
  // An archived workspace takes no more messages, and archiving it was the user's call, so only news that asks nothing
  // of it still wakes the Lead: the last merge of a plan, and a review's verdict, which is about other work.
  const archived = ws.status === 'archived'
  for (const e of b.events) {
    const pr = e.pr ? `PR #${e.pr}` : 'the PR'
    const wake = (todo: string, evenArchived = false) => { if (archived && !evenArchived) return; out.wake.add(e); out.todo.push(todo) }
    switch (e.kind) {
      case 'error': if (e.by !== 'user') wake(`${name} stopped with an error. Ask ${name} what happened with message_agent ${at}, or tell the user.`); break
      case 'crash': if (!e.resumed) wake(`${name}'s session ended. Tell the user they can restart it from the workspace.`); break
      case 'setup.failed': if (!e.told) wake(e.started ? `Setup failed in ${name}'s workspace. ${name} already started and keeps working without it. Tell the user it can be fixed and run again there.` : `Setup failed in ${name}'s workspace. Tell the user to fix it and click Run again there.`); break
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
        // Kernel runs a kind's review again by itself once the fix passes checks (KERNEL-549), so the Lead only passes the
        // blockers on. A review without a kind, which the Lead started, is still the Lead's to ask again, unless the user
        // archived its workspace, which can't review again.
        const state = c.stateOf?.(r.of)
        const ofAt = `(workspace ${r.of})`
        // A review of this chat's own PR in Build here: its blockers are the chat's to fix (KERNEL-778).
        const ofSelf = !!c.self?.(r.of)
        // The user overruled this kind's blockers on the head since, so nobody fixes them, and the PR reads as the rest of its
        // reviews have it (KERNEL-732).
        const overruled = r.verdict === 'blockers' && !!r.lens && r.current && !!state?.overruled?.includes(r.lens)
        if (r.verdict === 'blockers' && !overruled && r.lens && r.current && state) {
          // A kind's blockers on the head wait for the rest of its review round, so the author gets them all at once and the
          // Lead reads them side by side. After the last round Kernel runs, they go to the user instead (KERNEL-552). A kind
          // that waits for usage, maybe for hours, holds nothing back: the line names it instead (KERNEL-633).
          if (reviewRuns(state)) break
          const ofPr = of?.prNumber ?? r.ofPr
          const held = state.held?.length ? ` ${heldText(state.held)}, and ${state.held.length === 1 ? 'its findings come' : 'their findings come'} in a later update.` : ''
          if (state.stillBlocked) { wake(stillBlockedTodo(ofPr ? `PR #${ofPr}` : 'the PR', state.stillBlocked, ofSelf ? undefined : r.ofName, false) + held, true); break }
          wake(blockersTodo(state.blocking.length ? state.blocking : [r.lens], ofSelf ? undefined : r.ofName, ofAt) + held, true)
          break
        }
        if (r.verdict === 'blockers' && !overruled) {
          if (r.lens) { wake(blockersTodo([r.lens], ofSelf ? undefined : r.ofName, ofAt), true); break }
          if (ofSelf) { wake(`Fix ${name}'s blockers in this chat's worktree, then push.${archived ? '' : ` Then ask ${name} to review again with message_agent (workspace ${ws.id}).`}`, true); break }
          wake(`Send ${name}'s blockers to ${r.ofName} with message_agent ${ofAt}.${archived ? '' : ` When ${r.ofName} is done, ask ${name} to review again with message_agent (workspace ${ws.id}).`}`, true)
          break
        }
        // An approval of a commit the PR no longer has, or doesn't have yet, says nothing about what would merge. Kernel asks
        // for another once the PR passes checks again; a review from before review kinds is the Lead's to ask for.
        if (!r.current && of?.prNumber) { if (!r.lens || c.autoReview === false) wake(anotherReview(`PR #${of.prNumber}`, name, ws.id)); break }
        // Another review of the PR is still running or found blockers. Its own news says what's next.
        if (r.lens && (state?.inProgress || state?.blockers)) break
        // An approval of this chat's own PR is a row, not a turn. Only a block GitHub puts on it is the user's to act on (KERNEL-990).
        if (ofSelf) { if (of?.prState === 'ready' && of.prNumber && of.prBlocked) wake(blockedTodo(`PR #${of.prNumber}`, r.ofName, ofAt, of.prBlocked, of.baseRef, true), true); break }
        const kinds = state?.approved.length ? state.approved : overruled ? [] : [r.lens ?? 'code']
        // A PR GitHub still blocks is its author's to update, or the user's to know (KERNEL-401).
        if (of?.prState === 'ready' && of.prNumber) { wake(of.prBlocked ? blockedTodo(`PR #${of.prNumber}`, r.ofName, ofAt, of.prBlocked, of.baseRef, ofSelf) : readyToMerge(`PR #${of.prNumber}`, kinds, state?.skipped, c.refused?.(of.id), state?.overruled), true); break }
        // Overruled blockers on a PR that isn't ready yet: its own news says when it is.
        if (overruled) break
        const approver = r.lens ? reviewsText(kinds) : name
        if (!of?.prNumber) { wake(`${approver} approved ${r.ofName}'s work. Ask ${r.ofName} to open a pull request with message_agent (workspace ${r.of}).`, true); break }
        wake(`${approver} approved PR #${of.prNumber}. Its checks haven't passed yet; tell the user it is ready to merge once they do.`, true)
        break
      }
      case 'pr.cifail': wake(self ? `Fix the failed checks on ${pr} in this chat's worktree, then push.` : `Tell ${name} about the failed checks on ${pr} with message_agent ${at}.`); break
      case 'pr.changes': wake(self ? `Make the changes requested on ${pr} in this chat's worktree, then push.` : `Tell ${name} about the changes requested on ${pr} with message_agent ${at}.`); break
      case 'pr.conflict': wake(self ? selfUpdate(`Resolve the conflicts on ${pr}`, ws.baseRef) : `Ask ${name} to resolve the conflicts on ${pr} with message_agent ${at}.`); break
      case 'pr.closed': if (ws.prState === 'closed') wake(`${upper(pr)} was closed without merging. Ask the user whether ${self ? 'the work' : `${name}'s work`} is still wanted.`); break
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
      // The wait stays until a turn ends with the merge in the branch, and only a new message to the teammate gets it there (KERNEL-691).
      case 'wait.rebase_missing':
        wake(`Ask ${name} with message_agent ${at} to fetch, ${e.wait?.pushed ? `merge ${e.wait.onto ?? 'the base'} into the branch` : `rebase onto ${e.wait?.onto ?? 'the base'}`} and re-run the tests. Kernel ends the wait when a turn ends with the branch containing it.`)
        break
      // Kernel already sent the brief or the rebase or merge message, so the Lead has nothing to do.
      case 'wait.released': break
      // A limit wakes the Lead only when nothing carries the teammate on before the reset. A carry-on, or a limit and its carry-on
      // in one update, wakes it only to correct a pause it heard about (KERNEL-777).
      case 'limit':
        if (e.limit?.carried !== undefined) { if (c.toldLimit) wake(liftedTodo(name, e.limit.carried || undefined)); break }
        if (e.by !== 'user' && !e.limit?.switching) wake(pausedTodo(name, e.limit))
        break
      case 'limit.lifted': if (c.toldLimit) wake(liftedTodo(name, e.limit?.account)); break
      case 'question':
        wake(`Answer ${name}'s question with message_agent ${at}: from the approved plan if it covers it, otherwise ask the user with ask_user first. ${name} waits until you do.`)
        break
      // Only the user can approve new work, so the Lead proposes it as it would its own hand-off (KERNEL-747).
      case 'handoff.proposed':
        wake(`${name} proposes handing "${e.proposal?.task ?? 'a task'}" to ${e.proposal?.agent ?? 'another teammate'}. Propose it to the user and ask for a go-ahead. Call create_workspace for it only on a go-ahead that approves it.`)
        break
      case 'pr.merged':
        // Kernel merged it by itself, so the user hears it from the Lead, even once the work is archived (KERNEL-556).
        // The chat's own merge is a row, and Kernel cuts its next branch from the base (KERNEL-778, KERNEL-990).
        if (self) break
        if (e.auto) wake(autoMergedTodo(pr, ws.prUrl), true)
        if (c.allMerged()) wake(b.fromChat ? `Every task handed off in the closed Lead chat "${b.fromChat}" has merged. Tell the user in one line.` : ALL_MERGED, true)
        break
      case 'pr.blocked': if (e.blocked) wake(blockedTodo(pr, name, at, e.blocked, ws.baseRef, self)); break
      // Kernel's own update waits for checks and says nothing to do. Its stop is the user's to know (KERNEL-835).
      case 'pr.updated':
        if (e.updated?.capped && ws.prState !== 'merged' && ws.prState !== 'closed') wake(`Tell the user ${e.updated.base} keeps moving past ${pr}, so Kernel stopped bringing it up to date after ${e.updated.capped} tries and won't merge it by itself. They can update and merge it by hand.`)
        break
      case 'pr.unblocked': {
        if (self) break
        const review = c.review
        // A review still to come, or one that holds the PR back, says what's next itself (KERNEL-635).
        if (reviewHolds(review) || review?.inProgress) break
        if (allApproved(review)) { wake(readyToMerge(pr, review?.approved ?? [], review?.skipped, c.refused?.(ws.id), review?.overruled)); break }
        if (review?.open || review?.stale) break
        wake(`GitHub no longer blocks ${pr}, so it is ready to merge. Tell the user.`)
        break
      }
      case 'pr.ready': {
        const review = c.review
        const blocked = ws.prBlocked && blockedTodo(pr, name, at, ws.prBlocked, ws.baseRef, self)
        // Blockers come with the review's own update, and a review that runs will say what it found. Kernel starts the reviews
        // itself (KERNEL-549), so a PR that just passed checks reads as in progress while they start.
        if (review?.blockers || review?.inProgress) break
        // Kernel ran the last review round it runs and blockers were left, so it didn't review the new commits (KERNEL-552).
        if (review?.stillBlocked) { wake(stillBlockedTodo(pr, review.stillBlocked, self ? undefined : name, true)); break }
        // This chat's own PR that passed checks is a row. A block GitHub puts on it, or a review that can't start, is the user's (KERNEL-990).
        if (self) { if (blocked) { if (!b.events.some((x) => x.kind === 'pr.blocked')) wake(blocked) } else if (review?.open?.failed) wake(`${upper(pr)} needs a review, and setup failed in its review workspace. Tell the user to fix it and click Run again there (workspace ${review.open.workspaceId}).`); break }
        // A branch behind its base is updated first: the update makes a new head, which any review would have to see again (KERNEL-401).
        if (ws.prBlocked === 'behind' && blocked) { wake(blocked); break }
        if (allApproved(review)) { wake(blocked || readyToMerge(pr, review?.approved ?? [], review?.skipped, c.refused?.(ws.id), review?.overruled)); break }
        if (review?.open?.failed) { wake(`${upper(pr)} needs a review, and setup failed in its review workspace. Tell the user to fix it and click Run again there (workspace ${review.open.workspaceId}).`); break }
        // No review looked at this PR: auto review is off (KERNEL-115), or none of the project's reviews covers what it changes.
        if (!review?.open && !review?.stale) {
          bus.track({ name: 'pr.ready_unreviewed', hasReviewer: !!c.reviewer })
          wake(blocked || (c.autoReview === false ? `${upper(pr)} passed checks and has no conflicts. Tell the user it is ready to merge.` : `${upper(pr)} passed checks and has no conflicts. No review runs on it, so tell the user it is ready for them to review and merge.`))
          break
        }
        // A review that stopped without a verdict on the latest commit, which Kernel didn't start again.
        if (review?.open) { wake(review.stale || review.waiting.length ? anotherReview(pr, review.open.name, review.open.workspaceId) : `${upper(pr)} needs a review. Ask ${review.open.name} to review it with message_agent (workspace ${review.open.workspaceId}).`); break }
        // A review of an earlier commit with no review workspace left to look again: a merge that needs an approval waits (KERNEL-115).
        wake(blocked || `${upper(pr)} passed checks and has no conflicts, but its last review was of an earlier commit and its review workspace is closed. Tell the user the review is out of date.`)
        break
      }
      case 'turn':
        // A turn whose PR is being created or checked, or that a newer PR event follows, has that event to speak for it.
        // An unblock that rides along says nothing for the turn, so it doesn't count (KERNEL-401).
        if (e.by === 'user' || SETTLING.includes(ws.prState) || b.events.some((x) => x.n > e.n && ((x.kind.startsWith('pr.') && x.kind !== 'pr.unblocked' && x.kind !== 'pr.updated') || x.kind === 'review'))) break
        // The turn ended by waiting for another PR, or by asking the Lead. That line already wakes the Lead, once (KERNEL-262, KERNEL-747).
        if (b.events.some((x) => (x.kind === 'wait.started' && !x.wait?.told) || x.kind === 'question')) break
        wake(`Read ${name}'s reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`)
        break
      default: break
    }
    // The Lead asked this reviewer something, so it hears the answer, even when the verdict alone would wait, as a code
    // approval while another kind still blocks (feat-review-messages-reach-named).
    if (e.kind === 'review' && e.review?.asked && !out.wake.has(e)) wake(askedTodo(name, e.review, c.stateOf?.(e.review.of)), true)
  }
  return out
}

/** The To do line for a verdict from a turn the Lead started: read the reply, and what still holds the PR back. */
function askedTodo(name: string, r: NonNullable<TeamEvent['review']>, state?: ReviewState): string {
  const pr = r.ofPr ? `PR #${r.ofPr}` : `${r.ofName}'s work`
  const by = r.lens ? `${name}, in ${reviewsText([r.lens]).replace(/^The/, 'the')},` : name
  const what = r.verdict === 'approved' ? 'approved' : 'found blockers in'
  const blocking = state?.blocking.filter((k) => k !== r.lens || r.verdict === 'blockers') ?? []
  const running = state?.reviewing.filter((k) => k !== r.lens) ?? []
  const still = [
    ...(blocking.length ? [`${upper(pr)} is still blocked by ${reviewsText(blocking).replace(/^The/, 'the')}.`] : []),
    ...(running.length ? [`${reviewsText(running)} ${running.length === 1 ? 'is' : 'are'} still running.`] : [])
  ]
  return `${by} answered your message and ${what} ${pr}. Tell the user what it replied.${still.length ? ` ${still.join(' ')}` : ''}`
}

/** A wait.broken event whose PR still can't merge, and that the workspace still waits for. Unknown targets count as broken. */
function stillBroken(ws: Workspace, e: TeamEvent, workspace?: (id: string) => Workspace | undefined): boolean {
  const target = e.wait?.target
  if (!target || !ws.waitsFor?.on.includes(target)) return false
  return !workspace || isBroken(workspace(target))
}

/** The To do line once the last task a chat handed off has merged. */
const ALL_MERGED = 'Every task you handed off in this chat has merged. Tell the user in one line.'

/**
 * One workspace's block in the Lead's text: who and what, each event, each file shared, then the reply quoted. A reply says
 * the turn ended.
 */
function blockLines(b: Block): string[] {
  const lines = [`${b.name} (${b.ws.agentId}) · ${b.ws.title ?? b.ws.name} · workspace ${b.ws.id}`]
  for (const e of b.events) if (!(e.kind === 'turn' && b.reply && !b.summary)) lines.push(`- ${sentence(e, b.name, b.status)}`)
  for (const e of b.shares) lines.push(`- ${sentence(e, b.name)}`)
  if (b.reply) {
    lines.push(`- ${b.name}'s ${b.summary ? 'summary' : 'last reply'}:`)
    for (const l of b.reply.split('\n')) lines.push(l.trim() ? `  > ${l}` : '  >')
  }
  return lines
}
