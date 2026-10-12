import type {
  AccountAddStep, AccountProfile, ActivityEvent, AgentDef, AgentDraft, AgentEdit, AgentStatus, AppSettings, AppUpdate, Approval, BuiltinCommand, ChangedFile, Chat, ChatItem,
  ChatPart, Checkpoint, ClaudeAccount, ClaudePlan, Decision, DeepPartial, DeletePreview, DeleteResult, Effort, FileEntry, FileToCopy, FolderInfo, ForcedUi, GitHubStatus, HookStatus, Hunk,
  Integration, IssueSummary, IssueTaken, LinearFilter, LinearIssue, LinearIssueDetail, LinearScope, McpServer, ModeAvailability, NewRoomRequest, Notification, OpenApp, Overlap, PreflightCheck, MergeAllResult, MergeQueue, PrBlocked, PrInfo, PrState,
  PermissionMode, PrSummary, Provider, ProviderModel, ProviderStatus, QueuedMessage, QueueReason, RateLimit, RepoSummary, Room, RoomSettings, RoomSettingsPatch, RoomSetupStep, ScriptKind, ScriptLine, ScriptTrust, ChatArchivePreview, SharedAnchor, SharedComment, SharedFile, SharedKind, Skill, Task, TeamTemplate, TerminalPreset, Thread,
  TeamPatch, Toast, Workspace, WorkspaceGitStatus, WorkspaceMode, WorkspaceSource
} from './types'
import type { TelemetryEvent, TelemetryRecord } from './telemetry'

type Ok = { ok: true }

