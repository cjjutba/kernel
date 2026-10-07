import type {
  ActivityEvent, AgentDef, AgentStatus, Approval, ChangedFile, Chat, ChatItem, ForcedUi, PreflightCheck, RateLimit, Room, Workspace
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
  ui: ForcedUi
  /** Replayed once the renderer has booted, for state that only arrives as events (running chats, script output). */
  push: PushEvent[]
}
