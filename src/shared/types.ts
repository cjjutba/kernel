// Domain types shared by the main process, preload and renderer.
// Every domain object drawn on the canvas has a type here (KERNEL-8). Add fields in a small separate
// commit at the top of a lane's PR rather than reshaping what is already here.

// ---------- agents

export type AgentStatus = 'working' | 'planning' | 'walking' | 'needs' | 'idle' | 'blocked' | 'offline' | 'paused'

/** How a person is drawn on the floor (Main.dc.html roster). Kernel picks one when the file has none. */
export interface AgentLook {
  shirt: string
  skin: string
  hair: string
}

export interface AgentDef {
  /** File stem in .claude/agents, also the Claude Code subagent name. */
  id: string
  /** Display name, for example "Kai". */
  name: string
  /** Short role, for example "Frontend". */
  role: string
  description: string
  model?: string
  /** Default effort for this agent's chats. Falls back to Settings > Models. */
  effort?: Effort
  tools?: string[]
  skills?: string[]
  /** True for the agent that plans and hands out work. */
  lead: boolean
  /** Body of the markdown file, used as appended system prompt. */
  prompt: string
  file: string
  look?: AgentLook
  /** When the file first appeared in the room. Drives "Joined today" and the new hire moment. */
  joinedAt?: number
  /** Retired agents live in .claude/retired-agents (D-003) and stay listable so they can come back. */
  retired?: boolean
}

/** The editable part of an agent file: AgentProfile and the New agent review step. */
export interface AgentEdit {
  name?: string
  role?: string
  description?: string
  model?: string
  effort?: Effort
  tools?: string[]
  skills?: string[]
  prompt?: string
}

/** New agent flow: Describe produces a draft file, Review edits it, Create saves it (NewAgent*.png). */
export interface AgentDraft {
  id: string
  name: string
  description: string
  model: string
  tools: string[]
  /** The whole file as it will be written, frontmatter included. */
  text: string
  file: string
}

/** Team templates offered on an empty floor (FloorEmpty.png). */
export type TeamTemplate = { kind: 'starter' } | { kind: 'pair' } | { kind: 'copy'; fromRoomId: string }

// ---------- rooms

export type RoomKind = 'repo' | 'folder' | 'scratch'

export interface Room {
  id: string
  name: string
  /** One line under the name on Rooms and Home, for example "Invoicing SaaS · MVP Sprint". */
  desc?: string
  kind?: RoomKind
  /** Absolute path of the main checkout. */
  path: string
  /** owner/repo when the folder has a GitHub remote. */
  repo?: string
  defaultBranch: string
  paused: boolean
  /** Who paused it. A limit pause lifts itself when the limit resets (FloorLimit.png). */
  pausedBy?: 'you' | 'limit'
  /** Agent ids in desk order. Agents past the last desk sit in the overflow strip (FloorFull.png). */
  desks?: string[]
  /** Hidden from the sidebar, still listed on Rooms. */
  hidden?: boolean
  /** Archived from Settings > Room. Agents stop, workspaces archive, the room moves to Rooms > Archived. */
  archived?: boolean
  /** Bash rules the user chose "Always allow in this room" for. An exact command, or `prefix:*`. They beat Always ask. */
  allow?: string[]
  /**
   * The room's picture: the GitHub owner's avatar or a picked PNG or JPEG, saved as `file` in the data folder's room-icons.
   * No icon means the letter. The image itself comes from `rooms.icon`, so room pushes stay small (KERNEL-241).
   */
  icon?: { kind: 'github' | 'image'; file: string; at: number }
  createdAt: number
}

/** New room modal (NewRoom.png). */
export interface NewRoomRequest {
  source: RoomKind
  name: string
  desc?: string
  /** owner/repo for a repo, an absolute path for a folder, a template repo for scratch. */
  from: string
  baseBranch?: string
  /** Starter agent ids to seat. The Lead is always included. */
  team: string[]
  /** Brief the Lead as soon as setup finishes. */
  autostart: boolean
  /** Repo and scratch rooms: the folder to create the checkout in. Defaults to ~/Projects/<name>. */
  cloneTo?: string
  /** Folder rooms: the folder is not a git repository, so run `git init` and make a first commit. */
  initGit?: boolean
}

