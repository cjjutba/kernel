import type {
  ActivityEvent, AgentDef, AgentStatus, AppSettings, AppUpdate, Approval, ChangedFile, Chat, ChatItem, Checkpoint, ClaudeAccount,
  FileEntry, FolderInfo, ForcedUi, HookStatus, Hunk, Notification, Overlap, PreflightCheck, PrInfo, QueuedMessage, RateLimit, RepoSummary, Room, RoomSettings,
  Skill, Task, Workspace
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
  settings?: AppSettings
  /** By room id. */
  roomSettings?: Record<string, RoomSettings>
  account?: ClaudeAccount
  hooks?: HookStatus
  update?: AppUpdate
  ui: ForcedUi
  /** Replayed once the renderer has booted, for state that only arrives as events (running chats, script output). */
  push: PushEvent[]
}
