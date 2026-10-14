import type { ChatPart, Effort } from './chats'
import type { NewAgentPrefill, NewRoomPrefill } from './rooms'
import type { RoomSettingsSection, SettingsPage, Theme } from './settings'
import type { MovePreview, Provider } from './chats'
import type { AppUpdate } from './system'
import type { LeadMode, WorkspaceMode, WorkspaceSource } from './workspaces'

/**
 * `loading` is LoadingApp.png: the app shell while the main process boots or reconnects. `permissions` comes after `checks`
 * and picks the permission mode. Nothing opens it until its screen is built (KERNEL-432).
 */
export type OnboardingStep = 'welcome' | 'checks' | 'permissions' | 'room' | 'loading'

/** Where the renderer is. Lives here so fixtures can open any screen. One entry per screen family. */
export type DevUiPage = 'components' | 'display' | 'overlays' | 'dialogs'

export type Route =
  | { name: 'onboarding'; step: OnboardingStep; roomId?: string }
  | { name: 'home' } | { name: 'inbox' } | { name: 'history' } | { name: 'rooms' }
  | { name: 'workspace'; workspaceId: string }
  /**
   * New chat, the page every entry point opens (KERNEL-788). No workspace exists until the first message (KERNEL-405). `source` is what the
   * chat starts from, which the box shows as a chip, and `picks` is what the box had chosen when the issue warning sent it back (KERNEL-500).
   */
  | { name: 'leadNew'; roomId: string; source?: WorkspaceSource; picks?: NewChatPicks }
  /** Linear issues. `issueId` is the identifier of the open issue. */
  /** `roomId` is the room whose tracker the screen lists. Without it the screen opens on the room used last (KERNEL-471). */
  | { name: 'issues'; issueId?: string; roomId?: string }
  /** `section` is for `page: 'room'`, and none means General. */
  /** `tab` puts that provider's accounts in view on Settings, Accounts (KERNEL-406). */
  /** `account` is the id of the account Skills and MCP puts first in view (KERNEL-627). */
  /**
   * `agentId` opens that agent's editor inside the Agents page it came from: `page: 'agents'` for the app's list, or `page: 'room'`
   * with `section: 'agents'` and a `roomId` for a room's (KERNEL-641).
   */
  /** `row` is the id of the setting's row to scroll to, highlight and focus once the page is open (KERNEL-727). */
  | { name: 'settings'; page: SettingsPage; roomId?: string; section?: RoomSettingsSection; tab?: Provider; account?: string; agentId?: string; row?: string }
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
  /** Hand off or Build here, when picked in the box. Left out while it follows the room or Settings. */
  leadMode?: LeadMode
}

/** A New chat the issue check held back (KERNEL-500). Start anyway sends `parts` to the room's Lead, and Cancel reopens New chat on `source` with `picks`. */
export interface HeldChat {
  roomId: string
  source: WorkspaceSource
  parts: ChatPart[]
  picks: NewChatPicks
}

export type ConfirmKind = 'archive' | 'discard' | 'removeRoom' | 'retire' | 'trust'

