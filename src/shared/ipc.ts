import type {
  ActivityEvent, AgentDef, AgentDraft, AgentEdit, AgentStatus, AppSettings, AppUpdate, Approval, BuiltinCommand, ChangedFile, Chat, ChatItem,
  ChatPart, Checkpoint, ClaudeAccount, Decision, DeepPartial, Effort, FileEntry, FolderInfo, ForcedUi, HookStatus, Hunk,
  Integration, IssueSummary, McpServer, ModelId, NewRoomRequest, Notification, Overlap, PreflightCheck, PrInfo, PrState,
  PrSummary, QueuedMessage, RateLimit, RepoSummary, Room, RoomSettings, RoomSettingsPatch, RoomSetupStep, ScriptKind, Skill, Task, TeamTemplate,
  Workspace, WorkspaceGitStatus, WorkspaceMode, WorkspaceSource
} from './types'

type Ok = { ok: true }

/**
 * Request/response pairs for ipcRenderer.invoke. One place to see everything the UI can ask for, built or not.
 * Channels a lane hasn't built yet reject with NotImplemented naming the issue (see UNBUILT in src/main/kernel.ts).
 */
export interface KernelApi {
  // first run (KERNEL-27)
  'preflight.run': { req: void; res: PreflightCheck[] }
  /** Run a check's own fix: turn on agent teams for Kernel, or move the hook server to the next free port. */
  'preflight.fix': { req: { id: PreflightCheck['id'] }; res: PreflightCheck[] }
  'hooks.install': { req: { port: number }; res: { path: string; events: string[] } }
  'hooks.status': { req: void; res: HookStatus }
  /** Settings > Hooks "Send test event". */
  'hooks.test': { req: void; res: HookStatus }
  /** Restart the hook server, on the given port when set (SetupPortBusy "Use 7421", WorkspaceHooksDown "Reconnect"). */
  'hooks.restart': { req: { port?: number }; res: HookStatus }
  /** Settings > Hooks "Remove": takes Kernel's entries out of Claude Code's user settings and keeps every other hook. */
  'hooks.uninstall': { req: void; res: HookStatus }

  // rooms (KERNEL-20, 22, 24)
  'rooms.list': { req: void; res: Room[] }
  'rooms.add': { req: { path: string; name?: string }; res: Room }
  /** New room modal. Progress arrives as `room.setup` push events. */
  'rooms.create': { req: NewRoomRequest; res: Room }
  'rooms.update': { req: { roomId: string; patch: Partial<Pick<Room, 'name' | 'desc' | 'hidden' | 'archived' | 'desks' | 'allow'>> }; res: Room }
  'rooms.remove': { req: { roomId: string; deleteWorktrees: boolean }; res: Ok }
  'rooms.setPaused': { req: { roomId: string; paused: boolean }; res: Room }
  /** Floor composer: send a brief to the room's Lead, or a message to one agent. `parts` is the message in order when it has chips inline; `text` is its plain words. */
  'rooms.brief': { req: { roomId: string; text: string; parts?: ChatPart[]; agentId?: string }; res: { chatId: string; workspaceId: string } }
  'rooms.overlaps': { req: { roomId: string }; res: Overlap[] }
  /** By agent id, the time of each agent's newest event in the room, read from the whole log. Floor seating ranks idle agents by it. */
  'rooms.lastActivity': { req: { roomId: string }; res: Record<string, number> }
  /** "Let Rowan sort it": the Lead decides which worktree keeps the change. */
  'rooms.resolveOverlap': { req: { overlapId: string }; res: Ok }
  'rooms.inspectFolder': { req: { path: string }; res: FolderInfo }
  'rooms.recentFolders': { req: void; res: FolderInfo[] }
  'github.repos': { req: { query?: string }; res: RepoSummary[] }

  // agents (KERNEL-19, 22)
  'agents.list': { req: { roomId: string; retired?: boolean }; res: AgentDef[] }
  'agents.status': { req: { roomId: string }; res: Record<string, AgentStatus> }
  'agents.save': { req: { roomId: string; agentId: string; patch: AgentEdit }; res: AgentDef }
  /** New agent > Describe: write a draft file from a description. */
  'agents.draft': { req: { roomId: string; description: string; name?: string; model?: string }; res: AgentDraft }
  'agents.create': { req: { roomId: string; draft: AgentDraft }; res: AgentDef }
  /** Moves the file to .claude/retired-agents (D-003). Open workspaces go to `handoffTo`, or the Lead. */
  'agents.retire': { req: { roomId: string; agentId: string; handoffTo?: string }; res: Ok }
  'agents.restore': { req: { roomId: string; agentId: string }; res: AgentDef }
  /** Empty floor: seat a starter team. */
  'agents.seed': { req: { roomId: string; template: TeamTemplate }; res: AgentDef[] }