/** Claude is overloaded and the session is retrying: which attempt, out of how many, and when the next one goes. */
export interface Retry { attempt: number; of: number; nextAt: number }

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
  /** Whether a GitHub rate limit holds Kernel's PR reads off, and until when (the footer, KERNEL-401). */
  'github.status': { req: void; res: GitHubStatus }
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
  'rooms.update': { req: { roomId: string; patch: Partial<Pick<Room, 'name' | 'desc' | 'hidden' | 'archived' | 'desks' | 'allow' | 'allowTools' | 'permissionMode' | 'host'>> }; res: Room }
  /** Sets the room icon. The letter clears it. When the GitHub avatar can't be fetched it throws a plain error and the room keeps its letter. */
  'rooms.setIcon': { req: { roomId: string; icon: { kind: 'letter' } | { kind: 'github' } | { kind: 'image'; path: string } }; res: Room }
  /** The room icon as a data URL, or null for the letter. */
  'rooms.icon': { req: { roomId: string }; res: string | null }
  'rooms.remove': { req: { roomId: string; deleteWorktrees: boolean }; res: Ok }
  'rooms.setPaused': { req: { roomId: string; paused: boolean }; res: Room }
  /** Floor composer: send a brief to the room's Lead, or a message to one agent. `parts` is the message in order when it has chips inline; `text` is its plain words. */
  'rooms.brief': { req: { roomId: string; text: string; parts?: ChatPart[]; agentId?: string }; res: { chatId: string; workspaceId: string } }
  'rooms.overlaps': { req: { roomId: string }; res: Overlap[] }
  /** By agent id, the time of each agent's newest event in the room, read from the whole log. Floor seating ranks idle agents by it. */
  'rooms.lastActivity': { req: { roomId: string }; res: Record<string, number> }
  /** "Let Rowan sort it": the Lead decides which worktree keeps the change. */
  'rooms.resolveOverlap': { req: { overlapId: string }; res: Ok }
  /** What the room's scripts and files.copy list wait on, or null when there is nothing to trust (KERNEL-209). */
  'rooms.scriptTrust': { req: { roomId: string }; res: ScriptTrust | null }
  /** Trust the text behind `hash` and release the room's workspaces held in `trust`. Rejects when the text changed since. */
  'rooms.trust': { req: { roomId: string; hash: string }; res: Ok }
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
  /**
   * Who leads, who reviews and who takes tasks: writes the `[team]` table in the shared .kernel/settings.toml and returns
   * the team as Kernel now resolves it (KERNEL-397). `from` says which screen asked.
   */
  'agents.setTeam': { req: { roomId: string; team: TeamPatch; from?: 'setup' | 'settings' }; res: AgentDef[] }
  /** Copies Kernel's own Lead or reviewer into .claude/agents so the user can edit it, and returns the new file's agent. */
  'agents.customize': { req: { roomId: string; agentId: string }; res: AgentDef }
  /** Team > Add a starter agent: copies one of Kernel's starter files into .claude/agents. Refuses one the team already has. */
  'agents.addStarter': { req: { roomId: string; id: string }; res: AgentDef }

  // workspaces (KERNEL-10, 11, 16, 21, 28)
  'workspaces.list': { req: { roomId?: string }; res: Workspace[] }
  /** `prompt` names the workspace and its first checkpoint. `parts` is the first message in order when it has chips inline; without text in it, `prompt` goes first. */
  'workspaces.create': { req: { roomId: string; prompt: string; parts?: ChatPart[]; agentId?: string; mode?: WorkspaceMode; baseRef?: string; source?: WorkspaceSource; provider?: Provider; model?: string; effort?: Effort; plan?: boolean }; res: Workspace }
  /**
   * Fork into new workspace (KERNEL-346): a new worktree workspace on a branch from the chat's workspace's HEAD, with its files as
   * they are now, and the chat up to `itemId` (the whole chat when unset). Answers once the workspace and its chat exist; setup goes on.
   */
  'workspaces.fork': { req: { chatId: string; itemId?: string }; res: Workspace }
  'workspaces.archive': { req: { workspaceId: string; deleteBranch?: boolean; push?: boolean }; res: Ok }
  /** History > Restore: a fresh worktree on the archived branch, chats kept. */
  'workspaces.restore': { req: { workspaceId: string }; res: Workspace }
  /** History > Delete, before the confirm opens: what it would remove and skip (KERNEL-333). */
  'workspaces.deletePreview': { req: { workspaceIds: string[] }; res: DeletePreview }
  /** History > Delete: forgets archived workspaces for good, with their branches, checkpoints and Claude Code transcripts. `deleteUnpushed` also deletes branches whose commits are pushed nowhere. */
  'workspaces.delete': { req: { workspaceIds: string[]; deleteUnpushed: boolean }; res: DeleteResult }
  'workspaces.gitStatus': { req: { workspaceId: string }; res: WorkspaceGitStatus }
  'workspaces.changes': { req: { workspaceId: string }; res: ChangedFile[] }
  'workspaces.diff': { req: { workspaceId: string; file?: string }; res: string }
  'workspaces.tree': { req: { workspaceId: string }; res: FileEntry[] }
  /** @ mentions: files matching the query, best first. */
  'workspaces.files': { req: { workspaceId: string; query: string; limit?: number }; res: FileEntry[] }
  'workspaces.readFile': { req: { workspaceId: string; path: string }; res: string }
  /**
   * An image for the diff tab, as a data URL: `worktree` reads the file on disk, `base` the version the diff compares against.
   * Null when the file isn't there (KERNEL-409).
   */
  'workspaces.readImage': { req: { workspaceId: string; path: string; at: 'worktree' | 'base' }; res: { dataUrl: string } | null }
  'workspaces.hunks': { req: { workspaceId: string; path?: string }; res: Hunk[] }
  /** Commit only the picked hunks (WorkspaceHunks "Commit selected"). */
  'workspaces.commit': { req: { workspaceId: string; hunkIds: string[]; message?: string }; res: Ok }
  'workspaces.discard': { req: { workspaceId: string }; res: Ok }
  'git.branches': { req: { roomId: string }; res: string[] }
  'github.prs': { req: { roomId: string; query?: string }; res: PrSummary[] }
  /** + > Link issue, GitHub tab: the room's open issues through gh. */
  'github.issues': { req: { roomId: string; query?: string }; res: IssueSummary[] }
  'issues.list': { req: { roomId: string; query?: string }; res: IssueSummary[] }
  /**
   * Before New workspace starts on an issue: a branch on the remote, an open PR or another assignee that says someone else may
   * be on it (ConfirmIssueTaken.png, KERNEL-479). A check that can't answer adds a note instead of holding the start up.
   */
  'issues.taken': { req: { roomId: string; issue: string }; res: IssueTaken }

  // Linear issues (KERNEL-159)
  /** Open issues, newest first, up to 100. */
  'linear.issues': { req: { filter: LinearFilter }; res: LinearIssue[] }
  /** One issue by identifier, with its description and comments. */
  'linear.issue': { req: { id: string }; res: LinearIssueDetail }
  'linear.scope': { req: void; res: LinearScope }
  /** Plan with Rowan: a fresh Lead chat in plan mode, briefed with the issue. */
  'linear.plan': { req: { id: string; roomId: string }; res: { chatId: string; workspaceId: string } }

  // chats (KERNEL-10, 11, 12, 28)
  'chats.list': { req: { workspaceId: string }; res: Chat[] }
  /**
   * `preset` picks what a terminal tab runs, the settings' preset when unset (KERNEL-248). In the Lead's workspace a chat tab
   * joins `threadId`, or starts a new thread when it is unset (KERNEL-337).
   */
  /** `provider` opens the tab on that provider, with `model` and `effort` when given ("New chat on Codex", KERNEL-406). */
  'chats.create': { req: { workspaceId: string; kind?: 'chat' | 'terminal'; preset?: string; threadId?: string; provider?: Provider; model?: string; effort?: Effort }; res: Chat }
  'chats.items': { req: { chatId: string }; res: ChatItem[] }
  'chats.send': { req: { chatId: string; parts: ChatPart[] }; res: { queued: boolean } }
  'chats.interrupt': { req: { chatId: string }; res: Ok }
  /**
   * Model and effort move within the chat's provider. The other provider is a new chat (`chats.create` with `provider`).
   * `mode` is the chat's permission mode (KERNEL-432).
   */
  'chats.configure': { req: { chatId: string; model?: string; effort?: Effort; plan?: boolean; mode?: PermissionMode }; res: Chat }
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
  /** What the chat's queue waits for, null when it is empty. `chat.queue` events carry each change (KERNEL-271). */
  'chats.queueReason': { req: { chatId: string }; res: QueueReason | null }
  'chats.unqueue': { req: { chatId: string; id: string }; res: QueuedMessage[] }
  /** Interrupt the running turn and send this queued message now. */
  'chats.sendNow': { req: { chatId: string; id: string }; res: QueuedMessage[] }
  /**
   * The chats with a turn running and the ones retrying, which `chat.running` and `retry` only report as they change. A window
   * that loads while agents work reads them here, or every working agent would look stopped (KERNEL-340).
   */
  'chats.live': { req: void; res: { running: string[]; retry: Record<string, Retry> } }
  'skills.list': { req: { roomId: string }; res: Skill[] }
  /** Claude Code's own slash commands for the / menu. The same in every room, so it is read once. */
  'commands.list': { req: void; res: BuiltinCommand[] }
  'terminal.write': { req: { chatId: string; data: string }; res: Ok }
  'terminal.resize': { req: { chatId: string; cols: number; rows: number }; res: Ok }
  /** Pushes the terminal's kept output as one `terminal.data` with `replace`, for a window that wasn't there to see it (KERNEL-340). */
  'terminal.replay': { req: { chatId: string }; res: Ok }
  /** The presets a new big terminal tab can run: the built-ins, the CLIs on the PATH, then the custom ones (KERNEL-248). */
  'terminal.presets': { req: void; res: TerminalPreset[] }

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
  'lead.ask': { req: { roomId: string; text: string; threadId?: string }; res: { chatId: string } }
  /**
   * The workspace of the room's newest open chat with Rowan, for the sidebar row, Cmd+K, Cmd+Shift+L and Ask Rowan. Null when no chat
   * is open: it never starts one (KERNEL-405).
   */
  'lead.open': { req: { roomId: string }; res: Workspace | null }
  /**
   * The new workspace modal: the prompt goes to the Lead in a new chat, which takes its title from the first message (KERNEL-148). The
   * chat gets its own worktree, on a branch from `baseRef` or the latest default branch, and the prompt waits for setup (KERNEL-405).
   */
  'lead.start': { req: { roomId: string; prompt: string; parts?: ChatPart[]; provider?: Provider; model?: string; effort?: Effort; plan?: boolean; baseRef?: string }; res: Chat }
  /** The Lead chats, each holding one or more Lead tabs, in every room or in `roomId`, oldest first (KERNEL-337). */
  'threads.list': { req: { roomId?: string }; res: Thread[] }
  /** Names a Lead chat. Kernel stops naming it after its first tab from then on. */
  'threads.rename': { req: { threadId: string; title: string }; res: Thread }
  /** What archiving a chat with Rowan would stop, per workspace, its own last (KERNEL-405). */
  'threads.archivePreview': { req: { threadId: string }; res: ChatArchivePreview }
  /** Archives a chat with Rowan: the workspaces it handed off, unless Settings says otherwise, then its own (KERNEL-405). */
  'threads.archive': { req: { threadId: string }; res: Ok }

  // pull requests (KERNEL-15)
  'pr.get': { req: { workspaceId: string }; res: PrInfo | null }
  'pr.create': { req: { workspaceId: string; draft?: boolean }; res: Workspace }
  'pr.refresh': { req: { workspaceId: string }; res: Workspace }
  'pr.merge': { req: { workspaceId: string }; res: Workspace }
  /** Merges the room's ready PRs one at a time, in the order given, and stops at the first that can't merge (KERNEL-411). */
  'pr.mergeAll': { req: { roomId: string; workspaceIds: string[] }; res: MergeAllResult }
  /** One button for conflicts, failing checks and review comments. Sends the matching instructions to the agent. */
  'pr.resolve': { req: { workspaceId: string }; res: Ok }
  'pr.ready': { req: { workspaceId: string }; res: Workspace }
  'pr.reopen': { req: { workspaceId: string }; res: Workspace }
  /** After a merge or close: keep going on a fresh branch from the base, same chat. */
  'pr.continue': { req: { workspaceId: string }; res: Workspace }

  // scripts
  /** `name` picks a run script. Without one it is `run`, the default (KERNEL-244). */
  'scripts.run': { req: { workspaceId: string; kind: ScriptKind; name?: string }; res: Ok }
  /** Stops the named run script, or every run script in the workspace without a name. */
  'scripts.stop': { req: { workspaceId: string; kind: 'run' | 'setup'; name?: string }; res: Ok }
  /** Send anyway: a failed setup is skipped and the messages waiting for it go out (KERNEL-430). */
  'scripts.skipSetup': { req: { workspaceId: string }; res: Ok }
  /** Pushes the workspace's script output, exit codes and URLs as one `script.state`, for a window that wasn't there to see them (KERNEL-340). */
  'scripts.replay': { req: { workspaceId: string }; res: Ok }

  // activity, usage and account (KERNEL-21, 25, 28)
  'activity.recent': { req: { roomId?: string; limit?: number }; res: ActivityEvent[] }
  'usage.get': { req: void; res: RateLimit[] }
  /** "Notify me" on a limit banner: one notification when the limit resets. */
  'usage.notifyOnReset': { req: { type: RateLimit['type'] }; res: Ok }
  'account.get': { req: void; res: ClaudeAccount }
  /** Opens a terminal running `claude /login`, then reports the new account. */
  'account.signIn': { req: void; res: ClaudeAccount }
  'account.signOut': { req: void; res: ClaudeAccount }

  // providers and accounts (KERNEL-406). Subscription logins only: there is no API key option (D-018).
  /** The status table on Settings, Providers: version, executable, login method, plan and email, read through Kernel's own binary. */
  'providers.status': { req: { provider: Provider }; res: ProviderStatus }
  /** The executable path field and "Use system Claude" / "Use system Codex" / "Use bundled". An empty path clears the override. */
  'providers.setPath': { req: { provider: Provider; path?: string; useSystem?: boolean }; res: ProviderStatus }
  /** Run login: the provider's own sign-in for the active account, in the browser. */
  'providers.signIn': { req: { provider: Provider }; res: ProviderStatus }
  /** Opens the CLI's own config file: Claude Code's user settings, or Codex's config.toml. */
  'providers.openConfig': { req: { provider: Provider }; res: Ok }
  /** Every account of both providers, the CLI's own logins first. */
  'accounts.list': { req: void; res: AccountProfile[] }
  /**
   * Add account. Claude runs `claude setup-token` and keeps the token it prints; Codex signs in with ChatGPT in the account's
   * own home. Progress arrives as `account.add` push events. Resolves with the new account once it is signed in.
   */
  'accounts.add': { req: { provider: Provider; label?: string; plan?: Exclude<ClaudePlan, 'unknown'> }; res: AccountProfile }
  /** The code the sign-in page shows, when `claude setup-token` asks for one (an `account.add` step of `code`). */
  'accounts.code': { req: { provider: Provider; code: string }; res: Ok }
  /** Closes the Add account sheet: stops the sign-in that is running. */
  'accounts.cancelAdd': { req: { provider: Provider }; res: Ok }
  /** Use: the account runs the provider's next turns. A running turn finishes on the account it started on. */
  'accounts.switch': { req: { provider: Provider; accountId: string }; res: AccountProfile[] }
  /** Sign out of an account. The CLI's own login signs the CLI out; an added account forgets its credential. */
  'accounts.signOut': { req: { provider: Provider; accountId: string }; res: AccountProfile[] }
  /** Removes an added account and its credential. The CLI's own login can't be removed. */
  'accounts.remove': { req: { provider: Provider; accountId: string }; res: AccountProfile[] }
  /** A provider's models with their efforts: Claude's from MODELS, Codex's from `model/list`, read once per launch. */
  'models.list': { req: { provider: Provider }; res: ProviderModel[] }

  // settings (KERNEL-25, 26)
  'settings.get': { req: void; res: AppSettings }
  'settings.set': { req: { patch: DeepPartial<AppSettings> }; res: AppSettings }
  'settings.room': { req: { roomId: string }; res: RoomSettings }
  /** Writes .kernel/settings.local.toml unless `shared` is set, then .kernel/settings.toml. A `null` removes that key from the file, which is "Use default". */
  'settings.setRoom': { req: { roomId: string; patch: RoomSettingsPatch; shared?: boolean }; res: RoomSettings }
  /** Files to copy: exactly what a new worktree would get, sorted by path. Without `patterns` it reads the room's saved list (KERNEL-245). */
  'files.preview': { req: { roomId: string; patterns?: string[] }; res: FileToCopy[] }
  // environment variables (KERNEL-247). Without `roomId` it is the app's, which has no env files. Values only leave
  // main through `env.reveal`.
  'env.get': { req: { roomId?: string }; res: { names: string[]; files: { path: string; missing: boolean }[] } }
  /** A `null` value deletes the variable. Throws for a bad name, one of Kernel's own, or when values can't be encrypted. */
  'env.set': { req: { roomId?: string; name: string; value: string | null }; res: Ok }
  'env.reveal': { req: { roomId?: string; name: string }; res: string }
  /**
   * The room's MCP servers for one provider, Claude's when `provider` is unset, with the last status Kernel heard. `probe`
   * waits for a fresh check of Claude's servers. Without it, the first list for a room starts one (KERNEL-464).
   */
  'mcp.list': { req: { roomId?: string; provider?: Provider; probe?: boolean }; res: McpServer[] }
  'integrations.list': { req: void; res: Integration[] }
  /** Linear takes a `token` (an empty one disconnects). GitHub signs in through `gh`, so it only reports its status. */
  'integrations.connect': { req: { id: Integration['id']; token?: string }; res: Integration }

  // app (KERNEL-25, 30)
  'update.get': { req: void; res: AppUpdate }
  'update.check': { req: void; res: AppUpdate }
  /**
   * Restart into the downloaded version. With agents working Kernel asks first, and `canceled` says the user chose
   * Cancel, so Kernel keeps running (KERNEL-214). Without it Kernel is quitting.
   */
  'update.install': { req: void; res: Ok & { canceled?: true } }
  /** Writes the activity log to a file in the data folder and returns where (Settings > About). */
  'app.exportLogs': { req: void; res: { path: string } }
  /**
   * What Settings > About shows: Kernel's version and where its data lives. `telemetry` says whether this build can send
   * usage data at all (KERNEL-397); a dev build or one without a key can't.
   */
  'app.info': { req: void; res: { version: string; dataDir: string; telemetry: boolean } }
  /** A terminal window in a folder, optionally running a command (Open terminal, Sign in). */
  'app.openTerminal': { req: { cwd: string; command?: string }; res: Ok }
  /**
   * The apps on this Mac the Open in menu lists, in Kernel's order: Finder, editors, terminals (KERNEL-427). `defaultId` is the
   * last one picked while it is still installed, else the first editor, else Finder.
   */
  'app.openApps': { req: void; res: { apps: OpenApp[]; defaultId?: string } }
  /**
   * Opens a path inside a room or workspace in one of `app.openApps`, which becomes the default. Without `app`, the default
   * editor opens it, or Finder shows it when there is none. Terminals and Finder get the folder, never the file.
   */
  'app.openIn': { req: { path: string; app?: string }; res: Ok }
  /** "Try again" on the offline banner: check the network now. Main also pushes `online` when it changes. */
  'app.checkOnline': { req: void; res: { online: boolean } }

  // usage data (KERNEL-397)
  /** The latest events, newest first, and whether each went out: Settings, Privacy's "See what's sent". */
  'telemetry.recent': { req: void; res: TelemetryRecord[] }
  /** The renderer's own events: the answer in Room setup's team review. Main checks each before keeping it. */
  'telemetry.track': { req: { event: TelemetryEvent }; res: Ok }

  // shared files (KERNEL-302)
  /** Files agents shared, newest first: a room's (the Lead's panel) or one workspace's. */
  'shared.list': { req: { roomId?: string; workspaceId?: string; limit?: number }; res: SharedFile[] }
  /** One version's contents: Markdown and HTML as text, images and PDFs as a data URL. */
  'shared.read': { req: { sharedId: string; version: number }; res: { kind: SharedKind; mime: string; text?: string; dataUrl?: string } }
  /** The version's thumbnail as a data URL, or null when none was captured. */
  'shared.thumb': { req: { sharedId: string; version: number }; res: string | null }
  /** Show in Finder: the source file while it still matches that version, else Kernel's copy. */
  'shared.reveal': { req: { sharedId: string; version: number }; res: Ok }
  /** Open in Preview: Kernel's copy of a PDF version in the Mac's default PDF app. Refused for any other kind, which Kernel never hands to the system to open. */
  'shared.open': { req: { sharedId: string; version: number }; res: Ok }

  // comments on shared files (KERNEL-310)
  /**
   * Sends a comment to the agent that shared the file, as a plain message naming the file, version and spot, with `image`
   * (the crop around it) attached. Goes to the version's chat, else the workspace's first open chat, else a new one.
   * `queued` and `why` say a busy chat or setup holds it. Refused for an archived workspace and for PDFs.
   */
  'shared.comment': {
    req: { sharedId: string; version: number; note: string; anchor: SharedAnchor; image?: { dataUrl: string; width: number; height: number } }
    res: { chatId: string; workspaceId: string; queued: boolean; why?: QueueReason }
  }
  /** Every comment on a shared file, every version, oldest first. */
  'shared.comments': { req: { sharedId: string }; res: SharedComment[] }

  // handled in src/main/index.ts, not by the kernel
  'system.pickFolder': { req: void; res: string | null }
  /** An open dialog limited to PNG and JPEG, for a room icon. Null when cancelled. */
  'system.pickImage': { req: void; res: string | null }
  'system.openExternal': { req: { url: string }; res: Ok }
  'system.openInEditor': { req: { path: string }; res: Ok }
  /** Fixture mode only (KERNEL_FIXTURES). The UI to force and push events to replay. Null in a real run. */
  'system.fixture': { req: void; res: { ui: ForcedUi; push: PushEvent[] } | null }

  // live previews of shared HTML (KERNEL-303). Each is a locked-down native view main draws over the tab. `preview`
  // events report its state and `preview.key` carries app shortcuts typed inside it.
  /**
   * The view for a tab, made or reused by `key` (workspace and file). Another version reloads the same view. `viewId` is
   * null when there is no live view: fixture mode, and every kind but HTML. `still` is the last capture, if any.
   */
  'system.preview.open': { req: { sharedId: string; version: number; key: string }; res: { viewId: string | null; still?: string | null } }
  /** Puts the view over `rect`, in the page's CSS pixels. Null hides it. A view main has since closed is ignored; open it again. */
  'system.preview.place': { req: { viewId: string; rect: { x: number; y: number; width: number; height: number } | null }; res: Ok }
  /** A JPEG data URL of the view as it is now, shown while it is hidden. Null when the view is gone. */
  'system.preview.still': { req: { viewId: string }; res: string | null }
  'system.preview.reload': { req: { viewId: string }; res: Ok }
  'system.preview.focus': { req: { viewId: string }; res: Ok }
  'system.preview.close': { req: { viewId: string }; res: Ok }

  // pinning comments in a preview (KERNEL-310). Each runs in a world the page's own scripts can't see. Points and rects
  // in a request or in `locate`'s answer are Kernel's CSS pixels from the view's top-left corner, as `place` takes them.
  /**
   * The element under a point: its selector, tag, text and rect, with the window it sits in. The anchor is in the page's own
   * CSS pixels, which the comment's message names. Null when the view is gone.
   */
  'system.preview.hit': { req: { viewId: string; x: number; y: number }; res: SharedAnchor | null }
  /** A PNG of the view around `rect`, padded by 24 px, from 320x200 to 1200x800. Null when the view is gone. */
  'system.preview.crop': { req: { viewId: string; rect: { x: number; y: number; width: number; height: number } }; res: { dataUrl: string; width: number; height: number } | null }
  /** Scrolls the page by `dx`, `dy`, or to `y`, in the page's pixels. Returns where it ended up, null when the view is gone. */
  'system.preview.scroll': { req: { viewId: string; dx?: number; dy?: number; y?: number }; res: { scrollY: number } | null }
  /** Where each selector's element is now, null for one that matches nothing. Places pins again after a scroll or reload. */
  'system.preview.locate': { req: { viewId: string; selectors: string[] }; res: ({ x: number; y: number; width: number; height: number } | null)[] }
}

