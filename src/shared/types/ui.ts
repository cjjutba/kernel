import type { ChatPart, Effort } from './chats'
import type { NewAgentPrefill, NewProjectPrefill } from './projects'
import type { ProjectSettingsSection, SettingsPage, Theme } from './settings'
import type { Provider } from './chats'
import type { AppUpdate } from './system'
import type { LeadMode, WorkspaceMode, WorkspaceSource } from './workspaces'

/**
 * `loading` is LoadingApp.png: the app shell while the main process boots or reconnects. `splash` is the wordmark a fresh install
 * sees before New chat (KERNEL-942). The checks run behind it and show inside the app, so there is no checks or permissions step.
 */
export type OnboardingStep = 'splash' | 'project' | 'loading' | 'checks' | 'accounts' | 'team' | 'loop'

/** Where the renderer is. Lives here so fixtures can open any screen. One entry per screen family. */
export type DevUiPage = 'components' | 'display' | 'states' | 'overlays' | 'dialogs'

export type Route =
  | { name: 'onboarding'; step: OnboardingStep; projectId?: string }
  | { name: 'inbox' } |
  /** Archived workspaces. `projectId` lists one project's, from the project's menu in the sidebar. */
  { name: 'history'; projectId?: string } | { name: 'projects' }
  | { name: 'workspace'; workspaceId: string }
  /**
   * New chat, the page every entry point opens (KERNEL-788). No workspace exists until the first message (KERNEL-405). `source` is what the
   * chat starts from, which the box shows as a chip, and `picks` is what the box had chosen when the issue warning sent it back (KERNEL-500).
   */
  | { name: 'leadNew'; projectId: string; source?: WorkspaceSource; picks?: NewChatPicks }
  /** Linear issues. `issueId` is the identifier of the open issue. */
  /**
   * `projectId` is the project whose tracker the screen lists. Without it the screen opens on the project used last (KERNEL-471).
   * `tracker` opens that tracker's list. Without it an `issueId` starting with `#` opens GitHub, else the project's saved choice (KERNEL-938).
   */
  | { name: 'issues'; issueId?: string; projectId?: string; tracker?: 'linear' | 'github' }
  /** Pull requests across every project. `filter` is the list it opens on, Open when unset. */
  | { name: 'prs'; filter?: 'open' | 'merged' }
  /** `section` is for `page: 'project'`, and none means General. */
  /** `tab` puts that provider's accounts in view on Settings, Accounts (KERNEL-406). */
  /** `account` is the id of the account Skills and MCP puts first in view (KERNEL-627). */
  /**
   * `agentId` opens that agent's editor inside the Agents page it came from: `page: 'agents'` for the app's list, or `page: 'project'`
   * with `section: 'agents'` and a `projectId` for a project's (KERNEL-641).
   */
  /** `row` is the id of the setting's row to scroll to, highlight and focus once the page is open (KERNEL-727). */
  | { name: 'settings'; page: SettingsPage; projectId?: string; section?: ProjectSettingsSection; tab?: Provider; account?: string; agentId?: string; row?: string }
  /** The component gallery (KERNEL-9). Dev builds open it from `#/dev/ui/<page>`; fixtures can force it for shots. */
  | { name: 'devUi'; page: DevUiPage }

/** What New chat had picked besides its words, so that Cancel on the issue warning brings the box back as it was (KERNEL-500). */
export interface NewChatPicks {
  mode: WorkspaceMode
  model: string
  effort: Effort
  plan: boolean
  /** The target branch picked, empty for the default. */
  baseRef: string
  /** Hand off or Build here, when picked in the box. Left out while it follows the project or Settings. */
  leadMode?: LeadMode
}

/** A New chat the issue check held back (KERNEL-500). Start anyway sends `parts` to the project's Lead, and Cancel reopens New chat on `source` with `picks`. */
export interface HeldChat {
  projectId: string
  source: WorkspaceSource
  parts: ChatPart[]
  picks: NewChatPicks
}