  // workspaces (KERNEL-10, 11, 16, 21, 28)
  'workspaces.list': { req: { roomId?: string }; res: Workspace[] }
  /** `prompt` names the workspace and its first checkpoint. `parts` is the first message in order when it has chips inline; without text in it, `prompt` goes first. */
  'workspaces.create': { req: { roomId: string; prompt: string; parts?: ChatPart[]; agentId?: string; mode?: WorkspaceMode; baseRef?: string; source?: WorkspaceSource; model?: ModelId; effort?: Effort; plan?: boolean }; res: Workspace }
  'workspaces.archive': { req: { workspaceId: string; deleteBranch?: boolean; push?: boolean }; res: Ok }
  /** History > Restore: a fresh worktree on the archived branch, chats kept. */
  'workspaces.restore': { req: { workspaceId: string }; res: Workspace }
  'workspaces.gitStatus': { req: { workspaceId: string }; res: WorkspaceGitStatus }
  'workspaces.changes': { req: { workspaceId: string }; res: ChangedFile[] }
  'workspaces.diff': { req: { workspaceId: string; file?: string }; res: string }
  'workspaces.tree': { req: { workspaceId: string }; res: FileEntry[] }
  /** @ mentions: files matching the query, best first. */
  'workspaces.files': { req: { workspaceId: string; query: string; limit?: number }; res: FileEntry[] }
  'workspaces.readFile': { req: { workspaceId: string; path: string }; res: string }
  'workspaces.hunks': { req: { workspaceId: string; path?: string }; res: Hunk[] }
  /** Commit only the picked hunks (WorkspaceHunks "Commit selected"). */
  'workspaces.commit': { req: { workspaceId: string; hunkIds: string[]; message?: string }; res: Ok }
  'workspaces.discard': { req: { workspaceId: string }; res: Ok }
  'git.branches': { req: { roomId: string }; res: string[] }
  'github.prs': { req: { roomId: string; query?: string }; res: PrSummary[] }
  /** + > Link issue, GitHub tab: the room's open issues through gh. */
  'github.issues': { req: { roomId: string; query?: string }; res: IssueSummary[] }
  'issues.list': { req: { roomId: string; query?: string }; res: IssueSummary[] }

  // chats (KERNEL-10, 11, 12, 28)
  'chats.list': { req: { workspaceId: string }; res: Chat[] }
  'chats.create': { req: { workspaceId: string; kind?: 'chat' | 'terminal' }; res: Chat }
  'chats.items': { req: { chatId: string }; res: ChatItem[] }
  'chats.send': { req: { chatId: string; parts: ChatPart[] }; res: { queued: boolean } }
  'chats.interrupt': { req: { chatId: string }; res: Ok }
  'chats.configure': { req: { chatId: string; model?: ModelId; effort?: Effort; plan?: boolean }; res: Chat }
  'chats.rename': { req: { chatId: string; title: string }; res: Chat }
  'chats.close': { req: { chatId: string }; res: Ok }
  /** New chat with the transcript up to `itemId` (the whole chat when unset). */
  'chats.fork': { req: { chatId: string; itemId?: string }; res: Chat }
  /** Run the turn that produced `itemId` again. `now` sends it ahead of the queue and stops the running turn (Retry now). */
  'chats.retry': { req: { chatId: string; itemId: string; now?: boolean }; res: Ok }
  'chats.compact': { req: { chatId: string }; res: Ok }
  /** Start a crashed session again (FloorOffline "Restart session"). */
  'chats.restart': { req: { chatId: string }; res: Ok }
  'chats.queue': { req: { chatId: string }; res: QueuedMessage[] }
  'chats.unqueue': { req: { chatId: string; id: string }; res: QueuedMessage[] }
  /** Interrupt the running turn and send this queued message now. */
  'chats.sendNow': { req: { chatId: string; id: string }; res: QueuedMessage[] }
  'skills.list': { req: { roomId: string }; res: Skill[] }
  /** Claude Code's own slash commands for the / menu. The same in every room, so it is read once. */
  'commands.list': { req: void; res: BuiltinCommand[] }
  'terminal.write': { req: { chatId: string; data: string }; res: Ok }
  'terminal.resize': { req: { chatId: string; cols: number; rows: number }; res: Ok }