/** Values New room opens with. Fixtures use it to show the filled form. */
export interface NewRoomPrefill {
  source: RoomKind
  name: string
  desc?: string
  /** owner/repo, a folder path or a template repo, by `source`. */
  from: string
  baseBranch?: string
}

/** Values New agent opens with. Fixtures use it to show the filled form, the drafted file and the joined step. */
export interface NewAgentPrefill {
  name?: string
  description?: string
  /** An alias: sonnet, opus or haiku. */
  model?: string
  /** The drafted file. Shown by the review and joined steps. */
  draft?: AgentDraft
}

/** One line of the room setup progress (RoomSetup.png). */
export interface RoomSetupStep {
  id: 'clone' | 'worktrees' | 'install' | 'copy' | 'hooks' | 'agents'
  title: string
  detail: string
  state: 'wait' | 'run' | 'ok' | 'fail'
  /** Duration or "running". */
  meta?: string
  error?: string
}

/** A repo on the user's GitHub account (ConnectRepo.png). */
export interface RepoSummary {
  fullName: string
  name: string
  private: boolean
  updatedAt: number
}

/** A local folder that could become a room (OpenFolder.png). */
export interface FolderInfo {
  path: string
  git: boolean
  branch?: string
  /** Uncommitted changes in the checkout. */
  dirty?: number
}

/** Two agents editing the same file in different worktrees (FloorOverlap.png). */
export interface Overlap {
  id: string
  roomId: string
  path: string
  parties: { agentId: string; workspaceId: string; lines: string }[]
  ts: number
  resolved?: boolean
}

// ---------- workspaces

export type WorkspaceMode = 'worktree' | 'current'
export type WorkspaceStatus = 'setup' | 'ready' | 'failed' | 'archived'
/**
 * The PR header state. `creating`, `resolving` and `merging` are Kernel's own while the agent or gh works;
 * the rest come from `gh pr view` (github.ts prStateOf).
 */
export type PrState =
  | 'none' | 'creating' | 'draft' | 'open' | 'checks' | 'cifail' | 'changes' | 'conflict' | 'resolving'
  | 'ready' | 'merging' | 'merged' | 'closed'

/** Where a workspace started from (NewWorkspaceFrom.png). */
export type WorkspaceSource =
  | { kind: 'pr'; number: number; title: string }
  | { kind: 'branch'; branch: string }
  | { kind: 'issue'; id: string; title: string; url?: string }

export interface DiffStat {
  files: number
  added: number
  removed: number
}

export interface Workspace {
  id: string
  roomId: string
  name: string
  /** The task title it was created from. */
  title?: string
  branch: string
  baseRef: string
  path: string
  mode: WorkspaceMode
  agentId: string
  port: number
  status: WorkspaceStatus
  /** For current-branch workspaces: the commit that captures pre-existing changes. */
  baselineRef?: string
  source?: WorkspaceSource
  /** Board task this workspace builds, for example "T-14". */
  taskId?: string
  /** The Lead chat that handed this workspace off. Kernel's teammate updates about it go there (D-101). */
  leadChatId?: string
  /** On a review workspace: the workspace whose work it reviews. */
  reviewOf?: string
  /** Reviewers' verdicts on this workspace's PR, one per review workspace. */
  reviews?: ReviewVerdict[]
  /** The PR's head commit as GitHub last reported it. */
  prHead?: string
  prNumber?: number
  prUrl?: string
  prTitle?: string
  prState: PrState
  /** Totals for the sidebar and Home (+412 -38). Refreshed after each turn. */
  stat?: DiffStat
  createdAt: number
  mergedAt?: number
  archivedAt?: number
}

/** Git facts the archive and discard confirmations show (ConfirmArchive.png, ConfirmDiscard.png). */
export interface WorkspaceGitStatus {
  branch: string
  /** Commits not on the remote yet. */
  ahead: number
  behind: number
  /** Uncommitted changes. */
  dirty: DiffStat
}

