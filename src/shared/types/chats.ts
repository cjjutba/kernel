import type { ChangedFile } from './workspaces'

export type ModelId = 'claude-fable-5-1' | 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-4-5-20251001'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

export const MODELS: { id: ModelId; label: string }[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
]

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' }
]

export interface Chat {
  id: string
  workspaceId: string
  title: string
  /** A terminal chat runs Claude Code's own TUI in a pty (KERNEL-12, D-001). */
  kind: 'chat' | 'terminal'
  /** Claude Code session id, used to resume. */
  sessionId?: string
  model: ModelId
  effort: Effort
  plan: boolean
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
  createdAt: number
}

/**
 * A chat with the Lead, which holds one or more of its tabs (KERNEL-337). Called a thread in code so it doesn't clash with
 * `Chat`, which is one tab. The title follows the first tab's auto name until the user renames it (`renamed`). `closedAt` is
 * set when its last open tab closes.
 */
export interface Thread {
  id: string
  roomId: string
  title: string
  createdAt: number
  closedAt?: number
  renamed?: boolean
}

/** Words in a note that open a workspace: "PR #164 by Noor" in "Waiting for PR #164 by Noor to merge." */
export interface NoteRef { text: string; workspaceId: string }

/** One rendered row in a chat transcript. Mirrors the kinds drawn on the canvas. */
export type ChatItem =
  /** `from` marks a message the user didn't type: Kernel's own, or the Lead's in a teammate's chat. `update` is the Team update card (KERNEL-111). */
  | { kind: 'user'; id: string; ts: number; parts: ChatPart[]; from?: MessageFrom; update?: TeamUpdate }
  | { kind: 'text'; id: string; ts: number; text: string }
  | { kind: 'thinking'; id: string; ts: number; text: string }
  /** `input` is the tool's input as the SDK sent it, long strings clipped. `outputCut` says `output` was cut short. */
  | { kind: 'tool'; id: string; ts: number; toolUseId: string; name: string; label: string; detail: string; status: 'running' | 'done' | 'failed'; output?: string; outputCut?: boolean; input?: Record<string, unknown>; durationMs?: number }
  /** End of a turn. `files` is the "Changed" chip row under the reply. */
  | { kind: 'result'; id: string; ts: number; durationMs: number; ok: boolean; error?: string; files?: ChangedFile[] }
  /**
   * `pr` is the PR state a note about a PR is for, so the row can draw that state's icon (KERNEL-313). Older notes and other notes have none.
   * `refs` are spans of `text`, in the order they appear, that open another workspace, such as the PRs a held brief waits for.
   */
  | { kind: 'note'; id: string; ts: number; text: string; link?: { label: string; href: string }; pr?: 'merged' | 'closed' | 'cifail'; refs?: NoteRef[] }
  | { kind: 'interrupted'; id: string; ts: number }
  /** Where an approval card sits in the transcript. The card itself reads the Approval, so the Inbox and floor stay in sync (D-007). */
  | { kind: 'approval'; id: string; ts: number; approvalId: string }
  /** A file the agent shared with share_file. The card reads the SharedFile, so a later version shows on it (KERNEL-302). */
  | { kind: 'shared'; id: string; ts: number; sharedId: string; version: number }

/** What a shared file is, from its extension and first bytes (KERNEL-302). */
export type SharedKind = 'html' | 'image' | 'pdf' | 'markdown'

/**
 * One version of a shared file. `file` is the copy's name in `<dataDir>/shared/<id>/v<n>/`. `chatId` is the chat that shared
 * it, `thumb` says a thumbnail was captured, and `outside` counts the HTML's references to other files or the network.
 */
export interface SharedVersion { n: number; at: number; file: string; mime: string; bytes: number; sha256: string; chatId?: string; note?: string; thumb?: boolean; width?: number; height?: number; outside?: number }

/** A file an agent shared, one per workspace and source path, with every version Kernel kept (KERNEL-302). `source` is relative to the workspace. */
export interface SharedFile { id: string; roomId: string; workspaceId: string; agentId: string; source: string; title: string; kind: SharedKind; versions: SharedVersion[]; createdAt: number; updatedAt: number }

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

/** Composer parts. Pasted long text becomes a file part carrying its text; images carry a data URL. */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'file'; name: string; path?: string; lines?: number; text?: string }
  | { type: 'image'; name: string; dataUrl?: string; width?: number; height?: number }
  | { type: 'skill'; name: string }
  /** + > Link issue. `name` is the key, "KERNEL-83" or "#41". */
  | { type: 'issue'; name: string; title: string; url?: string; source: 'linear' | 'github' }
  /** + > Link workspaces: another workspace the agent can read and diff. */
  | { type: 'workspace'; name: string; workspaceId: string; branch: string; path: string; prNumber?: number; prUrl?: string }

/** A message typed while the agent is busy (WorkspaceQueued.png). */
export interface QueuedMessage {
  id: string
  chatId: string
  parts: ChatPart[]
  ts: number
  /** Carried to the chat item, so a held brief stays the Lead's and a resent update stays Kernel's. */
  from?: MessageFrom
  update?: TeamUpdate
}

/**
 * What a chat's queue waits for: the running turn, the workspace's setup, a PR to merge before the brief goes out (KERNEL-259),
 * a paused room, every room held (`offline` covers a lost connection and a sign-out alike), or the agent limit in Settings,
 * Models. Computed, never saved (KERNEL-271, KERNEL-361).
 */
export type QueueReason = 'running' | 'setup' | 'merge' | 'paused' | 'offline' | 'capacity'

/** Who sent a message the user didn't type: Kernel itself, or the Lead handing work to a teammate. */
export type MessageFrom = 'kernel' | 'lead'

/** What happened in a teammate's workspace, as Kernel reports it to the Lead (KERNEL-111). */
export type TeamEventKind =
  | 'turn' | 'error' | 'crash' | 'setup.failed' | 'setup.passed'
  | 'pr.opened' | 'pr.ready' | 'pr.cifail' | 'pr.changes' | 'pr.conflict' | 'pr.merged' | 'pr.closed'
  | 'review'
  | 'wait.started' | 'wait.released' | 'wait.broken'
  | 'shared'

/** One event in a Team update row. `text` is the card's wording ("Opened PR #108"); `actionable` means it needs the Lead. */
export interface TeamUpdateEvent {
  kind: TeamEventKind
  text: string
  actionable: boolean
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

/** A reviewer's verdict from submit_review. `sha` is the review worktree's HEAD; a verdict for an older commit is stale. */
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

export interface McpServer {
  name: string
  enabled: boolean
  source: 'user' | 'project'
}
