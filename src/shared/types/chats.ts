import type { PermissionMode, ReviewKind, RunMode } from './settings'
import type { TrackerKind } from './trackers'
import type { ChangedFile, LeadMode } from './workspaces'

/** The agent CLI a chat runs on: Claude Code through the Agent SDK, or Codex through `codex app-server` (KERNEL-406). */
export type Provider = 'claude' | 'codex'

export const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' }
]

/** Claude's models. A Codex model id is whatever its `model/list` returns, so it is a plain string (`ProviderModel`). */
export type ModelId = 'claude-fable-5-1' | 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5' | 'claude-haiku-4-5-20251001'
  | 'claude-fable-5' | 'claude-opus-5' | 'claude-opus-4-8' | 'claude-opus-4-7' | 'claude-opus-4-6' | 'claude-opus-4-5'
  | 'claude-sonnet-5' | 'claude-sonnet-4-6' | 'claude-sonnet-4-5'
/** Claude offers the first four (EFFORTS). Codex models list their own, which can go up to `max` and `ultra` (KERNEL-406). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/**
 * `window` is the model's context window in tokens, and `inputPrice` the API's price in US dollars per million input tokens,
 * which a move onto an API key account is priced at (KERNEL-842). A `legacy` model is an older one Claude Code still runs.
 * The current ones come first, so an alias (`opus`) and the ^⌘1 to 4 keys pick the newest of a family.
 */
export const MODELS: { id: ModelId; label: string; window: number; inputPrice: number; legacy?: true }[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', window: 1_000_000, inputPrice: 10 },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', window: 1_000_000, inputPrice: 4 },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', window: 1_000_000, inputPrice: 2 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', window: 1_000_000, inputPrice: 0.1 },
  { id: 'claude-fable-5', label: 'Fable 5', window: 1_000_000, inputPrice: 10, legacy: true },
  { id: 'claude-opus-5', label: 'Opus 5', window: 1_000_000, inputPrice: 5, legacy: true },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', window: 1_000_000, inputPrice: 5, legacy: true },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', window: 1_000_000, inputPrice: 5, legacy: true },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', window: 1_000_000, inputPrice: 5, legacy: true },
  { id: 'claude-opus-4-5', label: 'Opus 4.5', window: 200_000, inputPrice: 5, legacy: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', window: 1_000_000, inputPrice: 2, legacy: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', window: 1_000_000, inputPrice: 3, legacy: true },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', window: 200_000, inputPrice: 3, legacy: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', window: 200_000, inputPrice: 1, legacy: true }
]

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' }
]

/** Every effort's label, Codex's own levels included. */
export const EFFORT_LABELS: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }

/** A model a provider offers, with the efforts it takes. Claude's come from MODELS, Codex's from `model/list` (KERNEL-406). */
export interface ProviderModel {
  provider: Provider
  id: string
  label: string
  efforts: Effort[]
  defaultEffort: Effort
  /** The provider's own default, which a role starts on. */
  isDefault?: boolean
  /** An older model the provider still runs, which a picker can group under Legacy models. */
  legacy?: boolean
  description?: string
}