export interface ChangedFile {
  path: string
  status: 'A' | 'M' | 'D' | 'R' | '?'
  added: number
  removed: number
}

/** One row of the All files tree (Workspace.png, right panel). */
export interface FileEntry {
  path: string
  dir: boolean
  /** Change status when the file differs from the base. */
  status?: ChangedFile['status']
}

/**
 * One hunk of a file that has both the user's earlier edits and the agent's (WorkspaceHunks.png).
 * `mine` hunks predate the workspace (the current-branch baseline) and stay uncommitted unless picked.
 */
export interface Hunk {
  id: string
  path: string
  lines: string
  added: number
  removed: number
  owner: 'agent' | 'mine'
  patch: string
}

/** A snapshot of the worktree after an agent turn (WorkspaceCheckpoints.png). */
export interface Checkpoint {
  id: string
  workspaceId: string
  chatId: string
  ts: number
  /** First line of the turn, for example "Added the empty and error states". */
  title: string
  stat: DiffStat
  /** Git ref holding the snapshot. */
  ref: string
  /** The checkpoint the worktree is at now: the newest one, or the one last reverted to. */
  current: boolean
  /** Taken before the first turn, so reverting to it undoes all of the agent's work ("start of chat"). */
  start?: boolean
}

export type ScriptKind = 'setup' | 'run' | 'archive'

export interface ScriptLine {
  kind: ScriptKind
  line: string
  stream: 'stdout' | 'stderr'
}

// ---------- chats

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
  /** Kernel picks this chat's name and may change it. `turns` is the finished-turn count it last named it at. A name the user types clears it (KERNEL-202). */
  autoTitle?: { turns: number }
  createdAt: number
}

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
  | { kind: 'note'; id: string; ts: number; text: string; link?: { label: string; href: string } }
  | { kind: 'interrupted'; id: string; ts: number }
  /** Where an approval card sits in the transcript. The card itself reads the Approval, so the Inbox and floor stay in sync (D-007). */
  | { kind: 'approval'; id: string; ts: number; approvalId: string }

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

/** Who sent a message the user didn't type: Kernel itself, or the Lead handing work to a teammate. */
export type MessageFrom = 'kernel' | 'lead'

/** What happened in a teammate's workspace, as Kernel reports it to the Lead (KERNEL-111). */
export type TeamEventKind =
  | 'turn' | 'error' | 'crash' | 'setup.failed' | 'setup.passed'
  | 'pr.opened' | 'pr.ready' | 'pr.cifail' | 'pr.changes' | 'pr.conflict' | 'pr.merged' | 'pr.closed'
  | 'review'

/** One event in a Team update row. `text` is the card's wording ("Opened PR #108"); `actionable` means it needs the Lead. */
export interface TeamUpdateEvent {
  kind: TeamEventKind
  text: string
  actionable: boolean
}

/** One teammate workspace in a Team update. `fromChat` is the closed Lead chat the work came from, when it isn't this chat's. */
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

// ---------- approvals

export type ApprovalKind = 'tool' | 'plan' | 'question' | 'agent'

/** One line of a plan card. `taskId` and `agentId` are set when the Lead plans a hand-off. */
export interface PlanStep {
  title: string
  taskId?: string
  agentId?: string
  /** The workspace the Lead created for this step, set once the plan is approved and handed off. */
  workspaceId?: string
}

export interface Approval {
  id: string
  kind: ApprovalKind
  source: 'sdk' | 'hook'
  roomId?: string
  workspaceId?: string
  chatId?: string
  agentId?: string
  toolName?: string
  input?: unknown
  title: string
  detail?: string
  options?: string[]
  /** Plan approvals. */
  steps?: PlanStep[]
  /** Plan-mode plans: the copy Kernel keeps, relative to the workspace folder, for example `.kernel/plans/export-invoices.md`. */
  planFile?: string
  /** Agent approvals: the file the Lead wants to write (WorkspaceHire.png). */
  agentFile?: { path: string; text: string }
  status: 'pending' | 'allowed' | 'denied' | 'answered' | 'expired'
  answer?: string
  createdAt: number
}