/** The one modal shell's contents. At most one modal is open. */
export type Modal =
  | null
  | { name: 'search' }
  | { name: 'newRoom'; prefill?: NewRoomPrefill }
  | { name: 'connectRepo' } | { name: 'openFolder' } | { name: 'checkHooks' }
  | { name: 'newAgent'; roomId?: string; step: 'describe' | 'draft' | 'done'; prefill?: NewAgentPrefill }
  /** `update` is the install What's new opened with, which later update pushes must not replace (KERNEL-30). */
  | { name: 'whatsNew'; update?: AppUpdate }
  /** The add and edit form on an Environment page. No `roomId` is the app's page, and `editName` is the variable being edited (KERNEL-254). */
  | { name: 'envVar'; roomId?: string; editName?: string }
  | { name: 'confirm'; kind: 'archive'; workspaceId: string }
  | { name: 'confirm'; kind: 'discard'; workspaceId: string }
  /** Revert files to a checkpoint from the transcript. `start` says it is the chat's first (KERNEL-766). */
  | { name: 'confirm'; kind: 'revert'; workspaceId: string; checkpointId: string; start?: boolean }
  | { name: 'confirm'; kind: 'removeRoom'; roomId: string }
  /** History > Delete: archived workspaces, with their branches, checkpoints and transcripts (KERNEL-333). */
  | { name: 'confirm'; kind: 'deleteHistory'; workspaceIds: string[] }
  | { name: 'confirm'; kind: 'retire'; roomId: string; agentId: string }
  /** Run this repo's scripts? The room's scripts and files.copy list waiting in `scriptTrust` (KERNEL-218). */
  | { name: 'confirm'; kind: 'trust'; roomId: string }
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
   * The first switch into Bypass permissions, asked once (KERNEL-455). `roomId` is the room whose mode override is being set,
   * and none means the app's mode in Settings, Permissions. `chatId` is a chat that picked Bypass permissions in its composer: only
   * that chat's own mode is set, and Settings stays as it is (KERNEL-456).
   */
  | { name: 'confirm'; kind: 'bypass'; roomId?: string; chatId?: string; /** New chat's box, whose draft keeps the pick until the chat starts. */ draftKey?: string }
  /** The one-time question about usage data, after the first room (KERNEL-397). */
  | { name: 'telemetryAsk' }
  /** A switch that would make long chats read their history again on `accountId`: what it costs, and whether to keep them or move them (KERNEL-845). `reason` is the banner's. */
  | { name: 'confirm'; kind: 'switchAccount'; provider: Provider; accountId: string; preview: MovePreview; reason?: 'banner' }
  /** Set up this account: the checklist of the MCP servers that need the user on one account (KERNEL-661). */
  | { name: 'mcpSetUp'; provider: Provider; accountId: string }

/**
 * Menus and popovers. One is open at a time. `room:<id>` is a sidebar room's menu, and `reply:<id>` the "..." menu under a reply.
  */
export type MenuId =
  | 'rooms' | `room:${string}` | 'account' | 'plan'
  | 'pr' | 'tab' | 'newTab' | `reply:${string}`
  | 'plus' | 'model' | 'mode' | 'mention' | 'slash' | 'linkIssue' | 'linkPr' | 'linkWorkspaces'
  | 'branch' | 'from' | 'settingsFiles' | 'roomIcon' | 'roomMode' | 'preview'
  | 'roomTracker' | 'help'

/** Failure banners (DESIGN.md Patterns). The banner component reads the facts it shows from the store. */
export type BannerKind = 'limit' | 'context' | 'offline' | 'auth' | 'setup' | 'hooks' | 'retry' | 'trust'

export interface Banner {
  kind: BannerKind
  roomId?: string
  workspaceId?: string
  chatId?: string
}

/** Bottom-right toast, auto-dismissed after 5s (WorkspaceToast.png). */
export interface Toast {
  id: string
  title: string
  sub?: string
  /** `href` opens in the browser. `tab` opens that tab of the workspace in the app (KERNEL-311: Open chat after a comment is sent). `route` goes to that screen (KERNEL-627). `modal` opens it (KERNEL-661). `switchAccount` switches that provider to that account, as Undo does after a switch (KERNEL-699). */
  action?: { label: string; href?: string; tab?: { workspaceId: string; id: string }; route?: Route; modal?: Exclude<Modal, null>; switchAccount?: { provider: Provider; accountId: string } }
}

/** The workspace screen's panes, so fixtures can open any of them. */
export interface WorkspaceView {
  /** The right panel's tab. `prs` is the Lead's own, so a teammate's workspace shows Changes in its place (KERNEL-354). */
  right: 'prs' | 'files' | 'changes' | 'checks' | 'shared'
  /** The tab the Lead's workspace shows. The store starts it at `prs` and sets it back on entering a workspace, as it does `right` to `changes`; a fixture can leave it out. */
  leadRight?: 'prs' | 'files' | 'changes' | 'checks' | 'shared'
  bottom: 'setup' | 'run' | 'terminal'
  /** Tool call groups shown expanded (WorkspaceToolCalls.png). */
  toolsOpen: boolean
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
  /** Why the app could not start. Set when `boot` fails, so Loading shows the error and Try again instead of "Starting Kernel" forever (KERNEL-217). */
  startError?: string
}

/** UI state a fixture forces on boot. */
export type ForcedUi = Partial<UiState>
