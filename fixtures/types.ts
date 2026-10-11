import type {
  ActivityEvent, AgentDef, AgentStatus, AppSettings, AppUpdate, Approval, ChangedFile, Chat, ChatItem, Checkpoint, ClaudeAccount, DeletePreview,
  FileEntry, FileToCopy, FolderInfo, ForcedUi, HookStatus, Hunk, IssueSummary, PrSummary, Notification, Overlap, PreflightCheck, PrInfo, QueuedMessage, RateLimit, RepoSummary, Room, RoomSettings, SharedAnchor, SharedComment, SharedFile,
  Integration, LinearIssueDetail, LinearScope, McpServer, Skill, Task, TerminalPreset, Thread, Workspace, WorkspaceGitStatus
} from '@shared/types'
import type { PushEvent } from '@shared/ipc'

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
  /** By workspace id. */
  checkpoints?: Record<string, Checkpoint[]>
  /** What the Delete confirm in History counts (KERNEL-333). A missing field reads as fixed numbers. */
  deletePreview?: DeletePreview
  notifications?: Notification[]
  /** By workspace id. */
  prs?: Record<string, PrInfo>
  overlaps?: Overlap[]
  /** Lead chats, each holding the Lead tabs whose `threadId` names it (KERNEL-337). */
  threads?: Thread[]
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
  /** By workspace id, then path. */
  fileText?: Record<string, Record<string, string>>
  skills?: Skill[]
  mcp?: McpServer[]
  integrations?: Integration[]
  /** Branches the new workspace modal lists, local and origin/*. */
  branches?: string[]
  /** Open PRs and Linear issues the new workspace modal lists. */
  openPrs?: PrSummary[]
  issues?: IssueSummary[]
  /** What the Issues screen reads (KERNEL-159). Issues carry their detail, so the issue pane needs nothing else. */
  linear?: { issues?: LinearIssueDetail[]; scope?: LinearScope }
  settings?: AppSettings
  /**
   * By room id. `sources` is optional: a fixture without it reads as every value coming from the app default. So is
   * `runScripts`: without it the room has `run` alone, when `scripts.run` is set. And `preview`, which reads as no URLs,
   * and `env`, which reads as no env files.
   */
  roomSettings?: Record<string, Omit<RoomSettings, 'sources' | 'runScripts' | 'preview' | 'env'> & Partial<Pick<RoomSettings, 'sources' | 'runScripts' | 'preview' | 'env'>>>
  /**
   * Variables by name only, never values: `app` for the app's, `rooms` by room id. A room's `files` are its env files
   * with whether each is missing (KERNEL-247).
   */
  env?: { app?: string[]; rooms?: Record<string, { names?: string[]; files?: { path: string; missing: boolean }[] }> }
  /** The CLIs `terminal.presets` lists as found on the PATH, after the built-ins and before the custom ones. None when unset (KERNEL-248). */
  terminalClis?: TerminalPreset[]
  /** By room id, the data URL `rooms.icon` returns for a room with an icon. */
  roomIcons?: Record<string, string>
  /** By room id, the ignored files in the room's main checkout. `files.preview` picks from them with the room's Files to copy. */
  localFiles?: Record<string, FileToCopy[]>
  account?: ClaudeAccount
  hooks?: HookStatus
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
  ui: ForcedUi
  /**
   * Replayed once the renderer has booted, for state that only arrives as events (running chats, script output). A run
   * script that prints a local URL here gets its `script.url` too, as in the engine (KERNEL-246).
   */
  push: PushEvent[]
}