export interface Chat {
  id: string
  workspaceId: string
  title: string
  /** A terminal chat runs Claude Code's own TUI in a pty (KERNEL-12, D-001). */
  kind: 'chat' | 'terminal'
  /** Claude Code session id, or the Codex thread id, used to resume. */
  sessionId?: string
  /** Which CLI runs the chat. Absent reads as `claude`, which every chat before KERNEL-406 ran on. A chat keeps it for life. */
  provider?: Provider
  /** A Claude `ModelId`, or a Codex model id from `model/list`. */
  model: string
  effort: Effort
  plan: boolean
  /** The chat's own permission mode, picked in the composer. Unset follows the project's, then the app's. Plan mode stays `plan` (KERNEL-432). */
  mode?: PermissionMode
  /** Set on a fork: the chat and the transcript item it was forked after. */
  forkOf?: { chatId: string; itemId: string }
  /** Context window use, 0 to 100 (WorkspaceContext.png). */
  context?: number
  /** Claude Code's /context numbers behind `context`: tokens used, the window size and its rows, without deferred tools. */
  contextUsage?: { used: number; max: number; rows: { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }[] }
  /** Closed tabs keep their transcript but leave the tab strip. */
  closed?: boolean
  /** A big terminal's preset and the command it types into the login shell, null for a plain shell. Older terminal chats have none and run `claude` (KERNEL-248). */
  terminal?: { preset: string; command: string | null }
  /** Kernel picks this chat's name and may change it. `turns` is the finished-turn count it last named it at. A name the user types clears it (KERNEL-202). */
  autoTitle?: { turns: number }
  /** The Lead chat this tab belongs to. Set on every Lead tab, absent elsewhere (KERNEL-337). */
  threadId?: string
  /** When a turn last ended in this chat since the user saw it. Unset is read, as is every chat from before (KERNEL-507). */
  unreadAt?: number
  /** Claude's guess at the user's next message, sent after a turn. The next turn to start clears it. Codex chats never get one (KERNEL-530). */
  suggestion?: string
  /**
   * The review this chat runs in a review workspace Kernel started (KERNEL-549), fixed when the review starts. `agent` is the
   * project agent whose prompt it runs, absent when Kernel's own prompt for `kind` does. `optional`: the kind wasn't required
   * for the PR, so its approval doesn't count toward a merge. A review chat from before has none and reads as the code review.
   */
  lens?: { kind: ReviewKind; agent?: string; optional?: true }
  /**
   * The account the chat's last turn started on, by account id, `cli` for the CLI's own login. Unset until its first turn. A
   * turn that starts on another account adds a note that says so (KERNEL-568).
   */
  ranOn?: string
  /** What the chat's last finished turn read and cached, for moving it between accounts (KERNEL-842). Unset until one ends. */
  lastTurn?: LastTurn
  /** What the user picked for this chat when a switch would move it to another account, kept until a later step acts on it (KERNEL-842). */
  moveChoice?: { choice: MoveChoice; at: number }
  createdAt: number
}

/** Token counts of one model call or one turn: input that wasn't cached, input read from the cache, and input written to it. */
export interface TokenCounts { input: number; cacheRead: number; cacheWrite: number }

/**
 * A chat's last finished turn (KERNEL-842). `account` is the one it ran on (`cli` for the CLI's own login) and `email` that
 * login's email as Kernel knew it then, so a login changed in a terminal reads as another account. `context` is the chat's
 * size in tokens as the turn ended. `input`, `cacheRead` and `cacheWrite` are the turn's: Claude's result usage, Codex's last
 * model call. `first` is the turn's first model call, which says whether the turn found the chat in the cache.
 * `estimated`: a chat from before KERNEL-842 has no turn on record, so `context` is guessed from its transcript and the
 * counts are 0.
 */
export interface LastTurn extends TokenCounts {
  at: number
  account: string
  email?: string
  model: string
  context: number
  first?: TokenCounts
  estimated?: true
}

/**
 * Why a chat's next turn would read its whole history again (KERNEL-842): it moves to another `account` (or the same id signed
 * in to another email), to another `model`, or it has been `idle` past the provider's cache lifetime.
 */
export type ColdReason = 'account' | 'model' | 'idle'

/** What the user picks for a long chat a switch would move (KERNEL-842): summarize it first, continue it as it is, or keep it on its account. */
export type MoveChoice = 'summarize' | 'continue' | 'keep'

/**
 * What the chat's next turn does to its cache, for the notice above the composer (KERNEL-841). `move`: the turn runs on another
 * account (`to`, `from` is where it last ran) or another model (`model` is its label), so it re-reads about `tokens` tokens.
 * `idle`: only the cache lifetime ran out, so the hint has no buttons. `price` is in US dollars, only for a Claude API key
 * target. `keep`: the account it last ran on can still run the chat, so Keep is offered. Absent when the chat is under
 * Settings, Account "Long chat", has no turn on record, or the user already chose.
 */
export interface MoveNotice {
  kind: 'move' | 'idle'
  reason: ColdReason
  from: string
  to: string
  model?: string
  tokens: number
  estimated?: true
  price?: number
  keep: boolean
}

/**
 * One long chat a switch to `to` would move off `from`, the account its provider runs on now (KERNEL-842). `tokens` is its
 * size, `estimated` when Kernel guessed it from the transcript. `running`: a turn is running now, which finishes where it
 * started. `coldReason` is why the move reads the whole chat again, none when the target shares its cache. `fits` says it
 * fits the target model's window. `price` is in US dollars, only for a Claude API key target: what reading it once costs.
 */
export interface MovePreviewChat {
  chatId: string
  title: string
  workspaceId: string
  workspace: string
  provider: Provider
  from: string
  to: string
  tokens: number
  estimated?: true
  running: boolean
  coldReason?: ColdReason
  fits: boolean
  price?: number
}