/** The one modal shell's contents. At most one modal is open. */
export type Modal =
  | null
  | { name: 'search' }
  | { name: 'newProject'; prefill?: NewProjectPrefill }
  | { name: 'connectRepo' } | { name: 'openFolder' } | { name: 'checkHooks' }
  /** A project's setup log, opened from Details on New chat (KERNEL-1117). */
  | { name: 'setupLog'; projectId: string }
  | { name: 'newAgent'; projectId?: string; step: 'describe' | 'draft' | 'done'; prefill?: NewAgentPrefill }
  /** `update` is the install What's new opened with, which later update pushes must not replace (KERNEL-30). */
  | { name: 'whatsNew'; update?: AppUpdate }
  /** The add and edit form on an Environment page. No `projectId` is the app's page, and `editName` is the variable being edited (KERNEL-254). */
  | { name: 'envVar'; projectId?: string; editName?: string }
  | { name: 'confirm'; kind: 'archive'; workspaceId: string }
  | { name: 'confirm'; kind: 'discard'; workspaceId: string }
  /** Merge a pull request past the blockers its review found on the latest commit (Pen 10.2, KERNEL-1097). */
  | { name: 'confirm'; kind: 'mergeAnyway'; workspaceId: string }
  /** Revert files to a checkpoint from the transcript. `start` says it is the chat's first (KERNEL-766). */
  | { name: 'confirm'; kind: 'revert'; workspaceId: string; checkpointId: string; start?: boolean }
  | { name: 'confirm'; kind: 'removeProject'; projectId: string }
  /** History > Delete: archived workspaces, with their branches, checkpoints and transcripts (KERNEL-333). */
  | { name: 'confirm'; kind: 'deleteHistory'; workspaceIds: string[] }
  | { name: 'confirm'; kind: 'retire'; projectId: string; agentId: string }
  /** Archiving a Lead chat that would stop something: its row's Archive, or closing its last tab (KERNEL-405). */
  | { name: 'confirm'; kind: 'archiveChat'; threadId: string }
  /** Closing chats that are still running: the X on a chat tab, Close tab, Close other tabs or Cmd+W. */
  | { name: 'confirm'; kind: 'closeChats'; workspaceId: string; chatIds: string[] }
  /**
   * Someone else may already be on the issue a workspace is about to start from: what Kernel found, in the order to show it
   * (ConfirmIssueTaken.png, KERNEL-471). The findings have the shape of KERNEL-479's `IssueTakenFinding`. New chat opens it
   * with the chat it held back in `held` (KERNEL-500).
   */
  | { name: 'confirm'; kind: 'issueTaken'; issue: string; findings: ({ kind: 'branch'; ref: string } | { kind: 'pr'; number: number; title: string } | { kind: 'assignee'; name: string })[]; held: HeldChat }
  /**
   * The first switch into Bypass permissions, asked once (KERNEL-455). `projectId` is the project whose mode override is being set,
   * and none means the app's mode in Settings, Permissions. `chatId` is a chat that picked Bypass permissions in its composer: only
   * that chat's own mode is set, and Settings stays as it is (KERNEL-456).
   */
  | { name: 'confirm'; kind: 'bypass'; projectId?: string; chatId?: string; /** New chat's box, whose draft keeps the pick until the chat starts. */ draftKey?: string }
  /** The one-time question about usage data, after the first project (KERNEL-397). */
  | { name: 'telemetryAsk' }
  /** Set up this account: the checklist of the MCP servers that need the user on one account (KERNEL-661). */
  | { name: 'mcpSetUp'; provider: Provider; accountId: string }

/**
 * Menus and popovers. One is open at a time. `project:<id>` is a sidebar project's menu, and `reply:<id>` the "..." menu under a reply, and `step:<id>` the one at the end of a step's row (KERNEL-1094).
  */
export type MenuId =
  | 'projects' | `project:${string}` | 'account' | 'plan'
  | 'pr' | 'tab' | 'newTab' | `reply:${string}` | `step:${string}`
  | 'plus' | 'model' | 'effort' | 'mode' | 'mention' | 'slash' | 'linkIssue' | 'linkPr' | 'linkWorkspaces'
  | 'branch' | 'from' | 'settingsFiles' | 'projectIcon' | 'projectMode' | 'preview'
  | 'projectTracker' | 'help'
  /** Your team's menus, which a fixture opens so a shot can show them (KERNEL-1088). The app never sets them. */
  | 'obReviewer' | 'obMode' | 'obModel' | 'obAllowed' | 'obDenied'

/** Failure banners (DESIGN.md Patterns). The banner component reads the facts it shows from the store. */
export type BannerKind = 'limit' | 'context' | 'offline' | 'auth' | 'setup' | 'hooks' | 'retry'

export interface Banner {
  kind: BannerKind
  projectId?: string
  workspaceId?: string
  chatId?: string
}