export type Decision =
  | { behavior: 'allow'; always?: boolean }
  /** `images` go with a plan's change request: main saves each one in the workspace and names its path in `message` (D-134). */
  | { behavior: 'deny'; message?: string; images?: { name: string; dataUrl: string }[] }
  | { behavior: 'answer'; text: string }

// ---------- board

/** Columns on the board. Spec, Plan and Review are gates that wait on the user (Board.png). */
export type TaskColumn = 'spec' | 'plan' | 'build' | 'qa' | 'review' | 'done'
export type TaskState = 'working' | 'needs' | 'blocked' | 'idle' | 'done'

export interface TaskStep {
  text: string
  state: 'done' | 'doing' | 'next'
}

export interface Task {
  /** Short id the Lead assigns, for example "T-14" or "T-15b". */
  id: string
  roomId: string
  title: string
  column: TaskColumn
  state: TaskState
  agentId?: string
  workspaceId?: string
  /** The parent of a split task, "T-15" for "T-15a". */
  parentId?: string
  /** Board header grouping, for example "Invoices v1". */
  milestone?: string
  spec?: string
  steps: TaskStep[]
  /** The plan approval that created it. */
  approvalId?: string
  /** The id a session outside Kernel gave it, from the TaskCreated and TaskCompleted hooks. */
  externalId?: string
  createdAt: number
  updatedAt: number
  /** When it reached Done. */
  completedAt?: number
}

// ---------- activity and notifications

/** A line in the room logs and the source of every floor animation. */
export interface ActivityEvent {
  id: string
  ts: number
  roomId?: string
  workspaceId?: string
  agentId?: string
  sessionId?: string
  taskId?: string
  /** Who did it. Agent unless set. */
  actor?: 'you' | 'agent' | 'kernel'
  kind:
    | 'session.start' | 'session.end' | 'prompt' | 'tool.start' | 'tool.end' | 'tool.failed'
    | 'turn.done' | 'approval.requested' | 'approval.decided' | 'task.created' | 'task.assigned' | 'task.completed'
    | 'workspace.created' | 'workspace.archived' | 'workspace.restored' | 'pr.changed' | 'agent.status' | 'agent.say'
    | 'agent.joined' | 'agent.talk' | 'agent.retired' | 'room.paused' | 'room.resumed' | 'brief' | 'overlap' | 'checkpoint.reverted'
    | 'limit' | 'note'
  text: string
  object?: string
  /** A quoted brief or message under the line (FloorSent.png). */
  quote?: string
  /** Shows the object as something that needs the user. */
  warn?: boolean
  /** `agent.talk` carries `from` and `to` (agent ids) and `workspaceId`; `overlap` carries `overlapId` and `workspaceIds`. */
  data?: Record<string, unknown>
}

/** Inbox rows that are not approvals: merge ready, a failed check, a finished workspace, a standup, system news (Inbox.png). */
export type NotificationKind = 'approval' | 'merge' | 'blocked' | 'check' | 'finished' | 'idle' | 'standup' | 'system' | 'overlap'

export interface Notification {
  id: string
  kind: NotificationKind
  roomId?: string
  workspaceId?: string
  agentId?: string
  taskId?: string
  approvalId?: string
  title: string
  /** The line under the title, for example "Merge · Client A". */
  sub: string
  /** The heading on the detail pane. */
  heading?: string
  body?: string
  /** True while the user still has to act on it. */
  needsYou: boolean
  read: boolean
  /** What the detail pane says after the user acted. */
  resolved?: string
  createdAt: number
}

// ---------- pull requests

export interface PrCheck {
  name: string
  state: 'queued' | 'running' | 'pass' | 'fail' | 'skipped'
  /** Duration or a word like "ready" (Vercel preview). */
  meta?: string
  url?: string
}

export interface ReviewComment {
  id: string
  author: string
  path?: string
  line?: number
  body: string
  resolved: boolean
}