/** What a switch to `to` would move: the provider's chats on `from` at or above `accounts.longChatTokens`, largest first (KERNEL-842). */
export interface MovePreview { provider: Provider; from: string; to: string; chats: MovePreviewChat[] }

/**
 * A chat with the Lead, which holds one or more of its tabs (KERNEL-337). Called a thread in code so it doesn't clash with
 * `Chat`, which is one tab. The title follows the first tab's auto name until the user renames it (`renamed`). `closedAt` is
 * set when its last open tab closes.
 */
export interface Thread {
  id: string
  projectId: string
  title: string
  createdAt: number
  closedAt?: number
  renamed?: boolean
  /** When the user last sent a message in any tab of the chat. The sidebar lists chats by it, newest first, else by `createdAt` (KERNEL-498). */
  lastSentAt?: number
}

/**
 * What archiving a Lead chat would stop, one row per workspace, the chat's own last (KERNEL-405). A row with none of the
 * four loses nothing. `pr` is the number of an open PR Kernel stops checking. `unknown` means Kernel couldn't read its git state.
 */
export interface ChatArchivePreview {
  threadId: string
  title: string
  workspaces: { id: string; name: string; own: boolean; running: boolean; pr?: number; dirty: number; unpushed: number; unknown?: boolean }[]
}

/** Words in a note that open a workspace: "PR #164 by Noor" in "Waiting for PR #164 by Noor to merge." */
export interface NoteRef { text: string; workspaceId: string }

/** One rendered row in a chat transcript. Mirrors the kinds drawn on the canvas. */
export type ChatItem =
  /**
   * `from` marks a message the user didn't type: Kernel's own, or the Lead's in a teammate's chat. `update` is the Team update card (KERNEL-111).
   * `approvalId` is the plan approval a Kernel message answers, so the chat can show the user's answer instead of Kernel's text.
   * With `approvalId` and no `from`, the row is the user's answer to that plan, question or agent card (KERNEL-836), id
   * `answer-<approvalId>`, right after the card: drawn as the user's bubble and never sent to the agent (`approvalAnswer.ts`).
   * `checkpointId` is on the chat's first message only: the start checkpoint, taken before it went out (KERNEL-764).
   */
  | { kind: 'user'; id: string; ts: number; parts: ChatPart[]; from?: MessageFrom; update?: TeamUpdate; approvalId?: string; checkpointId?: string }
  | { kind: 'text'; id: string; ts: number; text: string }
  | { kind: 'thinking'; id: string; ts: number; text: string }
  /** `input` is the tool's input as the SDK sent it, long strings clipped. `outputCut` says `output` was cut short. */
  | { kind: 'tool'; id: string; ts: number; toolUseId: string; name: string; label: string; detail: string; status: 'running' | 'done' | 'failed'; output?: string; outputCut?: boolean; input?: Record<string, unknown>; durationMs?: number }
  /**
   * End of a turn. `files` is the "Changed" chip row under the reply. `checkpointId` is the checkpoint taken as the turn ended,
   * set on every turn that wrote a result, with or without files (KERNEL-764). Both arrive a moment after the row, in a `chat.item` push.
   */
  | { kind: 'result'; id: string; ts: number; durationMs: number; ok: boolean; error?: string; files?: ChangedFile[]; checkpointId?: string }
  /**
   * `pr` is the PR state a note about a PR is for, so the row can draw that state's icon (KERNEL-313). Older notes and other notes have none.
   * `refs` are spans of `text`, in the order they appear, that open another workspace, such as the PRs a held brief waits for.
   */
  | { kind: 'note'; id: string; ts: number; text: string; link?: { label: string; href: string }; pr?: 'merged' | 'closed' | 'cifail'; refs?: NoteRef[] }
  | { kind: 'interrupted'; id: string; ts: number }
  /** Where an approval card sits in the transcript. The card itself reads the Approval, so the Inbox and the transcript stay in sync (D-007). */
  | { kind: 'approval'; id: string; ts: number; approvalId: string }
  /** A file the agent shared with share_file. The card reads the SharedFile, so a later version shows on it (KERNEL-302). */
  | { kind: 'shared'; id: string; ts: number; sharedId: string; version: number }
  /** The chat with Kernel switched to `mode` from the next turn, drawn as a divider with `leadModeSwitched`'s text (KERNEL-770). */
  | { kind: 'leadMode'; id: string; ts: number; mode: LeadMode }
  /**
   * Kernel, in Build here, says the work is too big for one PR and suggests Hand off with suggest_hand_off (KERNEL-770). Drawn
   * under its reply as a "Switch to Hand off" button that calls `lead.setMode`, while the chat is still in Build here. `why` is Kernel's reason.
   */
  | { kind: 'modeSuggestion'; id: string; ts: number; mode: LeadMode; why: string }