/**
 * Channels whose types are settled before anything answers them (KERNEL-432). The ticket that builds one moves it into
 * KernelApi with its handler, so no window can call it, and no NotImplemented stub is needed, until then.
 */
export interface PlannedApi {
  /** Whether each provider can run Auto and Bypass permissions now, for Settings, Permissions, the composer and onboarding. */
  'permissions.availability': { req: void; res: Record<Provider, ModeAvailability> }
}

export type Channel = keyof KernelApi

/** Pushed from main to renderer on 'kernel:event'. */
export type PushEvent =
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'chat'; chat: Chat }
  /** A Lead chat was created, renamed, retitled or closed (KERNEL-337). */
  | { type: 'thread'; thread: Thread }
  | { type: 'chat.item'; chatId: string; item: ChatItem }
  /** /clear started a fresh conversation, so the transcript starts over. */
  | { type: 'chat.cleared'; chatId: string }
  | { type: 'chat.running'; chatId: string; running: boolean }
  /**
   * The chat's queue, or what it waits for, changed. `why` is set while the queue holds messages and something holds them,
   * and is absent once it is empty (KERNEL-271).
   */
  | { type: 'chat.queue'; chatId: string; queue: QueuedMessage[]; why?: QueueReason }
  /**
   * Output from a terminal. With `replace` it is everything main kept, which takes the place of what the window has. A replay
   * goes out on this same stream, after every chunk it already holds and before the next one (KERNEL-340).
   */
  /** A terminal's output from the last 50 ms as one string, so `pnpm install` is about 20 pushes a second (KERNEL-216). */
  | { type: 'terminal.data'; chatId: string; data: string; replace?: true }
  | { type: 'approval'; approval: Approval }
  | { type: 'room'; room: Room }
  | { type: 'room.setup'; roomId: string; steps: RoomSetupStep[] }
  /** The room's scripts wait for the user to trust them. Null once they are trusted (KERNEL-209). */
  | { type: 'room.trust'; roomId: string; trust: ScriptTrust | null }
  | { type: 'overlap'; overlap: Overlap }
  | { type: 'agents'; roomId: string; agents: AgentDef[] }
  /** A room's MCP servers for one provider, after a probe or a session reported a status that changed them (KERNEL-464). */
  | { type: 'mcp'; roomId: string; provider: Provider; servers: McpServer[] }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'agent.status'; roomId: string; agentId: string; status: AgentStatus; activity?: string }
  /** `name` is set for run scripts, so each keeps its own output and exit (KERNEL-244). */
  /** A script's lines from the last 50 ms, in order, so a chatty script is about 20 pushes a second (KERNEL-216). */
  | { type: 'script.output'; workspaceId: string; kind: ScriptKind; name?: string; lines: Pick<ScriptLine, 'line' | 'stream'>[] }
  | { type: 'script.exit'; workspaceId: string; kind: ScriptKind; name?: string; code: number | null }
  /** The first local URL a run script printed, and null when it starts or exits (KERNEL-246). */
  | { type: 'script.url'; workspaceId: string; name: string; url: string | null }
  /**
   * Everything main kept of a workspace's scripts, in place of what the window has: the lines, each script's exit code by
   * `scriptKey` (absent while it runs), and each running run script's URL by name. Sent on the push stream like the lines
   * themselves, so none is shown twice or missed (KERNEL-340).
   */
  | { type: 'script.state'; workspaceId: string; lines: ScriptLine[]; exit: Record<string, number | null>; url: Record<string, string> }
  | { type: 'checkpoint'; checkpoint: Checkpoint }
  | { type: 'task'; task: Task }
  | { type: 'notification'; notification: Notification }
  /** Inbox rows main deleted: an archived workspace's rows, or settled rows past their week (D-137). */
  | { type: 'notification.removed'; ids: string[] }
  | { type: 'usage'; limits: RateLimit[] }
  | { type: 'pr'; workspaceId: string; state: PrState }
  | { type: 'pr.info'; info: PrInfo }
  /** A ready PR GitHub started blocking (`blocked` set) or stopped blocking, while its state stayed ready (KERNEL-401). */
  | { type: 'pr.blocked'; workspaceId: string; blocked?: PrBlocked }
  /** A room's Merge all run moved on to its next PR, or ended (no `queue`) with its `result` (KERNEL-411). */
  | { type: 'pr.queue'; roomId: string; queue?: MergeQueue; result?: MergeAllResult }
  | { type: 'github'; status: GitHubStatus }
  | { type: 'hooks'; status: HookStatus }
  | { type: 'update'; update: AppUpdate }
  | { type: 'account'; account: ClaudeAccount }
  /** Accounts changed: one added, removed, signed out or switched to (KERNEL-406). */
  | { type: 'accounts'; accounts: AccountProfile[] }
  /** Where Add account is, for its sheet (KERNEL-406). */
  | { type: 'account.add'; add: AccountAddStep }
  /** Network reachability as main sees it (WorkspaceOffline.png). */
  | { type: 'online'; online: boolean }
  /** Claude is overloaded and the session is retrying (WorkspaceOverloaded.png). Null when it recovers. */
  | { type: 'retry'; chatId: string; retry: Retry | null }
  /** A file was shared, or got a new version (KERNEL-302). */
  | { type: 'shared'; file: SharedFile }
  /**
   * A preview view's state (KERNEL-303). `settled` comes 300 ms after input, a finished load or a move, when a fresh
   * still is worth taking.
   */
  | { type: 'preview'; viewId: string; state: 'loading' | 'ready' | 'settled' | 'crashed' | 'unresponsive' }
  /** An app shortcut typed inside a preview, or F6 (code `F6`), which only asks the tab to focus its frame. Main has moved focus back to the app, which runs the shortcut. */
  | { type: 'preview.key'; key: string; code: string; meta: boolean; shift: boolean; alt: boolean; ctrl: boolean }
  /** A comment on a shared file was stored (KERNEL-310). */
  | { type: 'shared.comment'; comment: SharedComment }
  /** A toast from main, for news no other event carries: the window reloaded after a crash, or diagnostics were copied (KERNEL-288). */
  | { type: 'toast'; toast: Omit<Toast, 'id'> }

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