/** What pressing a toast's button does. `href` opens in the browser. `tab` opens that tab of the workspace in the app (KERNEL-311: Open chat after a comment is sent). `route` goes to that screen (KERNEL-627). `modal` opens it (KERNEL-661). `switchAccount` switches that provider to that account, as Undo does after a switch (KERNEL-699). `primary` draws it filled, for the action that fixes what went wrong (Try again). */
export interface ToastAction { label: string; href?: string; tab?: { workspaceId: string; id: string }; route?: Route; modal?: Exclude<Modal, null>; switchAccount?: { provider: Provider; accountId: string }; /** Copies this text, such as the command that fixes a setup problem (KERNEL-1088). */ copy?: string; /** Runs the setup checks again (KERNEL-1088). */ recheck?: true; /** Runs a project's setup again, for a step that could not finish (KERNEL-1089). */ retrySetup?: string; /** Opens New chat's project menu, or Add a project when there is none (KERNEL-1090). */ pickProject?: true; /** Checks again whether git can push from a project's checkout, and updates its Check push access step (KERNEL-1089). */ recheckPush?: string; /** Sends a chat's last message again at once, for "Retry now" on the overloaded toast (KERNEL-1101). */ retryNow?: string; /** Reads the signed-in accounts again, for "Try again" on a signed-out toast (KERNEL-1101). */ recheckAccount?: true; /** Runs a workspace's setup script again, for "Rerun setup" on the toast for a setup run that didn't pass (KERNEL-1093). */ rerunSetup?: string; /** Opens a workspace's Setup tab in its bottom pane, to read the log (KERNEL-1093). */ openSetup?: string; /** Makes a new chat's worktree again and sends its message, for "Try again" when git couldn't (KERNEL-1093). */ retryWorktree?: string; /** Sends a Lead chat's held message from the shared folder instead, for "Send as Hand off" when its working copy couldn't be made (KERNEL-1093). */ sendAsHandoff?: string; /** Reads a list again. The key is the one the open screen registered with `onRetry`, such as `issues` or `prs`, and a screen that closed since leaves the button doing nothing (KERNEL-1098). */ retry?: string; /** Applies that check's one-click fix, such as moving the hook server to the next port, then checks again. */ fix?: 'shell' | 'claude' | 'auth' | 'git' | 'gh' | 'hooks' | 'codex'; primary?: boolean }

/** Bottom-right toast, auto-dismissed after 5s (Pen 18.1 and 18.3). */
export interface Toast {
  id: string
  title: string
  sub?: string
  /** A third, quieter line under the sub: what the toast is about, such as the chat's title (KERNEL-1093). */
  detail?: string
  /** The icon in front of the title (KERNEL-1109): `error` for a call that failed, `merged` for a PR that landed, `plug` for MCP servers that need a sign-in, `switch` for a model or an account that changed under a chat (KERNEL-1095), `done` for the rest. Left out, it is `error` when the title starts "Could not" or "Couldn't", `done` otherwise. */
  glyph?: 'done' | 'error' | 'merged' | 'plug' | 'switch'
  action?: ToastAction
  /** A second, quieter button that sits before `action` (Open Scripts beside Try again). */
  other?: ToastAction
}

/** The three ways a turn's folds behave. */
export type ToolCalls = 'auto' | 'closed' | 'open'

/** The right panel's tabs. Files, Changes, Review and Pull request are a workspace's own, `prs` is the Lead's list, and `preview` is the app's preview (KERNEL-1096). */
export type PanelTab = 'prs' | 'files' | 'changes' | 'review' | 'pr' | 'preview'

/** The workspace screen's panes, so fixtures can open any of them. */
export interface WorkspaceView {
  /** The right panel's tab. `prs` is the Lead's own, so a teammate's workspace shows Changes in its place (KERNEL-354). `review` and `pr` are the Review and Pull request tabs (KERNEL-1096). */
  right: PanelTab
  /** The tab the Lead's workspace shows. The store starts it at `prs` and sets it back on entering a workspace, as it does `right` to `changes`; a fixture can leave it out. */
  leadRight?: PanelTab
  bottom: 'setup' | 'run' | 'terminal'
  /** How a turn's folds start (Settings, Appearance, Tool calls). `auto` shows the steps while the turn works and folds them when it ends, `closed` starts every fold closed, `open` starts every fold open and never folds one. A fixture can leave it out for `auto`. */
  toolCalls?: ToolCalls
  /** The Changes tab as a flat list or a folder tree, like VS Code's Source Control (KERNEL-399). The store starts it at what was last picked; a fixture can leave it out. */
  changesView?: 'list' | 'tree'
  /** What the composer starts with. Fixtures force it so a shot can show chips and an open @ or / menu; the app never sets it. */
  composer?: { parts: ChatPart[]; draft: string }
  /** The composer's context popover is open. Fixtures force it for a shot; the app never sets it. */
  contextOpen?: boolean
}