/** Everything the PR header and the Checks panel show (WorkspaceCIFailed.png, WorkspaceChangesRequested.png). */
export interface PrInfo {
  workspaceId: string
  number: number
  url: string
  title: string
  state: PrState
  baseRef: string
  checks: PrCheck[]
  comments: ReviewComment[]
  /** Files with conflicts against the base. */
  conflicts: string[]
  reviewDecision?: 'approved' | 'changes' | 'pending'
  /** The head commit (headRefOid). */
  head?: string
}

/** A PR the new workspace modal can start from. */
export interface PrSummary {
  number: number
  title: string
  branch: string
  /** GitHub login of the PR author, so the From popover can search by author. */
  author?: string
}

/** An issue the new workspace modal can start from (Linear, or a board task). */
export interface IssueSummary {
  id: string
  title: string
  url?: string
  source?: 'linear' | 'github'
}

// ---------- Linear (KERNEL-159)

/** Linear's workflow state types. Open issues are the first four. `duplicate` is an issue marked as a duplicate of another. */
export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate'

export interface LinearIssue {
  /** The identifier, "KERNEL-83". */
  id: string
  uuid: string
  title: string
  url: string
  /** Linear's suggested git branch name. */
  branchName: string
  state: { id: string; name: string; type: LinearStateType; position: number }
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number
  /** `me` is true when the issue is assigned to the token's user. */
  assignee?: { name: string; me: boolean }
  labels: string[]
  team: { id: string; key: string; name: string }
  project?: { id: string; name: string }
  cycle?: { id: string; number: number; name?: string }
  updatedAt: string
}

export interface LinearComment {
  id: string
  body: string
  author?: string
  createdAt: string
}

export interface LinearIssueDetail extends LinearIssue {
  /** Markdown, empty when the issue has none. */
  description: string
  /** Oldest first, up to 50. */
  comments: LinearComment[]
}

/** What the Issues screen lists. Every set field narrows the list. `query` matches the title or the number. */
export interface LinearFilter {
  mine: boolean
  teamId?: string
  projectId?: string
  cycleId?: string
  query?: string
}

/** The teams, projects and cycles the Issues screen filters by. */
export interface LinearScope {
  teams: { id: string; key: string; name: string }[]
  projects: { id: string; name: string; teamIds: string[] }[]
  /** Active and upcoming cycles. */
  cycles: { id: string; number: number; name?: string; teamId: string; active: boolean }[]
}

// ---------- usage and account

export interface RateLimit {
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** 0 to 1. */
  utilization?: number
  /** Epoch seconds, as rate_limit_event sends it. Multiply by 1000 for a Date. */
  resetsAt?: number
  /** Set when one model has its own weekly limit (WorkspaceModelLimit.png). */
  model?: ModelId
}

/** The Claude Code login sessions run on (AccountMenu.png, Settings > Account). */
export interface ClaudeAccount {
  signedIn: boolean
  name?: string
  /** GitHub-style handle shown in the account menu. */
  login?: string
  email?: string
  /** "Claude Max", "Claude Pro". */
  plan?: string
}

// ---------- system

export interface PreflightCheck {
  id: 'claude' | 'auth' | 'teams' | 'gh' | 'hooks'
  ok: boolean
  title: string
  detail: string
  /** Right-hand meta, for example "v2.1.284" or "localhost:7420". */
  meta?: string
  fix?: { command?: string; action?: 'use-next-port' | 'enable-teams' | 'show-process' }
}

/** Hook server and installed hooks (CheckHooks.png, Settings > Hooks, the footer). */
export interface HookStatus {
  port: number
  listening: boolean
  /** All hook entries are present in ~/.claude/settings.json. */
  installed: boolean
  events: { name: string; installed: boolean; lastSeen?: number }[]
}

/** Auto-update (UpdateReady.png, WhatsNew.png). KERNEL-30. */
export interface AppUpdate {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  current: string
  version?: string
  notes?: { title: string; body: string }[]
  progress?: number
  error?: string
  /** True on the first `update.get` after Kernel starts on a newly installed version, so What's new opens once. `notes` are that version's. */
  installed?: boolean
  /** The running version's notes, for What's new when no update is ready (KERNEL-154). Release builds carry them; dev runs have none. */
  currentNotes?: { title: string; body: string }[]
}