/** What a shared file is, from its extension and first bytes (KERNEL-302). */
export type SharedKind = 'html' | 'image' | 'pdf' | 'markdown'

/**
 * One version of a shared file. `file` is the copy's name in `<dataDir>/shared/<id>/v<n>/`. `chatId` is the chat that shared
 * it, `thumb` says a thumbnail was captured, and `outside` counts the HTML's references to other files or the network.
 */
export interface SharedVersion { n: number; at: number; file: string; mime: string; bytes: number; sha256: string; chatId?: string; note?: string; thumb?: boolean; width?: number; height?: number; outside?: number }

/** A file an agent shared, one per workspace and source path, with every version Kernel kept (KERNEL-302). `source` is relative to the workspace. */
export interface SharedFile { id: string; projectId: string; workspaceId: string; agentId: string; source: string; title: string; kind: SharedKind; versions: SharedVersion[]; createdAt: number; updatedAt: number }

// comments on shared files (KERNEL-310)
/**
 * Where a comment is pinned. HTML: `x`, `y` in the view's CSS pixels, the window it was seen in and the element under the
 * point. Image: `x`, `y` in the image's natural pixels, with `viewport.width` its natural width. Markdown: the block. PDFs
 * take no comments.
 */
export interface SharedAnchor {
  x: number
  y: number
  viewport?: { width: number; height: number; scrollY: number }
  /** `selector` is the element's id when unique, else a `tag:nth-of-type` chain. `rect` is in the view's CSS pixels. */
  element?: { selector: string; tag: string; text?: string; rect: { x: number; y: number; width: number; height: number } }
  block?: { index: number; text: string }
}

/** A comment on one version of a shared file. `chatId` is the chat it went to, `itemId` its message there, empty when the message was queued. */
export interface SharedComment { id: string; sharedId: string; version: number; at: number; note: string; anchor: SharedAnchor; chatId: string; itemId: string }

/**
 * Composer parts. Pasted long text becomes a file part carrying its text; images carry a data URL. An image's `path` is
 * where Kernel saved it in the workspace for the agent to Read, relative to the workspace folder (KERNEL-545).
 */
export type ChatPart =
  | { type: 'text'; text: string }
  /** `dir` marks a folder from the @ menu: `path` ends in `/` and the agent gets the path, not the files in it. */
  | { type: 'file'; name: string; path?: string; lines?: number; text?: string; dir?: boolean }
  | { type: 'image'; name: string; dataUrl?: string; width?: number; height?: number; path?: string }
  | { type: 'skill'; name: string }
  /** + > Link issue. `name` is the key, "KERNEL-83" or "#41". */
  | { type: 'issue'; name: string; title: string; url?: string; source: TrackerKind }
  /** + > Link workspaces: another workspace the agent can read and diff. */
  | { type: 'workspace'; name: string; workspaceId: string; branch: string; path: string; prNumber?: number; prUrl?: string }
  /** + > Link pull request: a PR the agent can read (KERNEL-776). `name` is "#41", so chips read it like an issue's key. */
  | { type: 'pr'; name: string; number: number; title: string; url?: string }
  /** @agent in a Lead chat's composer: the user addresses the message to that teammate, and the Lead acts for them (KERNEL-745). */
  | { type: 'agent'; name: string; agentId: string }

/** A message typed while the agent is busy (WorkspaceQueued.png). */
export interface QueuedMessage {
  id: string
  chatId: string
  parts: ChatPart[]
  ts: number
  /** Carried to the chat item, so a held brief stays the Lead's and a resent update stays Kernel's. */
  from?: MessageFrom
  update?: TeamUpdate
  /** Carried to the chat item: the plan approval a Kernel message answers. */
  approvalId?: string
}

/**
 * What a chat's queue waits for: the running turn, the workspace's setup, a PR to merge before the brief goes out (KERNEL-259),
 * a paused project, every project held (`offline` covers a lost connection and a sign-out alike), the agent limit in Settings,
 * Models, or a usage window close to its limit while Settings, Account pauses new work there (`limit`, KERNEL-220),
 * or a long chat that waits to move to another account (`move`, KERNEL-841).
 * Computed, never saved (KERNEL-271, KERNEL-361).
 */
