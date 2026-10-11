import type { ChatPart } from './chats'
import type { NewAgentPrefill, NewRoomPrefill } from './rooms'
import type { RoomSettingsSection, SettingsPage, Theme } from './settings'
import type { AppUpdate } from './system'
import type { WorkspaceSource } from './workspaces'

/** `loading` is LoadingApp.png: the app shell while the main process boots or reconnects. */
export type OnboardingStep = 'welcome' | 'checks' | 'room' | 'loading'

/** Where the renderer is. Lives here so fixtures can open any screen. One entry per screen family. */
export type DevUiPage = 'components' | 'display' | 'overlays' | 'dialogs'

export type Route =
  | { name: 'onboarding'; step: OnboardingStep; roomId?: string }
  | { name: 'home' } | { name: 'inbox' } | { name: 'history' } | { name: 'rooms' }
  | { name: 'floor'; roomId: string } | { name: 'board'; roomId: string } | { name: 'task'; roomId: string; taskId: string }
  | { name: 'team'; roomId: string } | { name: 'agent'; roomId: string; agentId: string }
  | { name: 'workspace'; workspaceId: string }
  /** Linear issues. `issueId` is the identifier of the open issue. */
  | { name: 'issues'; issueId?: string }
  /** `section` is for `page: 'room'`, and none means General. */
  | { name: 'settings'; page: SettingsPage; roomId?: string; section?: RoomSettingsSection }
  /** The component gallery (KERNEL-9). Dev builds open it from `#/dev/ui/<page>`; fixtures can force it for shots. */
  | { name: 'devUi'; page: DevUiPage }

export type ConfirmKind = 'archive' | 'discard' | 'removeRoom' | 'retire' | 'trust'

/** The one modal shell's contents. At most one modal is open. */
export type Modal =
  | null
  | { name: 'newWorkspace'; roomId?: string; source?: WorkspaceSource }
  | { name: 'search' }
  | { name: 'newRoom'; prefill?: NewRoomPrefill }
  | { name: 'connectRepo' } | { name: 'openFolder' } | { name: 'checkHooks' }
  | { name: 'newAgent'; roomId: string; step: 'describe' | 'draft' | 'done'; prefill?: NewAgentPrefill }
  /** `update` is the install What's new opened with, which later update pushes must not replace (KERNEL-30). */
  | { name: 'whatsNew'; update?: AppUpdate }
  /** The add and edit form on an Environment page. No `roomId` is the app's page, and `editName` is the variable being edited (KERNEL-254). */
  | { name: 'envVar'; roomId?: string; editName?: string }
  | { name: 'confirm'; kind: 'archive'; workspaceId: string }
  | { name: 'confirm'; kind: 'discard'; workspaceId: string }
  | { name: 'confirm'; kind: 'removeRoom'; roomId: string }
  /** History > Delete: archived workspaces, with their branches, checkpoints and transcripts (KERNEL-333). */
  | { name: 'confirm'; kind: 'deleteHistory'; workspaceIds: string[] }
  | { name: 'confirm'; kind: 'retire'; roomId: string; agentId: string }
  /** Run this repo's scripts? The room's scripts and files.copy list waiting in `scriptTrust` (KERNEL-218). */
  | { name: 'confirm'; kind: 'trust'; roomId: string }
  /** Closing chats that are still running: the X on a chat tab, Close tab, Close other tabs or Cmd+W. */
  | { name: 'confirm'; kind: 'closeChats'; workspaceId: string; chatIds: string[] }

/**
 * Menus and popovers. One is open at a time. `room:<id>` is a sidebar room's menu, and `reply:<id>` the "..." menu under a reply.
 * Composer and new workspace menus share names because only one of the two is on screen.
 */
export type MenuId =
  | 'rooms' | `room:${string}` | 'account' | 'plan' | 'quickAsk'
  | 'pr' | 'tab' | 'newTab' | `reply:${string}`
  | 'plus' | 'model' | 'mention' | 'slash' | 'linkIssue' | 'linkWorkspaces'
  | 'branch' | 'from' | 'settingsFiles' | 'roomIcon' | 'preview'

/** Failure banners (DESIGN.md Patterns). The banner component reads the facts it shows from the store. */
export type BannerKind = 'limit' | 'context' | 'offline' | 'auth' | 'setup' | 'hooks' | 'retry' | 'trust'

export interface Banner {
  kind: BannerKind
  roomId?: string
  workspaceId?: string
  chatId?: string
}

/** Bottom-right toast, auto-dismissed after 2.6s (WorkspaceToast.png). */
export interface Toast {
  id: string
  title: string
  sub?: string
  /** `href` opens in the browser. `tab` opens that tab of the workspace in the app (KERNEL-311: Open chat after a comment is sent). */
  action?: { label: string; href?: string; tab?: { workspaceId: string; id: string } }
}

/** The workspace screen's panes, so fixtures can open any of them. */
export interface WorkspaceView {
  /** The right panel's tab. `prs` is the Lead's own, so a teammate's workspace shows Changes in its place (KERNEL-354). */
  right: 'prs' | 'files' | 'changes' | 'checks' | 'shared'
  /** The tab the Lead's workspace shows, kept apart from `right` so opening a teammate's workspace and coming back finds the PRs tab again. The store starts it at `prs`; a fixture can leave it out. */
  leadRight?: 'prs' | 'files' | 'changes' | 'checks' | 'shared'
  bottom: 'setup' | 'run' | 'terminal'
  checkpoints: boolean
  /** Tool call groups shown expanded (WorkspaceToolCalls.png). */
  toolsOpen: boolean
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
}

export interface UiState {
  route: Route
  modal: Modal
  menu: MenuId | null
  toasts: Toast[]
  banner: Banner | null
  theme: Theme
  /** A step of the floor briefing sequence. Real runs derive it from events; fixtures force it. */
  stage?: string
  workspace: WorkspaceView
  /** By workspace id. Each workspace keeps its own open tab, chat and file and diff tabs. */
  tabs: Record<string, WorkspaceTabs>
  /** Ids of the Lead chats folded by hand in the sidebar, which hides the workspaces they started. Only folded chats are listed; kept across launches. */
  foldedChats: string[]
  /** The left sidebar is showing. Its title bar toggle and Cmd+B hide it; kept across launches. */
  sidebar: boolean
  /** The screen's right panel is showing: the floor's Logs, a workspace's files and run panels. Cmd+Option+B; kept across launches. */
  rightPanel: boolean
  /** Why the app could not start. Set when `boot` fails, so Loading shows the error and Try again instead of "Starting Kernel" forever (KERNEL-217). */
  startError?: string
}

/** One room's Ask Rowan popover (QuickAsk.png). It outlasts the popover, which unmounts when it closes. */
export interface QuickAskState {
  /** What you typed and haven't sent. */
  draft: string
  /** A question is on its way to the Lead. Ask stays busy while the popover is closed and reopened. */
  sending?: boolean
  /** The question just sent, with the chat it went to and when, so the answer is the Lead's text after `since`. */
  asked?: { chatId: string; since: number; question: string }
}

/** UI state a fixture forces on boot. `quickAsk` is by room id, a slice of its own that a fixture can set. */
export type ForcedUi = Partial<UiState> & { quickAsk?: Record<string, QuickAskState> }