export interface Integration {
  id: 'github' | 'linear' | 'vercel' | 'remote'
  name: string
  connected: boolean
  detail: string
}

// ---------- settings

export type Theme = 'dark' | 'light'
export type SettingsPage =
  | 'general' | 'appearance' | 'notifications' | 'account' | 'shortcuts'
  | 'models' | 'agents' | 'permissions' | 'skills'
  | 'git' | 'scripts' | 'prs' | 'files'
  | 'hooks' | 'integrations' | 'experimental' | 'about'
  | 'room'

/** App-wide settings, stored as JSON in the app's data folder. Every Settings page maps to a key here. */
export interface AppSettings {
  hookPort: number
  worktreeRoot: string
  general: { openTo: 'lastPlace' | 'home' | 'inbox'; openAtLogin: boolean; menuBar: boolean; sendWith: 'enter' | 'cmdEnter' }
  floor: { style: 'isometric' | 'plan' | 'list'; nameTags: boolean; animate: boolean }
  appearance: { theme: Theme | 'system'; fontSize: 'default' | 'small' | 'large'; density: 'comfortable' | 'compact'; pointerCursors: boolean; reduceMotion: boolean }
  notifications: {
    permission: boolean; plan: boolean; merge: boolean; checkFailed: boolean; finished: boolean; idle: boolean
    sound: 'subtle' | 'chime' | 'none'; quietHours: { from: string; to: string } | null
  }
  usage: { warnBeforeWeekly: boolean; pauseNearLimit: boolean }
  workspace: { mode: WorkspaceMode; baseRef: string; remote: string; branchPattern: string; deleteBranchOnArchive: boolean; archiveOnMerge: boolean; setUpstream: boolean; baselineCurrentBranch: boolean; oneCurrentBranchPerRoom: boolean }
  scripts: { setupOnCreate: boolean; runAfterSetup: boolean; archiveOnArchive: boolean }
  models: { lead: ModelId; engineers: ModelId; qa: ModelId; reviewer: ModelId; effort: Effort; leadPlanMode: boolean; agentTeams: boolean
    /** Agents working at once, the Lead's chats left out (D-094). 0 means no limit. Was `maxConcurrent`, whose saved 4 was only the old default. */
    agentLimit: number
    /** Kernel tells the Lead when teammates finish a turn or their PRs change (KERNEL-72). */
    leadUpdates: boolean
    /** Workspaces you start from New workspace begin in plan mode. The Lead's hand-offs don't (KERNEL-74). */
    workspacePlanMode: boolean
    /** The effort you last picked for each model. Chats you open start at it, the Lead's hand-offs don't (D-130). */
    effortByModel: Partial<Record<ModelId, Effort>> }
  /** `defaultTemplate` seeds an empty room (Settings > Agents). */
  team: { addNewAgents: boolean; showNames: boolean; defaultTemplate: 'starter' | 'pair' }
  permissions: { mode: 'ask' | 'acceptEdits' | 'bypassInWorktrees'; network: boolean; alwaysAsk: string[]; neverAllow: string[]; protectedBranches: string[]; approvalTimeoutSec: number }
  pr: { mergeMethod: 'squash' | 'merge' | 'rebase'; draft: boolean; requireGreen: boolean; requireReviewer: boolean } & PrInstructions
  hooks: { requireTestOutput: boolean; keepTeammatesWorking: boolean }
  experimental: { bigTerminal: boolean; bigTerminalWorktreeOnly: boolean; walking: boolean; floor3d: boolean; voice: boolean }
}