export type QueueReason = 'running' | 'setup' | 'merge' | 'paused' | 'offline' | 'capacity' | 'limit' | 'move'

/** Where a chat's permission mode was picked: in the chat's composer, for its project, or in Settings, Permissions. */
export type ModeScope = 'chat' | 'project' | 'app'

/**
 * Why a chat runs in another mode than the one picked (KERNEL-572). When more than one applies, the first that moved it counts.
 * - `plan`: the chat is planning
 * - `agentFile`: the agent file's `permissionMode` is stricter
 * - `noAuto`: Auto isn't available for the chat's provider or model, or Kernel hasn't read yet whether it is
 * - `noBypass`: Claude Code's settings turn Bypass permissions off, or Kernel hasn't read them yet
 * - `worktreesOnly`: Only in worktrees is on and the chat works on the current branch
 * - `turnRunning`: Bypass permissions starts once the running turn and its background tasks end. Until then the chat runs in
 *   the mode it was in
 */
export type ModeReason = 'plan' | 'agentFile' | 'noAuto' | 'noBypass' | 'worktreesOnly' | 'turnRunning'

/**
 * The permission mode a chat runs in, as main works it out, so the composer doesn't work it out again (KERNEL-572). `picked`
 * is the chat's own mode, else its project's, else Settings, Permissions', and `pickedIn` says which. `why` is set exactly when
 * `mode` isn't `picked`. Right for a chat with no process too. Computed, never saved.
 */
export interface ChatRunMode {
  mode: RunMode
  picked: PermissionMode
  pickedIn: ModeScope
  why?: ModeReason
}

/** Who sent a message the user didn't type: Kernel itself, or the Lead handing work to a teammate. */
export type MessageFrom = 'kernel' | 'lead'

/** What happened in a teammate's workspace, as Kernel reports it to the Lead (KERNEL-111). */
export type TeamEventKind =
  | 'turn' | 'error' | 'crash' | 'setup.failed' | 'setup.passed'
  | 'pr.opened' | 'pr.ready' | 'pr.cifail' | 'pr.changes' | 'pr.conflict' | 'pr.merged' | 'pr.closed'
  // A ready PR GitHub starts or stops blocking: a required review, a branch behind its base, other rules (KERNEL-401).
  | 'pr.blocked' | 'pr.unblocked'
  // Kernel brought a PR it was about to merge up to date with its base, or stopped doing so after too many tries (KERNEL-835).
  | 'pr.updated'
  // Where a ready PR's review stands, a grey segment of its own after Ready to merge (KERNEL-411).
  | 'pr.review'
  | 'review'
  | 'wait.started' | 'wait.released' | 'wait.broken'
  // A turn Kernel started to rebase onto a merge ended without the merge in the branch (KERNEL-691).
  | 'wait.rebase_missing'
  | 'shared'
  // A teammate asked the Lead with ask_lead, or proposed handing part of its work to another agent with propose_handoff (KERNEL-747).
  | 'question' | 'handoff.proposed'
  // A usage limit cut a teammate's turn off, and Kernel carried it on after, on another account or at the reset (KERNEL-777).
  | 'limit' | 'limit.lifted'

/**
 * One event in a Team update row. `text` is the card's wording ("Opened PR #108"); `actionable` means it needs the Lead.
 * `held`: a review holds the ready PR back, so the event reads grey instead of green (KERNEL-635).
 */
export interface TeamUpdateEvent {
  kind: TeamEventKind
  text: string
  actionable: boolean
  held?: boolean
}

/**
 * One teammate workspace in a Team update. `fromChat` is the closed Lead chat the work came from, when it isn't this chat's.
 * With `fromTab` it is a closed tab of this chat instead, and `fromChat` is that tab's title (KERNEL-337).
 */
export interface TeamUpdateRow {
  workspaceId: string
  agentId: string
  name: string
  task: string
  prNumber?: number
  events: TeamUpdateEvent[]
  /** The teammate's last reply, or a reviewer's summary, as the Lead got it. */
  reply?: string
  fromChat?: string
  fromTab?: boolean
  /** Files the teammate shared since the last update, newest version of each. The card draws them, not `events` (KERNEL-302). */
  shared?: { sharedId: string; version: number; title: string; kind: SharedKind }[]
}

