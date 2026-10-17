import type { AccountProfile, MoveNotice, Provider, ProviderModel, ProviderStatus,
  ActivityEvent, AgentDef, AgentStatus, AppSettings, AppUpdate, Approval, BranchCommit, ChangedFile, Chat, ChatItem, Checkpoint, CheckpointPreview, ClaudeAccount, DeletePreview,
  FileEntry, FileToCopy, FolderInfo, ForcedUi, GitHubStatus, GithubIssueDetail, HookStatus, Hunk, IssueSummary, IssueTaken, PrSummary, Notification, OpenItem, Overlap, PreflightCheck, PrInfo, ProductionHint, PushCheck, QueuedMessage, RateLimit, GitHubOwner, RepoSummary, Project, ProjectSettings, ProjectTracker, SharedAnchor, SharedComment, SharedFile,
  Integration, LinearIssueDetail, ResolvedPath, LinearScope, McpAccount, McpServer, ScriptSuggestion, Skill, Task, TerminalPreset, Thread, Workspace, WorkspaceGitStatus
} from '@shared/types'
import type { Channel, PushEvent } from '@shared/ipc'
import type { TelemetryRecord } from '@shared/telemetry'

/** What `pnpm shots <Screen> --motion` does: a click on a button by its accessible name, key presses in Playwright's names (`Meta+Shift+Enter`), or `hold`, which hovers a button and keeps the mouse down on it. `push` is no click: main pushes these events, as when a turn ends by itself (KERNEL-895). */
export type MotionAction = { click: string } | { press: string[] } | { hold: string } | { push: PushEvent[] }

/** Everything one screen needs. `KERNEL_FIXTURES=<key>` serves it in place of the kernel. */
export interface Fixture {
  projects: Project[]
  /** By project id. */
  agents: Record<string, AgentDef[]>
  /** By project id, then agent id. */
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
  /** By project id. */
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
  /** Who a new GitHub repo can belong to (KERNEL-944). Signed in as cjjutba when unset. */
  githubOwners?: GitHubOwner[]
  /** owner/repo names Repository name says are taken (KERNEL-944). */
  takenRepos?: string[]
  /** Owner avatars as data URLs, by login, for `github.avatar` (KERNEL-951). An owner left out has none, so it shows its initials. */
  avatars?: Record<string, string>
  /** Recent project folders (OpenFolder.png). */
  folders?: FolderInfo[]
  /** By chat id. */
  queue?: Record<string, QueuedMessage[]>
  /** By workspace id. */
  /** What a path mentioned in chat resolves to, by workspace id, then the text as the agent wrote it (`src/a.ts:12-14`). Checked before the tree, for lines, ambiguous names and folders. */
  mentions?: Record<string, Record<string, ResolvedPath>>
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
  /** By project id, the tracker `issues.tracker` reports. A project without one reads as Linear, which every Issues and New workspace fixture drew before KERNEL-471. */
  trackers?: Record<string, ProjectTracker>
  /** By project id, the open issues of a GitHub project, each with the description and comments the Issues pane reads (KERNEL-471). */
  githubIssues?: Record<string, GithubIssueDetail[]>
  settings?: AppSettings
  /** When set, `preflight.fix` fails with this message, so a shot can show a fix that did not work (SetupPortBusyFixFailed, KERNEL-865). */
  preflightFixError?: string
  /** Channels whose calls never answer, so a screenshot can show the wait (IssuesLoading, KERNEL-759). */
  hold?: string[]
  /**
   * By project id. `sources` is optional: a fixture without it reads as every value coming from the app default. So is
   * `runScripts`: without it the project has `run` alone, when `scripts.run` is set. And `preview`, which reads as no URLs,
   * and `env`, which reads as no env files.
   */
  projectSettings?: Record<string, Omit<ProjectSettings, 'sources' | 'runScripts' | 'preview' | 'env' | 'references'> & Partial<Pick<ProjectSettings, 'sources' | 'runScripts' | 'preview' | 'env' | 'references'>>>
  /** By project id, what `scripts.suggest` returns. None when unset (KERNEL-682). */
  scriptSuggestions?: Record<string, ScriptSuggestion[]>
  /**
   * Variables by name only, never values: `app` for the app's, `projects` by project id. A project's `files` are its env files
   * with whether each is missing (KERNEL-247).
   */
  env?: { app?: string[]; projects?: Record<string, { names?: string[]; files?: { path: string; missing: boolean }[] }> }
  /** The CLIs `terminal.presets` lists as found on the PATH, after the built-ins and before the custom ones. None when unset (KERNEL-248). */
  terminalClis?: TerminalPreset[]
  /** By project id, the data URL `projects.icon` returns for a project with an icon. */
  projectIcons?: Record<string, string>
  /** By project id, what `projects.pushCheck` returns (KERNEL-460). A project left out has no remote. */
  pushChecks?: Record<string, PushCheck>
  /** By project id, the ignored files in the project's main checkout. `files.preview` picks from them with the project's Files to copy. */
  localFiles?: Record<string, FileToCopy[]>
  /** By project id, what `files.production` answers: the files to copy that look like production (KERNEL-449). */
  production?: Record<string, ProductionHint[]>
  account?: ClaudeAccount
  /** Both providers' accounts (Settings, Providers, the account menu, KERNEL-406). */
  accounts?: AccountProfile[]
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
  /** Files agents shared (KERNEL-302). `shared.list` filters them by project or workspace. */
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
  /** Remembered choices to start with, by storage key (remember.ts), so a screen can open on a choice a person made (KERNEL-1003). */
  saved?: Record<string, string>
  /** `pnpm shots <Screen> --motion` runs `action` and captures frames for `ms`. `area` is a selector to crop to, else the whole window (KERNEL-831). */
  motion?: { action: MotionAction; ms: number; area?: string }
  /** Channels that reject with this text, so a screen can show a failed load (KERNEL-869). */
  fails?: Partial<Record<Channel, string>>
  /** Channels that answer after this many milliseconds, so a motion can catch a call in flight (KERNEL-869). */
  lag?: Partial<Record<Channel, number>>
  /** Events `chats.send` pushes after the given delays, so a `motion` that clicks Send can step a running turn through more calls. */
  afterSend?: { afterMs: number; events: PushEvent[] }[]
  /**
   * Events a call pushes after it answers, by channel, after the given delays: a fixture's stand-in for main reacting to the call. In them `$id` is the id the window gave
   * the message (`clientId`, or `id` for Send now), `$parts` its parts and `$now` the time, so main's row replaces the window's by id as it does for real (KERNEL-895).
   */
  after?: Partial<Record<Channel, { afterMs: number; events: PushEvent[] }[]>>
  /** Events `projects.retrySetup` pushes after the given delays, so a `motion` that clicks Try again can step a setup through its steps. */
  afterRetry?: { afterMs: number; events: PushEvent[] }[]
  /**
   * Replayed once the renderer has booted, for state that only arrives as events (running chats, script output). A run
   * script that prints a local URL here gets its `script.url` too, as in the engine (KERNEL-246).
   */
  push: PushEvent[]
}