/** Per-room settings from .kernel/settings.toml, with personal overrides from .kernel/settings.local.toml (SettingsRoom.png). */
export interface RoomSettings {
  scripts: { setup?: string; run?: string; archive?: string; runMode?: 'concurrent' | 'single' }
  /** `copy` takes exact paths and patterns like `.env*` (KERNEL-245). */
  files: { copy: string[]; symlinkNodeModules?: boolean }
  workspace: Partial<AppSettings['workspace']>
  /** Skills and MCP servers switched off for this room, by name. */
  disabled?: { skills: string[]; mcp: string[] }
  /** The room's Linear team, by key ("KERNEL"). The Issues screen opens on it. */
  linear?: { team?: string }
  /** The room's PR instructions, a `[pr]` table. A missing key uses the app's (KERNEL-190). */
  pr?: Partial<PrInstructions>
  /**
   * Which file set each value, by app-side dotted path (`scripts.setup`, `workspace.remote`, `pr.createInstructions`).
   * A path missing here means the app default applies (KERNEL-190).
   */
  sources: Record<string, RoomSettingSource>
}

/** The text Kernel sends the agent for each PR action (Settings > Pull requests, and per room). */
export interface PrInstructions { createInstructions: string; resolveInstructions: string; fixChecksInstructions: string; addressReviewInstructions: string }

/** `shared`: only `.kernel/settings.toml` sets the value. `local`: only `.kernel/settings.local.toml`. `override`: both, and the personal one wins. */
export type RoomSettingSource = 'shared' | 'local' | 'override'

/** The sections of a room's settings page. A route without one opens General. */
export type RoomSettingsSection = 'general' | 'git' | 'scripts' | 'files' | 'environment' | 'instructions' | 'permissions' | 'agents' | 'skills'

/** One file a new worktree gets from the main checkout. `path` is relative to the room's folder, `size` is in bytes. */
export interface FileToCopy {
  path: string
  size: number
}

/** A patch to a room's settings file. `null` removes the key so the app default applies again. */
export type RoomSettingsPatch = {
  [K in Exclude<keyof RoomSettings, 'sources'>]?: { [P in keyof NonNullable<RoomSettings[K]>]?: NonNullable<RoomSettings[K]>[P] | null }
}

/** Recursive partial for settings patches. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object | null ? DeepPartial<T[K]> : T[K] }

// ---------- renderer UI state

/** `loading` is LoadingApp.png: the app shell while the main process boots or reconnects. */
export type OnboardingStep = 'welcome' | 'checks' | 'room' | 'loading'

/** Where the renderer is. Lives here so fixtures can open any screen. One entry per screen family. */
export type DevUiPage = 'components' | 'display' | 'overlays' | 'dialogs'

export type Route =
  | { name: 'onboarding'; step: OnboardingStep; roomId?: string }
  | { name: 'home' } | { name: 'inbox' } | { name: 'history' } | { name: 'rooms' }
  | { name: 'floor'; roomId: string } | { name: 'board'; roomId: string } | { name: 'task'; roomId: string; taskId: string }
  | { name: 'team'; roomId: string } | { name: 'agent'; roomId: string; agentId: string }
  | { name: 'workspace'; workspaceId: string }
  /** Linear issues. `issueId` is the identifier of the open issue. */
  | { name: 'issues'; issueId?: string }
  /** `section` is for `page: 'room'`, and none means General. */
  | { name: 'settings'; page: SettingsPage; roomId?: string; section?: RoomSettingsSection }
  /** The component gallery (KERNEL-9). Dev builds open it from `#/dev/ui/<page>`; fixtures can force it for shots. */
  | { name: 'devUi'; page: DevUiPage }

export type ConfirmKind = 'archive' | 'discard' | 'removeRoom' | 'retire'

/** The one modal shell's contents. At most one modal is open. */
export type Modal =
  | null
  | { name: 'newWorkspace'; roomId?: string; source?: WorkspaceSource }
  | { name: 'search' }
  | { name: 'newRoom'; prefill?: NewRoomPrefill }
  | { name: 'connectRepo' } | { name: 'openFolder' } | { name: 'checkHooks' }
  | { name: 'newAgent'; roomId: string; step: 'describe' | 'draft' | 'done'; prefill?: NewAgentPrefill }
  /** `update` is the install What's new opened with, which later update pushes must not replace (KERNEL-30). */
  | { name: 'whatsNew'; update?: AppUpdate }
  | { name: 'confirm'; kind: 'archive'; workspaceId: string }
  | { name: 'confirm'; kind: 'discard'; workspaceId: string }
  | { name: 'confirm'; kind: 'removeRoom'; roomId: string }
  | { name: 'confirm'; kind: 'retire'; roomId: string; agentId: string }
  /** Closing chats that are still running: the X on a chat tab, Close tab, Close other tabs or Cmd+W. */
  | { name: 'confirm'; kind: 'closeChats'; workspaceId: string; chatIds: string[] }

