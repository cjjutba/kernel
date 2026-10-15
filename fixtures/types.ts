import type { AccountProfile, MoveNotice, MovePreview, Provider, ProviderModel, ProviderStatus,
  ActivityEvent, AgentDef, AgentStatus, AppSettings, AppUpdate, Approval, BranchCommit, ChangedFile, Chat, ChatItem, Checkpoint, CheckpointPreview, ClaudeAccount, DeletePreview,
  FileEntry, FileToCopy, FolderInfo, ForcedUi, GitHubStatus, GithubIssueDetail, HookStatus, Hunk, IssueSummary, IssueTaken, PrSummary, Notification, OpenItem, Overlap, PreflightCheck, PrInfo, ProductionHint, PushCheck, QueuedMessage, RateLimit, RepoSummary, Room, RoomSettings, RoomTracker, SharedAnchor, SharedComment, SharedFile,
  Integration, LinearIssueDetail, LinearScope, McpAccount, McpServer, ScriptSuggestion, Skill, Task, TerminalPreset, Thread, Workspace, WorkspaceGitStatus
} from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { TelemetryRecord } from '@shared/telemetry'

/** What `pnpm shots <Screen> --motion` does: a click on a button by its accessible name, or key presses in Playwright's names (`Meta+Shift+Enter`). */
export type MotionAction = { click: string } | { press: string[] }

