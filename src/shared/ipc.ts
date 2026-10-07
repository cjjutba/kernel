import type {
  ActivityEvent, AgentDef, AgentStatus, Approval, ChangedFile, Chat, ChatItem, ChatPart, Decision,
  Effort, ForcedUi, ModelId, PreflightCheck, PrState, RateLimit, Room, Workspace, WorkspaceMode
} from './types'

/** Request/response pairs for ipcRenderer.invoke. One place to see everything the UI can ask for. */
export interface KernelApi {
  'preflight.run': { req: void; res: PreflightCheck[] }
  'hooks.install': { req: { port: number }; res: { path: string; events: string[] } }

  'rooms.list': { req: void; res: Room[] }
  'rooms.add': { req: { path: string; name?: string }; res: Room }
  'rooms.setPaused': { req: { roomId: string; paused: boolean }; res: Room }
  /** Floor composer: send a brief to the room's Lead. */
  'rooms.brief': { req: { roomId: string; text: string; agentId?: string }; res: { chatId: string; workspaceId: string } }

  'agents.list': { req: { roomId: string }; res: AgentDef[] }
  'agents.status': { req: { roomId: string }; res: Record<string, AgentStatus> }

  'workspaces.list': { req: { roomId?: string }; res: Workspace[] }
  'workspaces.create': { req: { roomId: string; prompt: string; agentId?: string; mode?: WorkspaceMode; baseRef?: string; model?: ModelId; effort?: Effort; plan?: boolean }; res: Workspace }
  'workspaces.archive': { req: { workspaceId: string; deleteBranch?: boolean }; res: { ok: true } }
  'workspaces.changes': { req: { workspaceId: string }; res: ChangedFile[] }
  'workspaces.diff': { req: { workspaceId: string; file?: string }; res: string }

  'chats.list': { req: { workspaceId: string }; res: Chat[] }
  'chats.create': { req: { workspaceId: string; kind?: 'chat' | 'terminal' }; res: Chat }
  'chats.items': { req: { chatId: string }; res: ChatItem[] }
  'chats.send': { req: { chatId: string; parts: ChatPart[] }; res: { queued: boolean } }
  'chats.interrupt': { req: { chatId: string }; res: { ok: true } }
  'chats.configure': { req: { chatId: string; model?: ModelId; effort?: Effort; plan?: boolean }; res: Chat }

  'approvals.list': { req: { roomId?: string }; res: Approval[] }
  'approvals.decide': { req: { id: string; decision: Decision }; res: Approval }

  'pr.create': { req: { workspaceId: string; draft?: boolean }; res: Workspace }
  'pr.refresh': { req: { workspaceId: string }; res: Workspace }
  'pr.merge': { req: { workspaceId: string }; res: Workspace }
  'pr.resolve': { req: { workspaceId: string }; res: { ok: true } }
  'pr.ready': { req: { workspaceId: string }; res: Workspace }
  'pr.reopen': { req: { workspaceId: string }; res: Workspace }

  'scripts.run': { req: { workspaceId: string; kind: 'setup' | 'run' | 'archive' }; res: { ok: true } }
  'scripts.stop': { req: { workspaceId: string; kind: 'run' }; res: { ok: true } }

  'activity.recent': { req: { roomId?: string; limit?: number }; res: ActivityEvent[] }
  'usage.get': { req: void; res: RateLimit[] }

  'system.pickFolder': { req: void; res: string | null }
  'system.openExternal': { req: { url: string }; res: { ok: true } }
  'system.openInEditor': { req: { path: string }; res: { ok: true } }
  /** Fixture mode only (KERNEL_FIXTURES). The UI to force and push events to replay. Null in a real run. */
  'system.fixture': { req: void; res: { ui: ForcedUi; push: PushEvent[] } | null }
}

export type Channel = keyof KernelApi

/** Pushed from main to renderer on 'kernel:event'. */
export type PushEvent =
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'chat.item'; chatId: string; item: ChatItem }
  | { type: 'chat.running'; chatId: string; running: boolean }
  | { type: 'approval'; approval: Approval }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'agent.status'; roomId: string; agentId: string; status: AgentStatus; activity?: string }
  | { type: 'script.output'; workspaceId: string; kind: 'setup' | 'run' | 'archive'; line: string; stream: 'stdout' | 'stderr' }
  | { type: 'script.exit'; workspaceId: string; kind: 'setup' | 'run' | 'archive'; code: number | null }
  | { type: 'usage'; limits: RateLimit[] }
  | { type: 'pr'; workspaceId: string; state: PrState }