/**
 * Menus and popovers. One is open at a time. `room:<id>` is a sidebar room's menu.
 * Composer and new workspace menus share names because only one of the two is on screen.
 */
export type MenuId =
  | 'rooms' | `room:${string}` | 'account' | 'plan' | 'quickAsk'
  | 'pr' | 'tab' | 'newTab'
  | 'plus' | 'model' | 'mention' | 'slash' | 'linkIssue' | 'linkWorkspaces'
  | 'branch' | 'from'

/** Failure banners (DESIGN.md Patterns). The banner component reads the facts it shows from the store. */
export type BannerKind = 'limit' | 'context' | 'offline' | 'auth' | 'setup' | 'hooks' | 'retry'

export interface Banner {
  kind: BannerKind
  roomId?: string
  workspaceId?: string
  chatId?: string
}

/** Bottom-right toast, auto-dismissed after 2.6s (WorkspaceToast.png). */
export interface Toast {
  id: string
  title: string
  sub?: string
  action?: { label: string; href?: string }
}

/** The workspace screen's panes, so fixtures can open any of them. */
export interface WorkspaceView {
  right: 'files' | 'changes' | 'checks'
  bottom: 'setup' | 'run' | 'terminal'
  checkpoints: boolean
  /** Tool call groups shown expanded (WorkspaceToolCalls.png). */
  toolsOpen: boolean
  /** What the composer starts with. Fixtures force it so a shot can show chips and an open @ or / menu; the app never sets it. */
  composer?: { parts: ChatPart[]; draft: string }
  /** The composer's context popover is open. Fixtures force it for a shot; the app never sets it. */
  contextOpen?: boolean
}

/** One workspace's open tabs. They outlast the workspace screen, so Settings or another workspace never resets them. */
export interface WorkspaceTabs {
  /** Active tab: a chat id, `file:<path>` for a file preview, `diff:<path>` for a diff (empty path for all changes), `image:<n>` or `text:<n>`. */
  tab?: string
  /** The chat the composer is on while a file, diff, image or text tab is active. */
  lastChat?: string
  /** Paths of the open file tabs. */
  files: string[]
  /** Paths of the open diff tabs. An empty path is All changes. */
  diffs: string[]
}

export interface UiState {
  route: Route
  modal: Modal
  menu: MenuId | null
  toasts: Toast[]
  banner: Banner | null
  theme: Theme
  /** A step of the floor briefing sequence. Real runs derive it from events; fixtures force it. */
  stage?: string
  workspace: WorkspaceView
  /** By workspace id. Each workspace keeps its own open tab, chat and file and diff tabs. */
  tabs: Record<string, WorkspaceTabs>
  /** Ids of the Lead chats folded by hand in the sidebar, which hides the workspaces they started. Only folded chats are listed; kept across launches. */
  foldedChats: string[]
  /** The left sidebar is showing. Its title bar toggle and Cmd+B hide it; kept across launches. */
  sidebar: boolean
  /** The screen's right panel is showing: the floor's Logs, a workspace's files and run panels. Cmd+Option+B; kept across launches. */
  rightPanel: boolean
}

/** One room's Ask Rowan popover (QuickAsk.png). It outlasts the popover, which unmounts when it closes. */
export interface QuickAskState {
  /** What you typed and haven't sent. */
  draft: string
  /** A question is on its way to the Lead. Ask stays busy while the popover is closed and reopened. */
  sending?: boolean
  /** The question just sent, with the chat it went to and when, so the answer is the Lead's text after `since`. */
  asked?: { chatId: string; since: number; question: string }
}

/** UI state a fixture forces on boot. `quickAsk` is by room id, a slice of its own that a fixture can set. */
export type ForcedUi = Partial<UiState> & { quickAsk?: Record<string, QuickAskState> }