/** One workspace's open tabs. They outlast the workspace screen, so Settings or another workspace never resets them. */
export interface WorkspaceTabs {
  /** Active tab: a chat id, `file:<path>` for a file preview, `diff:<path>` for a diff (empty path for all changes), `image:<n>` or `text:<n>`. */
  tab?: string
  /** The chat the composer is on while a file, diff, image or text tab is active. */
  lastChat?: string
  /** Paths of the open file tabs. */
  files: string[]
  /** Paths of the open diff tabs. An empty path is All changes. */
  diffs: string[]
  /** Ids of the open `shared:<id>` tabs (KERNEL-302). */
  shared?: string[]
  /** By shared id, the version a tab shows when it isn't the newest. */
  sharedVersion?: Record<string, number>
  /** Tab ids, the one selected last first, at most 20. Closing the open tab goes back to the first of these that is still open. */
  recent?: string[]
}

/** Whose bottom pane a flag is for: a Lead chat, or a teammate's workspace. */
export type BottomKind = 'lead' | 'teammate'

/** The footer's Usage popover: every account's windows, or one number per provider (KERNEL-674). */
export type UsageView = 'detailed' | 'compact'

export interface UiState {
  route: Route
  modal: Modal
  menu: MenuId | null
  toasts: Toast[]
  banner: Banner | null
  theme: Theme
  /** Fixtures only: how long the setup checks wait for the preflight call before saying it is taking longer. */
  preflightLimitMs?: number
  /** Nothing reads it since the briefing sequence went (KERNEL-606). store.ts's `setStage` still writes it, so it stays until that goes. */
  stage?: string
  workspace: WorkspaceView
  /** By workspace id. Each workspace keeps its own open tab, chat and file and diff tabs. */
  tabs: Record<string, WorkspaceTabs>
  /** Ids of the Lead chats folded by hand in the sidebar, which hides the workspaces they started. Only folded chats are listed; kept across launches. */
  foldedChats: string[]
  /** The left sidebar is showing. Its title bar toggle and Cmd+B hide it; kept across launches. */
  sidebar: boolean
  /** Whether Back and Forward have somewhere reachable to go. Kept in step with the history by store.ts, so the title bar buttons can follow it (KERNEL-643). */
  nav: { canBack: boolean; canForward: boolean }
  /** The screen's right panel is showing: a workspace's files and run panels. Cmd+Option+B; kept across launches. */
  rightPanel: boolean
  /**
   * The Session rail is wanted on the right while the right panel is closed. The title bar's two view toggles switch between them, and pressing the one that is on
   * leaves neither, which is Focus mode with the sidebar hidden (KERNEL-1096). Kept across launches.
   */
  rail: boolean
  /** Ids of the workspaces whose right panel stays closed whatever `rightPanel` says, until the toggle is pressed in that chat. A chat started from New chat is one (KERNEL-788). */
  panelHeld: string[]
  /** The right panel's bottom pane (Setup, Run, Terminal) as a fraction of the panel below its header. One size for every chat; kept across launches (KERNEL-513). */
  bottomRatio: number
  /** The bottom pane is folded to its tab bar. One flag for the Lead's chats and one for teammate workspaces, each kept across launches (KERNEL-513). */
  bottomCollapsed: Record<BottomKind, boolean>
  /** The Usage popover's view, kept across launches (KERNEL-674). */
  usageView: UsageView
  /** The providers whose rows are expanded in the Usage popover. Detailed starts with Claude Code open, Compact with none, and switching view resets it. */
  usageOpen: Provider[]
  /** The account switch in progress, from `requestSwitch` until `accounts.switch` and a fresh `usage.get` have both answered (KERNEL-986). Null when none runs. */
  switching?: { provider: Provider; accountId: string } | null
  /** Why the app could not start. Set when `boot` fails, so Loading shows the error and Try again instead of "Starting Kernel" forever (KERNEL-217). */
  startError?: string
}

/** UI state a fixture forces on boot. */
export type ForcedUi = Partial<UiState>