  // checkpoints (KERNEL-13)
  'checkpoints.list': { req: { workspaceId: string }; res: Checkpoint[] }
  /** Later changes are kept on a backup branch, named in the result. */
  'checkpoints.revert': { req: { workspaceId: string; checkpointId: string }; res: { backupBranch: string } }

  // approvals
  'approvals.list': { req: { roomId?: string }; res: Approval[] }
  'approvals.decide': { req: { id: string; decision: Decision }; res: Approval }
  /** The plan's file, written again from the approval if it was deleted. `relative` is from the workspace folder. */
  'approvals.planFile': { req: { id: string }; res: { path: string; relative: string } }

  // board (KERNEL-18)
  'tasks.list': { req: { roomId: string }; res: Task[] }

  // home and inbox (KERNEL-17)
  'notifications.list': { req: void; res: Notification[] }
  'notifications.read': { req: { ids: string[] | 'all' }; res: Notification[] }
  /** Ask Rowan from anywhere (QuickAsk.png). The answer streams into the returned chat. */
  'lead.ask': { req: { roomId: string; text: string }; res: { chatId: string } }
  /** The Lead's workspace, for the sidebar row, Cmd+K, Cmd+Shift+L and Ask Rowan. Created on the main checkout the first time. */
  'lead.open': { req: { roomId: string }; res: Workspace }
  /** The new workspace modal: the prompt goes to the Lead in a new chat, which takes its title from the first message (KERNEL-148). */
  'lead.start': { req: { roomId: string; prompt: string; parts?: ChatPart[]; model?: ModelId; effort?: Effort; plan?: boolean }; res: Chat }

  // pull requests (KERNEL-15)
  'pr.get': { req: { workspaceId: string }; res: PrInfo | null }
  'pr.create': { req: { workspaceId: string; draft?: boolean }; res: Workspace }
  'pr.refresh': { req: { workspaceId: string }; res: Workspace }
  'pr.merge': { req: { workspaceId: string }; res: Workspace }
  /** One button for conflicts, failing checks and review comments. Sends the matching instructions to the agent. */
  'pr.resolve': { req: { workspaceId: string }; res: Ok }
  'pr.ready': { req: { workspaceId: string }; res: Workspace }
  'pr.reopen': { req: { workspaceId: string }; res: Workspace }
  /** After a merge or close: keep going on a fresh branch from the base, same chat. */
  'pr.continue': { req: { workspaceId: string }; res: Workspace }

  // scripts
  'scripts.run': { req: { workspaceId: string; kind: ScriptKind }; res: Ok }
  'scripts.stop': { req: { workspaceId: string; kind: 'run' }; res: Ok }

  // activity, usage and account (KERNEL-21, 25, 28)
  'activity.recent': { req: { roomId?: string; limit?: number }; res: ActivityEvent[] }
  'usage.get': { req: void; res: RateLimit[] }
  /** "Notify me" on a limit banner: one notification when the limit resets. */
  'usage.notifyOnReset': { req: { type: RateLimit['type'] }; res: Ok }
  'account.get': { req: void; res: ClaudeAccount }
  /** Opens a terminal running `claude /login`, then reports the new account. */
  'account.signIn': { req: void; res: ClaudeAccount }
  'account.signOut': { req: void; res: ClaudeAccount }

  // settings (KERNEL-25, 26)
  'settings.get': { req: void; res: AppSettings }
  'settings.set': { req: { patch: DeepPartial<AppSettings> }; res: AppSettings }
  'settings.room': { req: { roomId: string }; res: RoomSettings }
  /** Writes .kernel/settings.local.toml unless `shared` is set, then .kernel/settings.toml. A `null` removes that key from the file, which is "Use default". */
  'settings.setRoom': { req: { roomId: string; patch: RoomSettingsPatch; shared?: boolean }; res: RoomSettings }
  'mcp.list': { req: { roomId?: string }; res: McpServer[] }
  'integrations.list': { req: void; res: Integration[] }
  /** Linear takes a `token` (an empty one disconnects). GitHub signs in through `gh`, so it only reports its status. */
  'integrations.connect': { req: { id: Integration['id']; token?: string }; res: Integration }

