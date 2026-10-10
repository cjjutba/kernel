import type {
  ActivityEvent, AgentDef, AgentStatus, AppSettings, AppUpdate, Approval, ChangedFile, Chat, ChatItem, Checkpoint, ClaudeAccount,
  FileEntry, FileToCopy, FolderInfo, ForcedUi, HookStatus, Hunk, IssueSummary, PrSummary, Notification, Overlap, PreflightCheck, PrInfo, QueuedMessage, RateLimit, RepoSummary, Room, RoomSettings,
  Integration, LinearIssueDetail, LinearScope, McpServer, Skill, Task, Workspace, WorkspaceGitStatus
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
  notifications?: Notification[]
  /** By workspace id. */
  prs?: Record<string, PrInfo>
  overlaps?: Overlap[]
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
   * `runScripts`: without it the room has `run` alone, when `scripts.run` is set.
   */
  roomSettings?: Record<string, Omit<RoomSettings, 'sources' | 'runScripts'> & Partial<Pick<RoomSettings, 'sources' | 'runScripts'>>>
  /** By room id, the data URL `rooms.icon` returns for a room with an icon. */
  roomIcons?: Record<string, string>
  /** By room id, the ignored files in the room's main checkout. `files.preview` picks from them with the room's Files to copy. */
  localFiles?: Record<string, FileToCopy[]>
  account?: ClaudeAccount
  hooks?: HookStatus
  /** By workspace id. What the archive and discard confirmations read. Defaults to the fixture's changes and nothing unpushed. */
  gitStatus?: Record<string, WorkspaceGitStatus>
  update?: AppUpdate
  ui: ForcedUi
  /** Replayed once the renderer has booted, for state that only arrives as events (running chats, script output). */
  push: PushEvent[]
}
