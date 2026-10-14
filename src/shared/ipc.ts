import type {
  AccountAddStep, AccountProfile, ActivityEvent, AgentChangePr, AgentDef, AgentDraft, AgentEdit, AgentScope, AgentStatus, AppSettings, AppUpdate, Approval, BranchCommit, BuiltinCommand, ChangedFile, Chat, ChatItem, ChatRunMode,
  ChatPart, Checkpoint, ClaudeAccount, CompareTarget, Decision, DeepPartial, DeletePreview, DeleteResult, Effort, FileEntry, FileToCopy, FolderInfo, ForcedUi, GitHubStatus, HookStatus, Hunk,
  GithubIssue, GithubIssueDetail, Integration, IssueSummary, IssueTaken, JiraAccount, JiraFilter, JiraIssue, JiraTransition, LinearFilter, LinearIssue, LinearIssueDetail, LinearScope, McpAccount, McpConnect, McpNeeded, McpServer, McpSignInAll, McpSignInStep, ModeAvailability, NewRoomRequest, Notification, OpenApp, OpenItem, Overlap, PreflightCheck, PushCheck, MergeAllResult, MergeQueue, PrBlocked, PrInfo, PrPending, PrState,
  PermissionMode, PrSummary, ProductionHint, Provider, ProviderModel, ProviderStatus, QueuedMessage, QueueReason, RateLimit, RepoSummary, ReviewPatch, Room, RoomSettings, RoomSettingsPatch, RoomSetupStep, RoomTracker, ScriptKind, ScriptLine, ScriptSuggestion, ScriptTrust, ChatArchivePreview, SharedAnchor, SwitchReason, SharedComment, SharedFile, SharedKind, Skill, Task, TeamTemplate, TerminalPreset, Thread,
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
  /** CheckHooksOff "Turn hooks on": takes disableAllHooks out of Claude Code's user settings, after the first backup (KERNEL-461). */
  'hooks.turnOn': { req: void; res: HookStatus }

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
  /** Send a brief to the room's Lead, or a message to one agent. `parts` is the message in order when it has chips inline; `text` is its plain words. */
  'rooms.brief': { req: { roomId: string; text: string; parts?: ChatPart[]; agentId?: string }; res: { chatId: string; workspaceId: string } }
  'rooms.overlaps': { req: { roomId: string }; res: Overlap[] }
  /** By agent id, the time of each agent's newest event in the room, read from the whole log. */
  'rooms.lastActivity': { req: { roomId: string }; res: Record<string, number> }
  /** "Let Kernel sort it": the Lead decides which worktree keeps the change. */
  'rooms.resolveOverlap': { req: { overlapId: string }; res: Ok }
  /** What the room's scripts and files.copy list wait on, or null when there is nothing to trust (KERNEL-209). */
  'rooms.scriptTrust': { req: { roomId: string }; res: ScriptTrust | null }
  /** Trust the text behind `hash` and release the room's workspaces held in `trust`. Rejects when the text changed since. */
  'rooms.trust': { req: { roomId: string; hash: string }; res: Ok }
  /**
   * Whether git can push from the room's checkout (KERNEL-460): the last result, or a new one when there is none or `recheck`
   * is set. Null when the room has no remote. A recheck also updates the room's Check push access step while setup shows.
   */
  'rooms.pushCheck': { req: { roomId: string; recheck?: boolean }; res: PushCheck | null }
  'rooms.inspectFolder': { req: { path: string }; res: FolderInfo }
  'rooms.recentFolders': { req: void; res: FolderInfo[] }
  'github.repos': { req: { query?: string }; res: RepoSummary[] }

  // agents (KERNEL-19, 22)
  'agents.list': { req: { roomId: string; retired?: boolean }; res: AgentDef[] }
  'agents.status': { req: { roomId: string }; res: Record<string, AgentStatus> }
  /**
   * AgentProfile > Save changes. `scope` says who gets the change (KERNEL-466): `me`, the default, keeps it on this Mac, and
   * `team` opens a pull request that changes the file, returned as `pr`, and the agent stays as it is until that merges.
   */
  'agents.save': { req: { roomId: string; agentId: string; patch: AgentEdit; scope?: AgentScope }; res: AgentDef & { pr?: AgentChangePr } }
  /** New agent > Describe: write a draft file from a description. Settings, Agents with no room leaves `roomId` out. */
  'agents.draft': { req: { roomId?: string; description: string; name?: string; model?: string }; res: AgentDraft }
  /**
   * New agent > Create agent. `me`, the default, saves the file in ~/.claude/agents. `team` opens a pull request that adds it
   * (KERNEL-466), so it needs `roomId`. Settings, Agents with no room leaves `roomId` out and creates only for `me`.
   */
  'agents.create': { req: { roomId?: string; draft: AgentDraft; scope?: AgentScope }; res: AgentDef & { pr?: AgentChangePr } }
  /**
   * The agent leaves the team on this Mac now, and its open workspaces go to `handoffTo`, or the Lead. `me`, the default,
   * leaves the file as it is. `team` also opens a pull request that moves it to .claude/retired-agents (D-003, KERNEL-466).
   */
  'agents.retire': { req: { roomId: string; agentId: string; handoffTo?: string; scope?: AgentScope }; res: Ok & { pr?: AgentChangePr } }
  /**
   * Brings back an agent retired on this Mac. A file in .claude/retired-agents comes back to ~/.claude/agents for `me`, the
   * default, or in a pull request that moves it back for `team` (KERNEL-466).
   */
  'agents.restore': { req: { roomId: string; agentId: string; scope?: AgentScope }; res: AgentDef & { pr?: AgentChangePr } }
  /** An empty room's team: add a starter team from a template. */
  'agents.seed': { req: { roomId: string; template: TeamTemplate }; res: AgentDef[] }
  /**
   * Who leads, who reviews and who takes tasks: writes the `[team]` table in the shared .kernel/settings.toml and returns
   * the team as Kernel now resolves it (KERNEL-397). `from` says which screen asked.
   */
  'agents.setTeam': { req: { roomId: string; team: TeamPatch; from?: 'setup' | 'settings' }; res: AgentDef[] }
  /** Copies Kernel's own Lead or reviewer into .claude/agents so the user can edit it, and returns the new file's agent. */
  'agents.customize': { req: { roomId: string; agentId: string }; res: AgentDef }
  /** Deletes .claude/agents/kernel.md, so the room's Lead is Kernel as it ships again, and returns the team (KERNEL-692). */
  'agents.resetLead': { req: { roomId: string }; res: AgentDef[] }
  /**
   * Renames the file that customizes Kernel (an older Lead file, or the one `[team] lead` names) to .claude/agents/kernel.md,
   * keeping its content, and clears `[team] lead` when it named that file. Returns the team (KERNEL-741).
   */
  'agents.moveLead': { req: { roomId: string }; res: AgentDef[] }
  /** Team > Add a starter agent: copies one of Kernel's starter files into .claude/agents. Refuses one the team already has. */
  'agents.addStarter': { req: { roomId: string; id: string }; res: AgentDef }
  /**
   * Settings, Agents with no room: the agents that join every room, the user's own in ~/.claude/agents then plugin agents, each
   * with `origin` set and flagged like a room flags a file Kernel can't read (KERNEL-640).
   */
  'agents.listGlobal': { req: Record<string, never>; res: AgentDef[] }
  /** Rewrites a personal agent's file in ~/.claude/agents, and every open room picks the change up. Refuses a plugin agent (KERNEL-640). */
  'agents.saveGlobal': { req: { agentId: string; patch: AgentEdit }; res: AgentDef }

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
  /** `target` is what the Changes ⋯ menu compares with (KERNEL-516). Left out, or `base`, the files and the saved totals are as before. */
  'workspaces.changes': { req: { workspaceId: string; target?: CompareTarget }; res: ChangedFile[] }
  'workspaces.diff': { req: { workspaceId: string; file?: string; target?: CompareTarget }; res: string }
  /** The commits on the workspace's branch since its base, newest first, as `git log <base>..HEAD` lists them (PanelCompare, KERNEL-516). */
  'workspaces.commits': { req: { workspaceId: string }; res: BranchCommit[] }
  /** The Target branch picker (KERNEL-516): the workspace's base, then `<remote>/<default>`, then the room's other branches newest first. Never the workspace's own branch. */
  'workspaces.compareBranches': { req: { workspaceId: string }; res: string[] }
  'workspaces.tree': { req: { workspaceId: string }; res: FileEntry[] }
  /** @ mentions: files matching the query, best first. */
  'workspaces.files': { req: { workspaceId: string; query: string; limit?: number }; res: FileEntry[] }
  'workspaces.readFile': { req: { workspaceId: string; path: string }; res: string }
  /**
   * An image for the diff tab, as a data URL: `worktree` reads the file on disk, `base` the version the diff compares against.
   * Null when the file isn't there (KERNEL-409). With a `commit` target, `worktree` is the file in that commit (KERNEL-516).
   */
  'workspaces.readImage': { req: { workspaceId: string; path: string; at: 'worktree' | 'base'; target?: CompareTarget }; res: { dataUrl: string } | null }
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
   * Up next in New chat: the room tracker's issues nobody has started, the most pressing first. Linear lists its Todo
   * issues by priority; a tracker with no such order lists its open issues as `issues.list` does.
   */
  'issues.next': { req: { roomId: string }; res: IssueSummary[] }
  /**
   * Before New workspace starts on an issue: a branch on the remote, an open PR or another assignee that says someone else may
   * be on it (ConfirmIssueTaken.png, KERNEL-479). A check that can't answer adds a note instead of holding the start up.
   */
  'issues.taken': { req: { roomId: string; issue: string }; res: IssueTaken }
  /** The room's issue tracker, which the Issues screen, the From popover and Link issue read to know whose issues to list (KERNEL-471). */
  'issues.tracker': { req: { roomId: string }; res: RoomTracker }
  /** The room's open GitHub issues with the fields the Issues screen shows, up to 100, through gh. */
  'github.issueList': { req: { roomId: string; query?: string }; res: GithubIssue[] }
  /** One GitHub issue by key (`#41`), with its description and comments. */
  'github.issue': { req: { roomId: string; id: string }; res: GithubIssueDetail }

  // Linear issues (KERNEL-159)
  /** Open issues, newest first, up to 100. */
  'linear.issues': { req: { filter: LinearFilter }; res: LinearIssue[] }
  /** One issue by identifier, with its description and comments. */
  'linear.issue': { req: { id: string }; res: LinearIssueDetail }
  'linear.scope': { req: void; res: LinearScope }
  /** Plan with Kernel: a fresh Lead chat in plan mode, briefed with the issue. */
  'linear.plan': { req: { id: string; roomId: string }; res: { chatId: string; workspaceId: string } }

  // Jira issues (KERNEL-474)
  /** Checks the account with Jira, then saves it encrypted. An empty token disconnects and returns null. */
  'jira.connect': { req: { site: string; email: string; token: string }; res: JiraAccount | null }
  /** The saved account as Jira reads it now, or null when none is saved. Rejects with Jira's reason when it refuses. */
  'jira.test': { req: void; res: JiraAccount | null }
  /** The room's open Jira issues, last updated first, up to 100, from its `[jira] project` when it names one. */
  'jira.issues': { req: { roomId: string; filter: JiraFilter }; res: JiraIssue[] }
  /** The transitions Jira offers `issue`, else the room's latest To Do issue. Empty when the room has none. */
  'jira.transitions': { req: { roomId: string; issue?: string }; res: JiraTransition[] }
  /** Saves the room's `[jira] transition`, in the personal file unless `shared`. `null` removes it, so no issue moves. */
  'jira.saveTransition': { req: { roomId: string; transition: string | null; shared?: boolean }; res: RoomSettings }

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
  /**
   * The chat is on screen: clears `unreadAt` and pushes the chat. A chat that is already read stays as it is, with no push.
   * The renderer calls it whenever the chat it shows has `unreadAt` (KERNEL-507).
   */
  'chats.markRead': { req: { chatId: string }; res: Ok }
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
  /** The permission mode the chat runs in, the mode picked for it and why they differ. `chat.runMode` events carry each change (KERNEL-572). */
  'chats.runMode': { req: { chatId: string }; res: ChatRunMode }
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

  // tasks (KERNEL-18)
  'tasks.list': { req: { roomId: string }; res: Task[] }

  // home and inbox (KERNEL-17)
  'notifications.list': { req: void; res: Notification[] }
  'notifications.read': { req: { ids: string[] | 'all' }; res: Notification[] }
  /** Settings, Notifications, Play: shows one macOS banner with the sound, so the user hears it (KERNEL-680). */
  'notifications.playSound': { req: { sound: AppSettings['notifications']['sound'] }; res: Ok }
  /**
   * The workspace of the room's newest open Lead chat, for the sidebar row, Cmd+K and Cmd+Shift+L. Null when no chat
   * is open: it never starts one (KERNEL-405).
   */
  'lead.open': { req: { roomId: string }; res: Workspace | null }
  /**
   * The new workspace modal: the prompt goes to the Lead in a new chat, which takes its title from the first message (KERNEL-148). The
   * chat gets its own worktree, on a branch from `baseRef` or the latest default branch (KERNEL-405). It answers once the chat, its
   * tab and its workspace are saved, before the fetch and the worktree, which the workspace's `worktreePending` covers. The prompt
   * waits in the tab's queue until the worktree exists, then for setup when Wait for setup says so (KERNEL-542).
   */
  'lead.start': { req: { roomId: string; prompt: string; parts?: ChatPart[]; provider?: Provider; model?: string; effort?: Effort; plan?: boolean; baseRef?: string }; res: Chat }
  /**
   * Starts a fetch of the room's remote and answers without waiting for it, so the fetch Create needs is done or under way by
   * then. New chat calls it when it opens. A failed fetch says nothing (KERNEL-542).
   */
  'lead.prefetch': { req: { roomId: string }; res: Ok }
  /** The Lead chats, each holding one or more Lead tabs, in every room or in `roomId`, oldest first (KERNEL-337). */
  'threads.list': { req: { roomId?: string }; res: Thread[] }
  /** Names a Lead chat. Kernel stops naming it after its first tab from then on. */
  'threads.rename': { req: { threadId: string; title: string }; res: Thread }
  /** What archiving a Lead chat would stop, per workspace, its own last (KERNEL-405). */
  'threads.archivePreview': { req: { threadId: string }; res: ChatArchivePreview }
  /** Archives a Lead chat: the workspaces it handed off, unless Settings says otherwise, then its own (KERNEL-405). */
  'threads.archive': { req: { threadId: string }; res: Ok }
  /** What the Lead chat still owes its teammates or the user: questions, blockers, proposed hand-offs, mentions, oldest first (KERNEL-749). */
  'openItems.list': { req: { threadId: string }; res: OpenItem[] }
  /** The user closes an open item, so the Lead is no longer reminded of it (KERNEL-749). */
  'openItems.dismiss': { req: { id: string }; res: Ok }

  // pull requests (KERNEL-15)
  'pr.get': { req: { workspaceId: string }; res: PrInfo | null }
  'pr.create': { req: { workspaceId: string; draft?: boolean }; res: Workspace }
  'pr.refresh': { req: { workspaceId: string }; res: Workspace }
  /** `override` is a person's Merge anyway past a reviewer's blockers. The Lead and Merge all never send it (KERNEL-497). */
  'pr.merge': { req: { workspaceId: string; override?: boolean }; res: Workspace }
  /**
   * Overrules the reviews' blockers on the PR's head commit, so Merge goes ahead without Merge anyway until a new commit
   * (KERNEL-732). Refused when nothing blocks. `clear` takes the overrule back (Undo).
   */
  'reviews.overrule': { req: { workspaceId: string; note?: string; clear?: boolean }; res: Workspace }
  /** Merges the room's ready PRs one at a time, in the order given, and stops at the first that can't merge (KERNEL-411). */
  'pr.mergeAll': { req: { roomId: string; workspaceIds: string[] }; res: MergeAllResult }
  /** One button for conflicts, failing checks and review comments. Sends the matching instructions to the agent. */
  'pr.resolve': { req: { workspaceId: string }; res: Ok }
  /** Update branch: asks the agent to rebase a local branch that fell behind its base onto it (KERNEL-478). */
  'pr.update': { req: { workspaceId: string }; res: Ok }
  'pr.ready': { req: { workspaceId: string }; res: Workspace }
  'pr.reopen': { req: { workspaceId: string }; res: Workspace }
  /** After a merge or close: keep going on a fresh branch from the base, same chat. */
  'pr.continue': { req: { workspaceId: string }; res: Workspace }
  /** The PR action running on each workspace, by workspace id, for a window that loads while one runs (KERNEL-519). */
  'pr.pendingAll': { req: {}; res: Record<string, PrPending> }

  // scripts
  /** `name` picks a run script. Without one it is `run`, the default (KERNEL-244). */
  'scripts.run': { req: { workspaceId: string; kind: ScriptKind; name?: string }; res: Ok }
  /** Stops the named run script, or every run script in the workspace without a name. */
  'scripts.stop': { req: { workspaceId: string; kind: 'run' | 'setup'; name?: string }; res: Ok }
  /** Send anyway: a failed setup is skipped and the messages waiting for it go out (KERNEL-430). */
  'scripts.skipSetup': { req: { workspaceId: string }; res: Ok }
  /** Pushes the workspace's script output, exit codes and URLs as one `script.state`, for a window that wasn't there to see them (KERNEL-340). */
  'scripts.replay': { req: { workspaceId: string }; res: Ok }
  /** Resizes a running script's terminal. The next run of the same script starts at this size, and at `SCRIPT_COLS` by `SCRIPT_ROWS` before any (KERNEL-655). */
  'scripts.resize': { req: { workspaceId: string; kind: ScriptKind; name?: string; cols: number; rows: number }; res: Ok }

  /** The scripts the room could take from Conductor, Superset or its lockfiles, without the ones it already runs. Reads only, and `settings.setRoom` saves one (KERNEL-682). */
  'scripts.suggest': { req: { roomId: string }; res: ScriptSuggestion[] }
  /** Ask Kernel: a new Lead chat in the room that reads the repo and proposes its scripts with set_room_scripts. Main writes the message, so the renderer sends none (KERNEL-683). */
  'scripts.askLead': { req: { roomId: string }; res: Chat }

  // activity, usage and account (KERNEL-21, 25, 28)
  'activity.recent': { req: { roomId?: string; limit?: number }; res: ActivityEvent[] }
  /**
   * The usage windows Kernel has, at once, since the window waits on it at launch. It also starts a read of every
   * subscription account on both providers that Kernel didn't read in the last minute, and what that finds arrives as
   * `usage` and `accounts` pushes. The account menu and Settings, Providers ask when they open (KERNEL-567).
   * With `force`, the footer's refresh button: it reads every signed-in account again, whatever it read in the last minute,
   * and answers once that is done.
   */
  'usage.get': { req: { force?: boolean } | void; res: RateLimit[] }
  /** "Notify me" on a limit banner: one notification when the window of `provider`'s account in use resets. Claude's by default. */
  'usage.notifyOnReset': { req: { type: RateLimit['type']; provider?: Provider }; res: Ok }
  'account.get': { req: void; res: ClaudeAccount }
  /** Opens a terminal running `claude /login`, then reports the new account. */
  'account.signIn': { req: void; res: ClaudeAccount }
  'account.signOut': { req: void; res: ClaudeAccount }

  // providers and accounts (KERNEL-406). Subscription logins, and API key accounts the user adds (KERNEL-523, amends D-018).
  /** The status table on Settings, Providers: version, executable, login method, plan and email, read through Kernel's own binary. */
  'providers.status': { req: { provider: Provider }; res: ProviderStatus }
  /** The executable path field and "Use system Claude" / "Use system Codex" / "Use bundled". An empty path clears the override. */
  'providers.setPath': { req: { provider: Provider; path?: string; useSystem?: boolean }; res: ProviderStatus }
  /**
   * Run login, or Sign in again on an account's row: the provider's own sign-in in the browser, for `accountId` or else the
   * active account. A legacy token account signs in fully and keeps its id and nickname (KERNEL-567).
   */
  'providers.signIn': { req: { provider: Provider; accountId?: string }; res: ProviderStatus }
  /** Opens the CLI's own config file: Claude Code's user settings, or Codex's config.toml. */
  'providers.openConfig': { req: { provider: Provider }; res: Ok }
  /** Every account of both providers, the CLI's own logins first. */
  'accounts.list': { req: void; res: AccountProfile[] }
  /**
   * Add account. Claude runs `claude auth login` in a folder of the account's own, and Codex signs in with ChatGPT in a home
   * of its own. Its email and plan are read from the account, and its email is its name until it is renamed (KERNEL-567).
   * Progress arrives as `account.add` push events. Resolves with the new account once it is signed in. A login that is
   * already the CLI's own or an added account's is refused with "That account is already in Kernel." (KERNEL-616).
   */
  'accounts.add': { req: { provider: Provider }; res: AccountProfile }
  /**
   * Adds an API key account with the name given (KERNEL-523). Kernel checks the key with one request to Anthropic or
   * OpenAI, keeps it encrypted, and rejects with a plain reason when it doesn't work. Like any added account, it isn't used
   * until the user switches to it. With `accountId` instead of a name, the key replaces that key account's key, which signs
   * it in again.
   */
  'accounts.addKey': { req: { provider: Provider; label: string; key: string } | { provider: Provider; accountId: string; key: string }; res: AccountProfile }
  /** The code the sign-in page shows, for `claude auth login`'s prompt (an `account.add` step of `code`). */
  'accounts.code': { req: { provider: Provider; code: string }; res: Ok }
  /**
   * Closes the Add account sheet: stops the sign-in that is running, an MCP server's (`accounts.mcpSignIn`) included, and
   * the provider's Sign in to all (`accounts.mcpSignInAll`).
   */
  'accounts.cancelAdd': { req: { provider: Provider }; res: Ok }
  /**
   * Use: the account runs the provider's next turns. A running turn finishes on the account it started on. `reason` is
   * `banner` from the limit banner's Switch to, which leaves the account in use at its limit, and `user` by default (KERNEL-568).
   * The new account's row carries `missingModels` when agents start on a model it doesn't offer, and the Inbox says so (KERNEL-616).
   */
  'accounts.switch': { req: { provider: Provider; accountId: string; reason?: Exclude<SwitchReason, 'limit'> }; res: AccountProfile[] }
  /**
   * Sign out of an account. The CLI's own login signs the CLI out. An added login signs out of its own folder or home, and
   * a token or key account forgets its credential. Every other account stays signed in.
   */
  'accounts.signOut': { req: { provider: Provider; accountId: string }; res: AccountProfile[] }
  /**
   * Rename: the account's nickname, the CLI's own login's included, kept in `accounts.json`. An empty label goes back to
   * its email (KERNEL-567).
   */
  'accounts.rename': { req: { provider: Provider; accountId: string; label: string }; res: AccountProfile[] }
  /**
   * Removes an added account: it signs out, and its credential and its folder or home go. A Claude account's folder goes
   * without following its links into `~/.claude`. The CLI's own login can't be removed.
   */
  'accounts.remove': { req: { provider: Provider; accountId: string }; res: AccountProfile[] }
  /**
   * Which MCP servers need a sign-in on a Claude account, `cli` for the CLI's own login: Claude Code starts on the account
   * in the home folder, lists its servers and stops, sending no message. It shares the user-added servers' sign-ins first,
   * so what is left is a claude.ai connector or a server no account has signed in to. The answer lands on the account's
   * `mcpSignIns` (KERNEL-616).
   */
  'accounts.checkMcp': { req: { provider: 'claude'; accountId: string }; res: AccountProfile[] }
  /**
   * Signs one MCP server in on an account. Claude: `claude mcp login <server>` in the account's folder, which opens the
   * browser, and the server leaves the account's `mcpSignIns` unless it is a claude.ai connector, which the user finishes on
   * claude.ai (KERNEL-616). Codex: Codex's own MCP OAuth login in the account's home, whose page Kernel opens (KERNEL-646).
   * A user-added server's sign-in then reaches every account of the provider. Progress arrives as `account.mcpSignIn`
   * pushes, and `accounts.cancelAdd` stops it. Resolves once the sign-in finishes.
   */
  'accounts.mcpSignIn': { req: { provider: Provider; accountId: string; server: string }; res: AccountProfile[] }
  /**
   * Sign in to all: signs in every MCP server that needs a sign-in on an account, one after another, through
   * `accounts.mcpSignIn`. Servers ignored there or switched off in every room are skipped. It checks the account first when
   * `mcp.accounts` hasn't. Progress arrives as `account.mcpSignInAll` pushes, with each server's own steps as
   * `account.mcpSignIn`. A failed sign-in moves on to the next server. `accounts.cancelAdd` stops the queue. Resolves when it
   * ends, with what was signed in and what failed (KERNEL-626, Codex since KERNEL-646).
   */
  'accounts.mcpSignInAll': { req: { provider: Provider; accountId: string }; res: McpSignInAll }
  /**
   * Ignore, or stop ignoring, one MCP server on one account, kept in `accounts.json` across restarts. An ignored server reads
   * `ignored` in `mcp.accounts` and doesn't count toward the account's row warning (`mcpSignIns`), the notice after adding an
   * account or Sign in to all. Resolves with `mcp.accounts`, also pushed (KERNEL-646).
   */
  'accounts.mcpIgnore': { req: { provider: Provider; accountId: string; server: string; ignored: boolean }; res: McpAccount[] }
  /**
   * Set up this account (KERNEL-660): takes every server that needs the user on the account (`McpAccount.needsYou`), ticked
   * ones in `include`. The rest are ignored there in one write. The ticked ones are worked through in order: a sign-in runs
   * through `accounts.mcpSignIn`, one after another, and the claude.ai connectors not set up there go as one
   * `account.mcpConnect` push, at the first one's turn. A failed or not-set-up server Kernel can't fix waits for the re-check.
   * Progress arrives as `account.mcpSignInAll` pushes, `accounts.cancelAdd` stops it, and a failed sign-in moves on and is
   * listed at the end, as in Sign in to all.
   */
  'accounts.mcpSetUp': { req: { provider: Provider; accountId: string; include: string[] }; res: McpSignInAll }
  /** A provider's models with their efforts: Claude's from MODELS, Codex's from `model/list`, read once per launch. */
  'models.list': { req: { provider: Provider }; res: ProviderModel[] }

  // settings (KERNEL-25, 26)
  'settings.get': { req: void; res: AppSettings }
  'settings.set': { req: { patch: DeepPartial<AppSettings> }; res: AppSettings }
  'settings.room': { req: { roomId: string }; res: RoomSettings }
  /** Writes .kernel/settings.local.toml unless `shared` is set, then .kernel/settings.toml. A `null` removes that key from the file, which is "Use default". */
  'settings.setRoom': { req: { roomId: string; patch: RoomSettingsPatch; shared?: boolean }; res: RoomSettings }
  /**
   * Writes `[review]` in the shared .kernel/settings.toml, the rest of the file as it was written (KERNEL-549). A `null` removes
   * that key, so its default applies again.
   */
  'settings.setReview': { req: { roomId: string; review: ReviewPatch }; res: RoomSettings }
  /**
   * Writes `[merge] always_review` in the shared .kernel/settings.toml, the rest of the file as it was written (KERNEL-594).
   * `paths` is the whole list: an empty one removes the key. They add to Kernel's own list, never replace it.
   */
  'settings.setAlwaysReview': { req: { roomId: string; paths: string[] }; res: RoomSettings }
  /**
   * Whether each provider can run Auto and Bypass permissions now, for Settings, Permissions, the composer and onboarding
   * (KERNEL-447). Reads admin policy and asks Claude Code which models run Auto, so the first call can take a few seconds.
   */
  'permissions.availability': { req: void; res: Record<Provider, ModeAvailability> }
  /** Files to copy: exactly what a new worktree would get, sorted by path. Without `patterns` it reads the room's saved list (KERNEL-245). */
  'files.preview': { req: { roomId: string; patterns?: string[] }; res: FileToCopy[] }
  /**
   * The files to copy that look like production, one hint per file, without the ones the room chose Keep copying for. Names
   * only, never values (KERNEL-449).
   */
  'files.production': { req: { roomId: string }; res: ProductionHint[] }
  /** Keep copying: the room stops warning about these files until another variable in them looks like production (KERNEL-449). */
  'files.keepCopying': { req: { roomId: string; hints: ProductionHint[] }; res: Room }
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
  /**
   * Every signed-in subscription account of both providers with each MCP server's state on it (KERNEL-626): every server
   * any account of the provider has, on each of its accounts, in one of five states (KERNEL-646). Kernel keeps
   * what it last found: only an account it hasn't checked yet is checked, and the call waits for it. `refresh` checks again,
   * every account or only `provider`'s, or only `accountId`. A Claude check starts Claude Code on the account and stops it,
   * as `accounts.checkMcp` does. A Codex check lists the servers in the account's home. Changes arrive as `mcp.accounts`.
   */
  'mcp.accounts': { req: { refresh?: boolean; provider?: Provider; accountId?: string } | void; res: McpAccount[] }
  /**
   * Re-check on return (KERNEL-660): the renderer calls it when Kernel's window gets focus. Checks again only the accounts
   * with something pending (`needsYou`, or a check that failed), at most once every 10 seconds, and resolves with
   * `mcp.accounts` as it reads then. Changes arrive as `mcp.accounts` too. Kernel also re-checks an account after each sign-in.
   */
  'mcp.recheck': { req: void; res: McpAccount[] }
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
   * What `chats.runMode` answers for the chat changed: the chat, its room, Settings, Permissions, what its provider can run,
   * its agent file, or the end of the turn Bypass permissions waited for. Sent for chats with no process too (KERNEL-572).
   */
  | { type: 'chat.runMode'; chatId: string; mode: ChatRunMode }
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
  /**
   * A room's .kernel/settings.toml or settings.local.toml changed on disk outside Kernel: by hand, from Open settings.toml or a
   * git pull. `settings` is what `settings.room` reads now. Kernel's own saves and a file that stops parsing send none (KERNEL-723).
   */
  | { type: 'settings.roomChanged'; roomId: string; settings: RoomSettings }
  | { type: 'overlap'; overlap: Overlap }
  | { type: 'agents'; roomId: string; agents: AgentDef[] }
  /** The agents that join every room, as `agents.listGlobal` returns them, after ~/.claude/agents or the plugin list changed (KERNEL-640). */
  | { type: 'globalAgents'; agents: AgentDef[] }
  /** A room's MCP servers for one provider, after a probe or a session reported a status that changed them (KERNEL-464). */
  | { type: 'mcp'; roomId: string; provider: Provider; servers: McpServer[] }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'agent.status'; roomId: string; agentId: string; status: AgentStatus }
  /** `name` is set for run scripts, so each keeps its own output and exit (KERNEL-244). */
  /** A script's lines from the last 50 ms, in order, so a chatty script is about 20 pushes a second (KERNEL-216). */
  | { type: 'script.output'; workspaceId: string; kind: ScriptKind; name?: string; lines: Pick<ScriptLine, 'line' | 'stream'>[] }
  /**
   * A script's terminal output from the last 50 ms, as it printed it: colors, `\r` redraws and all, for a terminal view.
   * `script.output` carries the same output as plain lines (KERNEL-655).
   */
  | { type: 'script.data'; workspaceId: string; kind: ScriptKind; name?: string; data: string }
  | { type: 'script.exit'; workspaceId: string; kind: ScriptKind; name?: string; code: number | null }
  /** The first local URL a run script printed, and null when it starts or exits (KERNEL-246). */
  | { type: 'script.url'; workspaceId: string; name: string; url: string | null }
  /**
   * Everything main kept of a workspace's scripts, in place of what the window has: the lines, each script's exit code by
   * `scriptKey` (absent while it runs), each running run script's URL by name, and each script's terminal output by
   * `scriptKey`, its last `TERMINAL_KEEP` characters (KERNEL-655). Sent on the push stream like the lines themselves, so
   * none is shown twice or missed (KERNEL-340).
   */
  | { type: 'script.state'; workspaceId: string; lines: ScriptLine[]; exit: Record<string, number | null>; url: Record<string, string>; data: Record<string, string> }
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
  /** A PR action started on the workspace, from any button or tool, or ended (no `action`) after its last `pr` push (KERNEL-519). */
  | { type: 'pr.pending'; workspaceId: string; action?: PrPending }
  | { type: 'github'; status: GitHubStatus }
  | { type: 'hooks'; status: HookStatus }
  | { type: 'update'; update: AppUpdate }
  | { type: 'account'; account: ClaudeAccount }
  /** Accounts changed: one added, removed, signed out or switched to (KERNEL-406). */
  | { type: 'accounts'; accounts: AccountProfile[] }
  /**
   * The provider's account in use changed, from `from` to `to` (account ids, `cli` for the CLI's own login), and `reason`
   * says who switched. `limit` is the window the old account hit, on a switch from the limit banner or by Kernel at a limit
   * (KERNEL-694). Never sent when the account stayed the same.
   */
  | { type: 'accountSwitched'; provider: Provider; from: string; to: string; reason: SwitchReason; limit?: RateLimit['type'] }
  /** Where Add account is, for its sheet (KERNEL-406). */
  | { type: 'account.add'; add: AccountAddStep }
  /** Where a sign-in to an MCP server on an account is (`accounts.mcpSignIn`, KERNEL-616). */
  | { type: 'account.mcpSignIn'; signIn: McpSignInStep }
  /** Where Sign in to all on an account is (`accounts.mcpSignInAll`, KERNEL-626). */
  | { type: 'account.mcpSignInAll'; run: McpSignInAll }
  /** MCP servers need a sign-in on an account just added, after its first check. Once per account (KERNEL-626). */
  | { type: 'account.mcpNeeded'; needed: McpNeeded }
  /** Set up this account's claude.ai connectors in one step: open claude.ai once for all of them (`accounts.mcpSetUp`, KERNEL-660). */
  | { type: 'account.mcpConnect'; connect: McpConnect }
  /** What `mcp.accounts` knows changed: an account was checked, or a sign-in finished (KERNEL-626). */
  | { type: 'mcp.accounts'; accounts: McpAccount[] }
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