  // app (KERNEL-25, 30)
  'update.get': { req: void; res: AppUpdate }
  'update.check': { req: void; res: AppUpdate }
  /** Restart into the downloaded version. Running agents pause first. */
  'update.install': { req: void; res: Ok }
  /** Writes the activity log to a file in the data folder and returns where (Settings > About). */
  'app.exportLogs': { req: void; res: { path: string } }
  /** What Settings > About shows: Kernel's version and where its data lives. */
  'app.info': { req: void; res: { version: string; dataDir: string } }
  /** A terminal window in a folder, optionally running a command (Open terminal, Sign in). */
  'app.openTerminal': { req: { cwd: string; command?: string }; res: Ok }
  /** "Try again" on the offline banner: check the network now. Main also pushes `online` when it changes. */
  'app.checkOnline': { req: void; res: { online: boolean } }

  // handled in src/main/index.ts, not by the kernel
  'system.pickFolder': { req: void; res: string | null }
  'system.openExternal': { req: { url: string }; res: Ok }
  'system.openInEditor': { req: { path: string }; res: Ok }
  /** Where the traffic lights sit: over the sidebar's top strip, or in the header row while the sidebar is hidden. */
  'system.trafficLights': { req: { at: 'sidebar' | 'header' }; res: Ok }
  /** Fixture mode only (KERNEL_FIXTURES). The UI to force and push events to replay. Null in a real run. */
  'system.fixture': { req: void; res: { ui: ForcedUi; push: PushEvent[] } | null }
}

export type Channel = keyof KernelApi

/** Pushed from main to renderer on 'kernel:event'. */
export type PushEvent =
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat.item'; chatId: string; item: ChatItem }
  /** /clear started a fresh conversation, so the transcript starts over. */
  | { type: 'chat.cleared'; chatId: string }
  | { type: 'chat.running'; chatId: string; running: boolean }
  | { type: 'chat.queue'; chatId: string; queue: QueuedMessage[] }
  | { type: 'terminal.data'; chatId: string; data: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'room'; room: Room }
  | { type: 'room.setup'; roomId: string; steps: RoomSetupStep[] }
  | { type: 'overlap'; overlap: Overlap }
  | { type: 'agents'; roomId: string; agents: AgentDef[] }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'agent.status'; roomId: string; agentId: string; status: AgentStatus; activity?: string }
  | { type: 'script.output'; workspaceId: string; kind: ScriptKind; line: string; stream: 'stdout' | 'stderr' }
  | { type: 'script.exit'; workspaceId: string; kind: ScriptKind; code: number | null }
  | { type: 'checkpoint'; checkpoint: Checkpoint }
  | { type: 'task'; task: Task }
  | { type: 'notification'; notification: Notification }
  | { type: 'usage'; limits: RateLimit[] }
  | { type: 'pr'; workspaceId: string; state: PrState }
  | { type: 'pr.info'; info: PrInfo }
  | { type: 'hooks'; status: HookStatus }
  | { type: 'update'; update: AppUpdate }
  | { type: 'account'; account: ClaudeAccount }
  /** Network reachability as main sees it (WorkspaceOffline.png). */
  | { type: 'online'; online: boolean }
  /** Claude is overloaded and the session is retrying (WorkspaceOverloaded.png). Null when it recovers. */
  | { type: 'retry'; chatId: string; retry: { attempt: number; of: number; nextAt: number } | null }

/** The message an unbuilt channel rejects with. Errors cross IPC as plain messages, so the renderer matches on the prefix. */
export const NOT_IMPLEMENTED = 'Not built yet'

/** Thrown by a channel no lane has built yet. Names the issue that builds it. */
export class NotImplemented extends Error {
  constructor(readonly channel: Channel, readonly issue: string) {
    super(`${NOT_IMPLEMENTED}: ${channel} (${issue})`)
    this.name = 'NotImplemented'
  }
}

export const isNotImplemented = (err: unknown) => err instanceof Error && err.message.includes(`${NOT_IMPLEMENTED}: `)