/** Kernel's update to a Lead chat. The card draws this; the Lead reads the item's text. `omitted` counts workspaces left out. */
export interface TeamUpdate {
  rows: TeamUpdateRow[]
  omitted?: number
  /** Every task this chat handed off has merged. */
  allMerged?: boolean
}

/**
 * Something a Lead chat owes until the Lead acts on it (KERNEL-749): a teammate's question, a review's blockers not passed on
 * yet, a hand-off a teammate proposed, or a teammate the user addressed with @. Kernel opens one from the real event and
 * closes it when the Lead messages that workspace, creates its workspace or asks the user about it, or when the user dismisses it.
 */
export type OpenItemKind = 'question' | 'blockers' | 'handoff.proposed' | 'mention'

export interface OpenItem {
  id: string
  kind: OpenItemKind
  projectId: string
  /** The Lead chat it belongs to, and the tab it opened in. */
  threadId: string
  chatId: string
  /** The teammate workspace it is about: the one that asked or proposed, or the work the review blocked. A mention has none. */
  workspaceId?: string
  /** That teammate, or the one the user addressed, by id and name. */
  agentId: string
  name: string
  /** A question's text, or the task a proposed hand-off names. */
  text?: string
  /** The teammate a hand-off was proposed for. */
  proposed?: { agentId: string; name: string }
  /** How many blockers the review found. */
  blockers?: number
  /** Kernel has listed it in a reminder at Stop. A reminder goes again only once a new item opens. */
  reminded?: true
  createdAt: number
}

/**
 * A reviewer's verdict from submit_review. `sha` is the review worktree's HEAD; a verdict for an older commit is stale. A review
 * workspace keeps one verdict per kind of review (KERNEL-549).
 */
export interface ReviewVerdict {
  /** The review workspace that sent it, and its agent. */
  workspaceId: string
  agentId: string
  verdict: 'approved' | 'blockers'
  summary: string
  blockers?: { text: string; file?: string; line?: number }[]
  sha?: string
  /** The PR it was about. A verdict for another number no longer counts. */
  prNumber?: number
  /** The kind of review it is (KERNEL-549). A verdict from before has none and counts as the code review's. */
  lens?: ReviewKind
  /** Its kind wasn't required for the PR: its approval doesn't count toward a merge, and its blockers still hold one. */
  optional?: true
  /**
   * The commit the reviewer approved, when Kernel carried the approval to a later head whose new commits touched none of the
   * kind's paths (KERNEL-552). `sha` is then that later head.
   */
  keptFrom?: string
  /**
   * A blocking verdict that came in while the PR's checks were still running. When the same commit passes checks, Kernel asks
   * its kind to review again, once (feat-review-messages-reach-named). Verdicts saved before have none and aren't asked.
   */
  checksRunning?: true
  /** Kernel already asked this kind to review the commit again once its checks finished, so it never asks a second time. */
  checksRetried?: true
  ts: number
}

/** A skill the composer's / menu offers (WorkspaceSlash.png, Settings > Skills). */
export interface Skill {
  name: string
  description: string
  source: 'user' | 'project' | 'plugin'
  enabled: boolean
}

/** One of Claude Code's own slash commands (/clear, /compact, /context), offered in the composer's / menu next to the skills. */
export interface BuiltinCommand {
  name: string
  description: string
  /** Claude Code's hint for the arguments: `[name]` is optional, `<model>` is required. Empty when it takes none. */
  argumentHint: string
  /** Other names that run it, such as /cost for /usage. */
  aliases?: string[]
}

/**
 * An MCP server a project's agents can reach (Settings > Skills and MCP). `enabled` is the project's switch. Since KERNEL-464:
 * - `source`: where the server is defined. `local` is the user's entry for this repo in `~/.claude.json`, which Claude Code
 *   reads over `project` (`.mcp.json`) and `user`. `claudeai`, `plugin` and `managed` are only known from a status report.
 * - `provider`: unset for Claude Code's servers. `codex` for the `[mcp_servers]` in Codex's `config.toml`.
 * - `status`: what the provider last said, unset until a probe or a session has. `error` is why it failed, when it said.
 */
export interface McpServer {
  name: string
  enabled: boolean
  source: 'user' | 'project' | 'local' | 'claudeai' | 'plugin' | 'managed'
  provider?: Provider
  status?: McpStatus
  error?: string
}

/** An MCP server's connection as Claude Code's `mcpServerStatus()` reports it. Codex's startup states map onto it (KERNEL-464). */
export type McpStatus = 'connected' | 'pending' | 'failed' | 'needs-auth' | 'disabled'