/** Everything one screen needs. `KERNEL_FIXTURES=<key>` serves it in place of the kernel. */
export interface Fixture {
  rooms: Room[]
  /** By room id. */
  agents: Record<string, AgentDef[]>
  /** By room id, then agent id. */
  status: Record<string, Record<string, AgentStatus>>
  workspaces: Workspace[]
  chats: Chat[]
  /** By chat id. */
  items: Record<string, ChatItem[]>
  approvals: Approval[]
  activity: ActivityEvent[]
  usage: RateLimit[]
  preflight: PreflightCheck[]
  /** By workspace id. */
  changes: Record<string, ChangedFile[]>
  /** By workspace id. */
  diffs: Record<string, string>
  // Optional data for screens built after KERNEL-8. A missing field reads as empty, or as the defaults in src/main/fixtures.ts.
  /** By room id. */
  tasks?: Record<string, Task[]>
  /** The chat New chat's Send lands on, by chat id. Without it a send fails, since fixture mode starts nothing (KERNEL-825). */
  leadStart?: string
  /** By workspace id. */
  checkpoints?: Record<string, Checkpoint[]>
  /** What reverting would do, by workspace id, then checkpoint id (KERNEL-764). A missing one reads as no files and no commits. */
  checkpointPreviews?: Record<string, Record<string, CheckpointPreview>>
  /** What the Delete confirm in History counts (KERNEL-333). A missing field reads as fixed numbers. */
  deletePreview?: DeletePreview
  notifications?: Notification[]
  /** By workspace id. */
  prs?: Record<string, PrInfo>
  overlaps?: Overlap[]
  /** Lead chats, each holding the Lead tabs whose `threadId` names it (KERNEL-337). */
  threads?: Thread[]
  /** What each Lead chat still owes, by `threadId` (KERNEL-749). */
  openItems?: OpenItem[]
  /** The signed-in user's GitHub repos (ConnectRepo.png). */
  repos?: RepoSummary[]
  /** Recent project folders (OpenFolder.png). */
  folders?: FolderInfo[]
  /** By chat id. */
  queue?: Record<string, QueuedMessage[]>
  /** By workspace id. */
  tree?: Record<string, FileEntry[]>
  /** By workspace id. */
  hunks?: Record<string, Hunk[]>
  /** By workspace id, the commit rows of the Changes ⋯ menu (PanelCompare, KERNEL-516). */
  commits?: Record<string, BranchCommit[]>
  /** By workspace id, then path. */
  fileText?: Record<string, Record<string, string>>
  /** By workspace id, then `${at}:${path}`, what `workspaces.readImage` returns (KERNEL-409). */
  images?: Record<string, Record<string, { dataUrl: string }>>
  skills?: Skill[]
  mcp?: McpServer[]
  /** What `mcp.accounts` returns: every account's MCP servers (KERNEL-626). */
  mcpAccounts?: McpAccount[]
  integrations?: Integration[]
  /** Branches the new workspace modal lists, local and origin/*. */
  branches?: string[]
  /** Open PRs and Linear issues the new workspace modal lists. */
  openPrs?: PrSummary[]
  issues?: IssueSummary[]
  /** What `issues.taken` finds for any issue (ConfirmIssueTaken.png, KERNEL-479). Left out, nothing. */
  issueTaken?: IssueTaken
  /** What the Issues screen reads (KERNEL-159). Issues carry their detail, so the issue pane needs nothing else. */
  linear?: { issues?: LinearIssueDetail[]; scope?: LinearScope }
  /** By room id, the tracker `issues.tracker` reports. A room without one reads as Linear, which every Issues and New workspace fixture drew before KERNEL-471. */
  trackers?: Record<string, RoomTracker>
  /** By room id, the open issues of a GitHub room, each with the description and comments the Issues pane reads (KERNEL-471). */
  githubIssues?: Record<string, GithubIssueDetail[]>
  settings?: AppSettings
  /** Channels whose calls never answer, so a screenshot can show the wait (IssuesLoading, AccountSwitching, KERNEL-759). */
  hold?: string[]
  /**
   * By room id. `sources` is optional: a fixture without it reads as every value coming from the app default. So is
   * `runScripts`: without it the room has `run` alone, when `scripts.run` is set. And `preview`, which reads as no URLs,
   * and `env`, which reads as no env files.
   */
  roomSettings?: Record<string, Omit<RoomSettings, 'sources' | 'runScripts' | 'preview' | 'env' | 'references'> & Partial<Pick<RoomSettings, 'sources' | 'runScripts' | 'preview' | 'env' | 'references'>>>
  /** By room id, what `scripts.suggest` returns. None when unset (KERNEL-682). */
  scriptSuggestions?: Record<string, ScriptSuggestion[]>
  /**
   * Variables by name only, never values: `app` for the app's, `rooms` by room id. A room's `files` are its env files
   * with whether each is missing (KERNEL-247).
   */
  env?: { app?: string[]; rooms?: Record<string, { names?: string[]; files?: { path: string; missing: boolean }[] }> }
  /** The CLIs `terminal.presets` lists as found on the PATH, after the built-ins and before the custom ones. None when unset (KERNEL-248). */
  terminalClis?: TerminalPreset[]
  /** By room id, the data URL `rooms.icon` returns for a room with an icon. */
  roomIcons?: Record<string, string>
  /** By room id, what `rooms.pushCheck` returns (KERNEL-460). A room left out has no remote. */
  pushChecks?: Record<string, PushCheck>
  /** By room id, the ignored files in the room's main checkout. `files.preview` picks from them with the room's Files to copy. */
  localFiles?: Record<string, FileToCopy[]>
  /** By room id, what `files.production` answers: the files to copy that look like production (KERNEL-449). */
  production?: Record<string, ProductionHint[]>
  account?: ClaudeAccount
  /** Both providers' accounts (Settings, Providers, the account menu, KERNEL-406). */
  accounts?: AccountProfile[]
  /** What `accounts.previewSwitch` returns: the long chats a switch would move (KERNEL-845). Without it a switch moves none. */
  movePreview?: MovePreview
  /** By chat id, what `chats.moveNotice` answers: the notice above the composer (KERNEL-841). */
  moveNotices?: Record<string, MoveNotice>
  /** The status table of each provider's Providers tab. */
  providerStatus?: Partial<Record<Provider, ProviderStatus>>
  /** Each provider's models for the pickers. Claude's default to Kernel's list. */
  models?: Partial<Record<Provider, ProviderModel[]>>
  hooks?: HookStatus
  /** A GitHub rate limit holding Kernel's PR reads off (WorkspaceGitHubPaused, KERNEL-401). */
  github?: GitHubStatus
  /** By workspace id. What the archive and discard confirmations read. Defaults to the fixture's changes and nothing unpushed. */
  gitStatus?: Record<string, WorkspaceGitStatus>
  update?: AppUpdate
  /** Files agents shared (KERNEL-302). `shared.list` filters them by room or workspace. */
  shared?: SharedFile[]
  /**
   * By shared id, then version: what `shared.read` returns. Images and PDFs as a data URL, Markdown and HTML as text.
   * `still` is what `system.preview.open` returns in place of a live view, the thumbnail when unset (KERNEL-303).
   */
  sharedData?: Record<string, Record<number, { text?: string; dataUrl?: string; thumb?: string; still?: string }>>
  /** Comments on shared files, every version (KERNEL-310). `shared.comments` filters them by shared id. */
  sharedComments?: SharedComment[]
  /** What `system.preview.hit` answers in a fixture run, which has no live page: the innermost anchor whose element box holds the point, as it is written (KERNEL-311). */
  sharedHits?: SharedAnchor[]
  /** Usage data (KERNEL-397): whether this build could send, and what Settings, Privacy lists. Left out, it can't and lists nothing. */
  telemetry?: { canSend?: boolean; recent?: TelemetryRecord[] }
  ui: ForcedUi
  /** `pnpm shots <Screen> --motion` runs `action` and captures frames for `ms`. `area` is a selector to crop to, else the whole window (KERNEL-831). */
  motion?: { action: MotionAction; ms: number; area?: string }
  /**
   * Replayed once the renderer has booted, for state that only arrives as events (running chats, script output). A run
   * script that prints a local URL here gets its `script.url` too, as in the engine (KERNEL-246).
   */
  push: PushEvent[]
}
