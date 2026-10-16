import { useRef, useSyncExternalStore } from 'react'
import type { AccountAddStep, AccountProfile, Provider,
  ActivityEvent, AgentDef, AgentStatus, AppSettings, AppUpdate, Approval, Banner, BottomKind, Chat, ChatItem, ChatRunMode, Checkpoint, ClaudeAccount,
  ForcedUi, GitHubStatus, HookStatus, LeadMode, MenuId, McpNeeded, McpSignInAll, Modal, Notification, Overlap, PreflightCheck, PrInfo, PrPending, QueuedMessage, QueueReason, RateLimit, Project, ProjectSettings,
  ProjectSettingsSection, ProjectSetupStep, Route, ScriptKind, SettingsPage, ScriptLine, SharedFile, Task, Theme, Thread, Toast, ToolCalls, UiState, UsageView, Workspace, WorkspaceTabs, WorkspaceView
} from '@shared/types'
import type { KernelApi, PushEvent, Retry } from '@shared/ipc'
import { PROVIDERS } from '@shared/types'
import { keepData, keepLines, scriptKey, TERMINAL_KEEP } from '@shared/scriptLog'
import { currentRoute } from '@shared/settingsRoutes'
import { call, cleanError, onPush } from './api'
import { startupTheme } from './ui/theme'
import { closeAllLayers } from './ui/hooks'
import { hasTab, isChatTab, landing, nearest, placeToSave, restorePlace, projectHome, samePlace, stillThere, tabOf, type Place } from './nav'

export type { Modal, Route }

/** Both providers have an account called `cli`, so a Sign in to all run is kept under both. */
export const mcpRunKey = (provider: Provider, accountId: string) => `${provider}:${accountId}`
export { scriptKey }

/**
 * The renderer's state: one top-level key per domain, plus `ui`. Keys stay flat so selectors read `s.projects`, `s.items[chatId]`.
 * Write through `actions` (typed, one group per slice) or push events; `setState` is the escape hatch.
 */
export interface State {
  // projects
  projects: Project[]
  /** By project id. Progress of a project being set up (ProjectSetup.png). */
  projectSetup: Record<string, ProjectSetupStep[]>
  /** By project id. */
  overlaps: Record<string, Overlap[]>
  // agents
  /** By project id. */
  agents: Record<string, AgentDef[]>
  /** By project id, then agent id. */
  status: Record<string, Record<string, AgentStatus>>
  /** The personal and plugin agents that join every project, with no project needed. Null until `agents.listGlobal` answers (KERNEL-641). */
  globalAgents: AgentDef[] | null
  // workspaces
  workspaces: Workspace[]
  /** By workspace id. Lines carry the run script's `name`, and each script keeps its own last 400. */
  scripts: Record<string, ScriptLine[]>
  /** By workspace id, then `scriptKey`. Exit code of the last run of each script. */
  scriptExit: Record<string, Record<string, number | null | undefined>>
  /** By workspace id, then run script name. The first local URL the script printed, while it runs (`script.url`, KERNEL-246). */
  scriptUrl: Record<string, Record<string, string>>
  /** By workspace id, then `scriptKey`. Each script's terminal output as it printed it, its last `TERMINAL_KEEP` characters (KERNEL-655). */
  scriptData: Record<string, Record<string, string>>
  /** By workspace id. How many times main's copy replaced `scriptData`, so an open script view knows to draw it again from the top (KERNEL-655). */
  scriptReplays: Record<string, number>
  /** By workspace id. */
  checkpoints: Record<string, Checkpoint[]>
  // chats
  /** By workspace id. */
  chats: Record<string, Chat[]>
  /** By thread id. The Lead chats, each holding the Lead tabs whose `threadId` names it, open or closed (KERNEL-337). */
  threads: Record<string, Thread>
  /** By workspace id. The Lead chat each Lead workspace showed last, which stays current while a terminal tab is open (KERNEL-338). */
  lastThread: Record<string, string>
  /** By thread id. The tab last shown in each Lead chat, so the sidebar row and a switch back open where you left off. Kept across launches (KERNEL-338). */
  lastTabs: Record<string, string>
  /** By chat id. */
  items: Record<string, ChatItem[]>
  /** By chat id. True once the chat's items have arrived (KERNEL-860). Until then an empty `items` means loading, not a new chat. A chat created in this session has none to load. */
  itemsLoaded: Record<string, boolean>
  /** By chat id. True when the last load of the chat's items failed, until a load succeeds. */
  itemsFailed: Record<string, boolean>
  /** By chat id. */
  running: Record<string, boolean>
  /** By chat id. True while `running` holds what the user's own action drew (a send, Stop) and main has not said it yet. Main's `chat.running` ends it, as does the call failing (KERNEL-895). */
  assumed: Record<string, boolean>
  /** By chat id. */
  queue: Record<string, QueuedMessage[]>
  /** By chat id. What the queue waits for, absent while it is empty (KERNEL-273). */
  queueWhy: Record<string, QueueReason>
  /** By chat id. The permission mode each chat runs in, the mode picked for it and why they differ (`chats.runMode`, KERNEL-572). */
  runModes: Record<string, ChatRunMode>
  /** By chat id. Raw pty output for terminal chats. */
  terminal: Record<string, string>
  /** By chat id. How many times main's copy replaced `terminal`, so an open terminal knows to draw it again from the top (KERNEL-340). */
  terminalReplays: Record<string, number>
  /** By chat id. Set while Claude is overloaded and the session retries. */
  retry: Record<string, Retry>
  // approvals, tasks, activity, notifications
  approvals: Approval[]
  /** By project id. */
  tasks: Record<string, Task[]>
  activity: ActivityEvent[]
  /** By project id, then agent id. When each agent's newest event in the project happened, from the whole log rather than the `activity` window. */
  lastActivity: Record<string, Record<string, number>>
  notifications: Notification[]
  // pull requests
  /** By workspace id. */
  prs: Record<string, PrInfo>
  /** By workspace id, the PR action main is running, from whichever button or tool started it (KERNEL-519). */
  prPending: Record<string, PrPending>
  // usage, account, settings, system
  usage: RateLimit[]
  account: ClaudeAccount | null
  /** Both providers' accounts, each CLI login first (KERNEL-406). Empty until `accounts.list` answers. */
  accounts: AccountProfile[]
  /** Where Add account is, for its sheet. Null when no sign-in is open. */
  accountAdd: AccountAddStep | null
  /** Where Sign in to all is on each account, by `mcpRunKey` (KERNEL-627, Codex since KERNEL-647). */
  mcpRuns: Record<string, McpSignInAll>
  settings: AppSettings | null
  /** By project id. */
  projectSettings: Record<string, ProjectSettings>
  /** By shared id. Every file agents shared, from `shared.list` and the `shared` push (KERNEL-305). */
  shared: Record<string, SharedFile>
  system: { booted: boolean; online: boolean; preflight: PreflightCheck[] | null; hooks: HookStatus | null; update: AppUpdate | null; github: GitHubStatus }
  ui: UiState
}

/** The Changes tab's list or tree, kept across launches like the panel toggles (KERNEL-399). localStorage may be missing or blocked. */
const CHANGES_VIEW = 'kernel.changesView'
function changesView(): 'list' | 'tree' {
  try { return localStorage.getItem(CHANGES_VIEW) === 'tree' ? 'tree' : 'list' } catch { return 'list' }
}

/** The Usage popover's Detailed or Compact, kept across launches (KERNEL-674). localStorage may be missing or blocked. */
const USAGE_VIEW = 'kernel.usageView'
function usageView(): UsageView {
  try { return localStorage.getItem(USAGE_VIEW) === 'compact' ? 'compact' : 'detailed' } catch { return 'detailed' }
}
const usageOpenAtFirst = (view: UsageView): Provider[] => (view === 'detailed' ? ['claude'] : [])

/** How a turn's folds behave, kept across launches. localStorage may be missing or blocked. */
const TOOL_CALLS = 'kernel.toolCalls'
function toolCalls(): ToolCalls {
  try { const v = localStorage.getItem(TOOL_CALLS); return v === 'closed' || v === 'open' ? v : 'auto' } catch { return 'auto' }
}

const workspaceView: WorkspaceView = { right: 'changes', leadRight: 'prs', bottom: 'run', toolCalls: toolCalls(), changesView: changesView() }

/** The sidebar and right panel toggles outlast a restart. A key is stored only while its panel is hidden, and localStorage may be missing or blocked. */
const HIDDEN = { sidebar: 'kernel.sidebarHidden', rightPanel: 'kernel.rightPanelHidden' } as const
function showing(panel: keyof typeof HIDDEN) {
  try { return localStorage.getItem(HIDDEN[panel]) !== '1' } catch { return true }
}
function keep(panel: keyof typeof HIDDEN, open: boolean) {
  try { if (open) localStorage.removeItem(HIDDEN[panel]); else localStorage.setItem(HIDDEN[panel], '1') } catch { /* not remembered */ }
}
/** KERNEL-670 removed the footer's question box and its history. Drop the questions the last version stored, so none stay on the Mac. localStorage may be missing or blocked. */
try { localStorage.removeItem('kernel.askHistory') } catch { /* nothing stored */ }
/**
 * The right panel's bottom pane (KERNEL-513), kept across launches like the panel toggles. Its size is one fraction of the panel below the PR band
 * for every chat, and a key is stored only once it is dragged. Collapsed or open is kept apart for Lead chats, which start collapsed, and for
 * teammate workspaces, which start open. localStorage may be missing or blocked, and a stored value may be junk.
 */
export const BOTTOM_RATIO_DEFAULT = 1 / 3
const BOTTOM_RATIO = 'kernel.bottomPanelRatio'
const BOTTOM_COLLAPSED: Record<BottomKind, string> = { lead: 'kernel.bottomCollapsed.lead', teammate: 'kernel.bottomCollapsed.teammate' }
const COLLAPSED_AT_FIRST: Record<BottomKind, boolean> = { lead: true, teammate: false }
export function bottomRatio(): number {
  try {
    const n = Number(localStorage.getItem(BOTTOM_RATIO))
    return Number.isFinite(n) && n > 0 && n < 1 ? n : BOTTOM_RATIO_DEFAULT
  } catch { return BOTTOM_RATIO_DEFAULT }
}
function keepBottomRatio(ratio: number | null) {
  try { if (ratio === null) localStorage.removeItem(BOTTOM_RATIO); else localStorage.setItem(BOTTOM_RATIO, String(ratio)) } catch { /* not remembered */ }
}
/** What was last saved for `kind`, or where it starts. Setup wait opens the pane without saving, and asks for this when it goes. */
export function bottomCollapsed(kind: BottomKind): boolean {
  try {
    const v = localStorage.getItem(BOTTOM_COLLAPSED[kind])
    return v === '1' ? true : v === '0' ? false : COLLAPSED_AT_FIRST[kind]
  } catch { return COLLAPSED_AT_FIRST[kind] }
}
function keepBottomCollapsed(kind: BottomKind, collapsed: boolean) {
  try { localStorage.setItem(BOTTOM_COLLAPSED[kind], collapsed ? '1' : '0') } catch { /* not remembered */ }
}
/** The Lead chats folded in the sidebar, by id, kept across launches like the panel toggles. localStorage may be missing or blocked, and its value may not be a list. */
const FOLDED_CHATS = 'kernel.foldedChats'
function foldedChats(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(FOLDED_CHATS) ?? '[]')
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}
function keepFoldedChats(ids: string[]) {
  try { localStorage.setItem(FOLDED_CHATS, JSON.stringify(ids)) } catch { /* not remembered */ }
}
/** The tab last shown in each Lead chat, by thread id, kept across launches like `lastChat`. localStorage may be missing or blocked, and its value may not be a map of strings. */
const LAST_TABS = 'kernel.lastTabs'
function lastTabs(): Record<string, string> {
  try {
    const map: unknown = JSON.parse(localStorage.getItem(LAST_TABS) ?? '{}')
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {}
    return Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch { return {} }
}
function keepLastTabs(map: Record<string, string>) {
  try { localStorage.setItem(LAST_TABS, JSON.stringify(map)) } catch { /* not remembered */ }
}
/** Forgets the last tab of the threads `gone` picks out, so `kernel.lastTabs` doesn't keep a chat nobody can open. */
function dropLastTabs(gone: (threadId: string) => boolean) {
  const ids = Object.keys(state.lastTabs).filter(gone)
  if (!ids.length) return
  const next = { ...state.lastTabs }
  for (const id of ids) delete next[id]
  setState({ lastTabs: next })
  keepLastTabs(next)
}
/** Panels a narrow window folded (`ui.fold`). A fold never touches the saved toggle, and toggling a panel by hand forgets its fold. */
const folded = new Set<keyof typeof HIDDEN>()

let state: State = {
  projects: [], projectSetup: {}, overlaps: {},
  agents: {}, status: {}, globalAgents: null,
  workspaces: [], scripts: {}, scriptExit: {}, scriptUrl: {}, scriptData: {}, scriptReplays: {}, checkpoints: {},
  chats: {}, threads: {}, lastThread: {}, lastTabs: lastTabs(), items: {}, itemsLoaded: {}, itemsFailed: {}, running: {}, assumed: {}, queue: {}, queueWhy: {}, runModes: {}, terminal: {}, terminalReplays: {}, retry: {},
  approvals: [], tasks: {}, activity: [], lastActivity: {}, notifications: [],
  prs: {}, prPending: {},
  usage: [], account: null, accounts: [], accountAdd: null, mcpRuns: {}, settings: null, projectSettings: {}, shared: {},
  system: { booted: false, online: true, preflight: null, hooks: null, update: null, github: {} },
  ui: { route: { name: 'onboarding', step: 'loading' }, nav: { canBack: false, canForward: false }, modal: null, menu: null, toasts: [], banner: null, theme: startupTheme(), workspace: workspaceView, tabs: {}, foldedChats: foldedChats(), sidebar: showing('sidebar'), rightPanel: showing('rightPanel'), panelHeld: [], bottomRatio: bottomRatio(), bottomCollapsed: { lead: bottomCollapsed('lead'), teammate: bottomCollapsed('teammate') }, usageView: usageView(), usageOpen: usageOpenAtFirst(usageView()), switching: null }
}
const listeners = new Set<() => void>()

export function getState() { return state }
/** Whether the right panel shows in a workspace: the global setting, unless a New chat holds it closed there (KERNEL-788). */
export const panelShownIn = (ui: Pick<UiState, 'rightPanel' | 'panelHeld'>, workspaceId?: string) => ui.rightPanel && !(workspaceId && ui.panelHeld.includes(workspaceId))
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  listeners.forEach((l) => l())
}
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Same top-level entries. Selectors build new arrays and objects (`?? []`, `.filter`), so identity alone isn't enough. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/**
 * Select from the store. Keeps the previous result while it is shallow-equal, because useSyncExternalStore
 * re-renders whenever the snapshot changes identity and a fresh array every read loops forever (React error #185).
 */
export function useStore<T>(select: (s: State) => T): T {
  const last = useRef<{ value: T } | null>(null)
  return useSyncExternalStore(subscribe, () => {
    const value = select(state)
    if (last.current && shallowEqual(last.current.value, value)) return last.current.value
    last.current = { value }
    return value
  })
}

const upsert = <T extends { id: string }>(list: T[], item: T) => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item])
const byRecent = <T extends { createdAt: number }>(list: T[]) => [...list].sort((a, b) => b.createdAt - a.createdAt)
/** `all` with each of `times` written into the project's entry when it is later than what is there. Unchanged projects keep their identity. */
function newer(all: State['lastActivity'], projectId: string, times: Record<string, number>): State['lastActivity'] {
  const project = all[projectId] ?? {}
  const later = Object.entries(times).filter(([id, ts]) => ts > (project[id] ?? -Infinity))
  return later.length ? { ...all, [projectId]: { ...project, ...Object.fromEntries(later) } } : all
}
/** Settings > General > Last project: the project whose team page, chat or workspace was open last. localStorage may be missing or blocked, so every access is guarded. */
// Rooms were renamed projects (KERNEL-880). The saved key keeps its old name, so the last project still opens after the update.
const LAST_PROJECT = 'kernel.lastRoom'
function rememberProject(route: Route) {
  const id = 'projectId' in route && route.projectId ? route.projectId : route.name === 'workspace' ? state.workspaces.find((w) => w.id === route.workspaceId)?.projectId : undefined
  if (!id || route.name === 'settings') return
  try { localStorage.setItem(LAST_PROJECT, id) } catch { /* not remembered */ }
}
export function lastProject(): string | null {
  try { return localStorage.getItem(LAST_PROJECT) } catch { return null }
}
/** How many selected tabs a workspace remembers for closing the open one. */
const RECENT_TABS = 20
const emptyTabs: WorkspaceTabs = { files: [], diffs: [], shared: [] }
/** `tabs` with `tab` selected. A chat id also becomes `lastChat`; a file, diff or shared tab joins the open ones. */
function withTab(tabs: WorkspaceTabs | undefined, tab: string): WorkspaceTabs {
  const t = { ...emptyTabs, ...tabs, tab, recent: [tab, ...(tabs?.recent ?? []).filter((id) => id !== tab)].slice(0, RECENT_TABS) }
  if (tab.startsWith('file:')) { const path = tab.slice(5); return t.files.includes(path) ? t : { ...t, files: [...t.files, path] } }
  if (tab.startsWith('diff:')) { const path = tab.slice(5); return t.diffs.includes(path) ? t : { ...t, diffs: [...t.diffs, path] } }
  if (tab.startsWith('shared:')) { const id = tab.slice(7); return (t.shared ?? []).includes(id) ? t : { ...t, shared: [...(t.shared ?? []), id] } }
  if (tab.startsWith('image:') || tab.startsWith('text:')) return t
  return { ...t, lastChat: tab }
}
/** Selects the tab without recording a step. */
function selectTab(workspaceId: string, tab: string) {
  setState((s) => ({ ui: { ...s.ui, tabs: { ...s.ui.tabs, [workspaceId]: withTab(s.ui.tabs[workspaceId], tab) } } }))
  // A Lead tab is also the last one shown in its Lead chat. A file or diff tab leaves the memory alone.
  const threadId = state.chats[workspaceId]?.find((c) => c.id === tab)?.threadId
  if (!threadId) return
  if (state.lastThread[workspaceId] !== threadId) setState({ lastThread: { ...state.lastThread, [workspaceId]: threadId } })
  if (state.lastTabs[threadId] !== tab) {
    const next = { ...state.lastTabs, [threadId]: tab }
    setState({ lastTabs: next })
    keepLastTabs(next)
  }
}
/** Where the app is now. */
const placeNow = (): Place => {
  const { route } = state.ui
  return route.name === 'workspace' ? { route, tab: tabOf(state, route.workspaceId) } : { route }
}
/** Where Settings was opened from, the last Settings page, and where the app opened. Module level like `folded`: none of it outlasts a restart. */
let returnTo: Place | undefined
let lastSettings: { page: SettingsPage; projectId?: string; section?: ProjectSettingsSection } | undefined
let launch: Route = { name: 'onboarding', step: 'loading' }
/**
 * The place a relaunch reopens (KERNEL-201), kept in localStorage like the other `kernel.*` keys, which may be missing or blocked.
 * Nothing is written before the first route is chosen (`system.booted`), so a restore never overwrites what it read, and none in fixture mode.
 */
const LAST_PLACE = 'kernel.lastPlace'
let fixtureMode = false
/** Fixture mode runs on a shared folder of its own and must neither read nor write what a real launch saved. */
export const isFixture = () => fixtureMode
let fixturePersist = false
/** Fixture mode with KERNEL_FIXTURE_PERSIST=1: remembered choices use real localStorage, for scripts that relaunch the app (scroll-check). */
export const fixturePersists = () => fixtureMode && fixturePersist
function savePlace() {
  if (!state.system.booted || fixtureMode) return
  const place = placeToSave(state, returnTo)
  if (!place) return
  try { localStorage.setItem(LAST_PLACE, JSON.stringify(place)) } catch { /* not remembered */ }
}
function savedPlace(): string | null {
  try { return localStorage.getItem(LAST_PLACE) } catch { return null }
}
// A tab closed, or a workspace's tabs dropped with the workspace, changes what a relaunch shows without being a move. Every write to
// `ui.tabs` makes a new object (`dropTabs` keeps the old one when it drops nothing), so a changed identity is a changed tab list.
let savedTabs = state.ui.tabs
subscribe(() => {
  if (state.ui.tabs === savedTabs) return
  savedTabs = state.ui.tabs
  savePlace()
})
/** The workspaces whose whole chat list has been read. `chats[id]` alone can't say: a pushed chat creates the entry with just itself. Drafts use it (KERNEL-201). */
const loadedChats = new Set<string>()
export const chatsLoaded = (workspaceId: string) => loadedChats.has(workspaceId)
/** Back and forward: the places you left, newest last, and the ones Back stepped over. Module level like `returnTo`, so a restart starts empty. */
const HISTORY_LIMIT = 50
let past: Place[] = []
let future: Place[] = []
/** How a move is recorded. `push` keeps the place left, `replace` stands in for it, `none` is Back and Forward themselves. */
export type HistoryMode = 'push' | 'replace' | 'none'
const capped = (list: Place[]) => list.length > HISTORY_LIMIT ? list.slice(-HISTORY_LIMIT) : list
/** Every move ends here, whether it changed the route (`go`) or the tab (`openTab`). The place-keeping lines of the issues after it go here too. */
function moved(from: Place, to: Place, history: HistoryMode = 'push') {
  closeAllLayers()
  if (to.route.name === 'settings') {
    if (from.route.name !== 'settings') returnTo = from
    lastSettings = { page: to.route.page, ...(to.route.projectId ? { projectId: to.route.projectId } : {}), ...(to.route.section ? { section: to.route.section } : {}) }
  }
  // Callers apply the move before calling this, so the state is already `to` with its tabs. Saved ahead of the history block, which returns early, and for Back and Forward too.
  savePlace()
  if (history === 'none' || samePlace(from, to)) return
  // Onboarding and the dev pages are not somewhere to come back to, and nor is a page of Settings once you are in Settings.
  const quiet = to.route.name === 'onboarding' || to.route.name === 'devUi' || from.route.name === 'onboarding' || (from.route.name === 'settings' && to.route.name === 'settings')
  if (history === 'replace' || quiet) return
  past = capped([...past, from])
  future = []
  syncNav()
}
/** The place with the chat you were last on in place of a file, diff, image or text tab. */
function onChat(place: Place): Place {
  if (place.route.name !== 'workspace' || !place.tab || isChatTab(place.tab)) return place
  return { route: place.route, tab: state.ui.tabs[place.route.workspaceId]?.lastChat }
}
/** Where you are, as a place to come back to. Image and text tabs live in the screen and are gone once you leave, so they count as the chat you were last on. */
function leaving(): Place {
  const here = placeNow()
  return here.tab?.startsWith('image:') || here.tab?.startsWith('text:') ? onChat(here) : here
}
/** The entry as it would open now: a tab closed since falls back through `tabOf`, which is why that is where it is compared. */
function resolved(entry: Place): Place {
  if (entry.route.name !== 'workspace' || !entry.tab || hasTab(state, entry.route.workspaceId, entry.tab)) return entry
  return { route: entry.route, tab: tabOf(state, entry.route.workspaceId) }
}
/** Is this entry somewhere to go: still there, and not where you already are. */
const reachable = (entry: Place, now: Place) => stillThere(entry.route, state) && !samePlace(resolved(entry), now)
/** Takes `list` to its newest reachable entry, dropping the dead ones on the way. Returns that entry and the rest of the list. */
function takeNewest(list: Place[], now: Place): { entry: Place; rest: Place[] } | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (reachable(list[i], now)) return { entry: list[i], rest: list.slice(0, i) }
  return undefined
}
/** Goes to `entry` without recording it: its tab when that tab is still open, then its route. */
function arrive(entry: Place) {
  if (entry.route.name === 'workspace' && entry.tab && hasTab(state, entry.route.workspaceId, entry.tab)) selectTab(entry.route.workspaceId, entry.tab)
  actions.ui.go(entry.route, { history: 'none' })
}
/** Takes the newest reachable entry of `past` (back) or `future` (forward), and puts where you are now on the other list. */
function step(dir: 'back' | 'forward'): boolean {
  const now = leaving()
  const taken = takeNewest(dir === 'back' ? past : future, now)
  // Nothing reachable, so everything in that list is dead or where you already are.
  if (!taken) { if (dir === 'back') past = []; else future = []; syncNav(); return false }
  const other = capped([...(dir === 'back' ? future : past), now])
  if (dir === 'back') { past = taken.rest; future = other } else { future = taken.rest; past = other }
  arrive(taken.entry)
  syncNav()
  return true
}
/** Is there a place Back or Forward would reach. */
export const canBack = () => takeNewest(past, leaving()) !== undefined
export const canForward = () => takeNewest(future, leaving()) !== undefined
/** Empties both lists. For tests, which share the module. */
export function resetHistory() { past = []; future = []; syncNav() }
/** Copies `canBack` and `canForward` into `ui.nav`, writing only when one changed. Fixtures set `ui.nav` themselves. */
function syncNav() {
  if (fixtureMode) return
  const nav = { canBack: canBack(), canForward: canForward() }
  const was = state.ui.nav
  if (was.canBack !== nav.canBack || was.canForward !== nav.canForward) setState((s) => ({ ui: { ...s.ui, nav } }))
}
// Closing a workspace or tab can make an entry unreachable without a move, so every change to the state is checked too.
subscribe(syncNav)
/** `tabs` without the workspaces `gone` picks out. Tabs with nothing to drop keep their identity. */
function dropTabs(tabs: UiState['tabs'], gone: (workspaceId: string) => boolean): UiState['tabs'] {
  const ids = Object.keys(tabs).filter(gone)
  if (!ids.length) return tabs
  const out = { ...tabs }
  for (const id of ids) delete out[id]
  return out
}
/** `record` without the keys in `keys`. A record with nothing to drop keeps its identity. */
function omit<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  if (!keys.some((k) => k in record)) return record
  const out = { ...record }
  for (const k of keys) delete out[k]
  return out
}
const setUi = (patch: Partial<UiState>) => setState((s) => ({ ui: { ...s.ui, ...patch } }))
let toastSeq = 0
/** The stack holds this many toasts. A newer one pushes the oldest out (DESIGN.md). */
const MAX_TOASTS = 3

/** One switch at a time, from every entry point. The state clears when the switch and the fresh usage have both answered, or when the switch fails (KERNEL-986). */
async function performSwitch(provider: Provider, accountId: string, reason?: 'banner', done?: () => void) {
  if (state.ui.switching) return
  setUi({ switching: { provider, accountId } })
  try {
    actions.accounts.set(await call('accounts.switch', { provider, accountId, ...(reason ? { reason } : {}) }))
    await call('usage.get', undefined).then(actions.usage.set).catch(() => undefined)
  } finally { setUi({ switching: null }) }
  done?.()
}

/** Typed writes, one group per slice. Screens call these instead of reshaping state themselves. */
export const actions = {
  ui: {
    /**
     * Navigate. Closes any modal and menu. Entering a workspace opens its right panel on Changes, or on PRs for the Lead's. A Settings page
     * that was merged into another opens the one that holds it now (KERNEL-680).
     */
    go: (to: Route, opts?: { history?: HistoryMode }) => {
      const route = currentRoute(to)
      const from = leaving()
      const now = state.ui.route
      const entering = route.name === 'workspace' && !(now.name === 'workspace' && now.workspaceId === route.workspaceId)
      setUi({ route, modal: null, menu: null, ...(entering && { workspace: { ...state.ui.workspace, right: workspaceView.right, leadRight: workspaceView.leadRight } }) })
      rememberProject(route)
      moved(from, placeNow(), opts?.history)
    },
    /** ⌘[ and the mouse's back button: the newest place you left that is still there. False when there is none. */
    back: () => step('back'),
    /** ⌘] and the mouse's forward button: undoes a Back. */
    forward: () => step('forward'),
    /** ⌘, : the Settings page you were on last, or General when that page's project is gone. */
    openSettings: () => {
      const last = lastSettings
      const route: Route = last && stillThere({ name: 'settings', ...last }, state) ? { name: 'settings', ...last } : { name: 'settings', page: 'general' }
      actions.ui.go(route)
    },
    /** Back to app: where Settings was opened from, or the nearest place that is still there. */
    leaveSettings: () => {
      // The Settings pages replace each other, so the newest entry is where Settings was opened from, unless it is dead or Settings was opened by a restart.
      const newest = past[past.length - 1]
      if (newest && newest.route.name !== 'settings' && reachable(newest, leaving())) actions.ui.back()
      else {
        // A launch that opened on a project's Agents page would send Back to app to the page it is leaving.
        const there = nearest((returnTo ?? { route: launch }).route, state)
        actions.ui.go(there.name === 'settings' ? landing(state) : there, { history: 'replace' })
      }
    },
    openModal: (modal: Exclude<Modal, null>) => setUi({ modal, menu: null }),
    closeModal: () => setUi({ modal: null }),
    /** Opens the menu, or closes it when it is already open. */
    toggleMenu: (menu: MenuId) => setState((s) => ({ ui: { ...s.ui, menu: s.ui.menu === menu ? null : menu } })),
    closeMenu: () => setUi({ menu: null }),
    /**
     * Shows a toast. Returns its id. `components/Toasts.tsx` drops it after 5s (DESIGN.md) and holds it while hovered,
     * so the store sets no timer of its own unless `ms` asks for one.
     */
    toast: (t: Omit<Toast, 'id'>, ms?: number) => {
      const toast = { ...t, id: `toast-${++toastSeq}` }
      setState((s) => ({ ui: { ...s.ui, toasts: [...s.ui.toasts, toast].slice(-MAX_TOASTS) } }))
      if (ms && ms > 0) setTimeout(() => actions.ui.dismissToast(toast.id), ms)
      return toast.id
    },
    dismissToast: (id: string) => setState((s) => ({ ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== id) } })),
    showBanner: (banner: Banner) => setUi({ banner }),
    clearBanner: () => setUi({ banner: null }),
    setTheme: (theme: Theme) => { setUi({ theme }); document.documentElement.dataset.theme = theme },
    setStage: (stage: string | undefined) => setUi({ stage }),
    setStartError: (startError: string | undefined) => setUi({ startError }),
    setWorkspaceView: (patch: Partial<WorkspaceView>) => setState((s) => ({ ui: { ...s.ui, workspace: { ...s.ui.workspace, ...patch } } })),
    setToolCalls: (mode: ToolCalls) => {
      setState((s) => ({ ui: { ...s.ui, workspace: { ...s.ui.workspace, toolCalls: mode } } }))
      try { localStorage.setItem(TOOL_CALLS, mode) } catch { /* not remembered */ }
    },
    setChangesView: (view: 'list' | 'tree') => {
      setState((s) => ({ ui: { ...s.ui, workspace: { ...s.ui.workspace, changesView: view } } }))
      try { localStorage.setItem(CHANGES_VIEW, view) } catch { /* not remembered */ }
    },
    /** Detailed or Compact in the Usage popover. Each starts with its own rows open, so a switch closes what the other had open. */
    setUsageView: (view: UsageView) => {
      setUi({ usageView: view, usageOpen: usageOpenAtFirst(view) })
      try { localStorage.setItem(USAGE_VIEW, view) } catch { /* not remembered */ }
    },
    /** Opens the Usage popover with only `provider`'s row expanded, from a footer chip. */
    openUsage: (provider: Provider) => setState((s) => ({ ui: { ...s.ui, menu: 'plan', usageOpen: [provider] } })),
    toggleUsageProvider: (provider: Provider) => setState((s) => ({ ui: { ...s.ui, usageOpen: s.ui.usageOpen.includes(provider) ? s.ui.usageOpen.filter((p) => p !== provider) : [...s.ui.usageOpen, provider] } })),
    /** Selects a tab of the workspace. A chat id also remembers the chat, and a file or diff tab is added to the open ones. */
    openTab: (workspaceId: string, tab: string) => {
      // A file or diff tab is not a step, so switching chats from one steps from the chat you opened it from. Leaving the workspace keeps the tab (`go`).
      const from = onChat(leaving())
      const shown = state.ui.tabs[workspaceId]?.tab
      selectTab(workspaceId, tab)
      // Only switching chats in the workspace on screen is a step. A file or diff is a detour from the chat, and another workspace's tab is not on screen.
      // Nor is moving off a tab that was closed, as closing a chat does: `from` is then a fallback chat you never chose.
      const closed = !!shown && !hasTab(state, workspaceId, shown)
      moved(from, placeNow(), isChatTab(tab) && !closed ? 'push' : 'none')
    },
    /**
     * Opens a shared file's tab in the workspace on screen (the copy is Kernel's, so any workspace can show it) and selects it. A `version`
     * picks that one, and the latest clears the pick so the tab follows new versions. Without one, a pick already made stays (KERNEL-305).
     * A card passes its own version, since it stands for that one. A file that hasn't loaded has no latest to compare with, so it picks nothing.
     */
    openShared: (workspaceId: string, sharedId: string, version?: number) => {
      const file = state.shared[sharedId]
      if (version !== undefined && file) {
        const latest = Math.max(0, ...file.versions.map((v) => v.n))
        const { [sharedId]: _was, ...rest } = state.ui.tabs[workspaceId]?.sharedVersion ?? {}
        actions.ui.setTabs(workspaceId, { sharedVersion: version === latest ? rest : { ...rest, [sharedId]: version } })
      }
      actions.ui.openTab(workspaceId, `shared:${sharedId}`)
    },
    /** Changes a workspace's tabs without selecting anything new, for closing a tab. */
    setTabs: (workspaceId: string, patch: Partial<WorkspaceTabs>) => setState((s) => ({ ui: { ...s.ui, tabs: { ...s.ui.tabs, [workspaceId]: { ...emptyTabs, ...s.ui.tabs[workspaceId], ...patch } } } })),
    /**
     * Folds or unfolds a Lead chat's workspaces in the sidebar. Unfolding drops the id, so the list holds only folded chats. `saved` are ids
     * a fold was kept under before chats had threads (the chat ids of its tabs): any of them counts as a fold of the chat, and unfolding drops them too.
     */
    foldChat: (chatId: string, fold: boolean, saved: string[] = []) => {
      const ids = getState().ui.foldedChats.filter((id) => id !== chatId && !saved.includes(id))
      const next = fold ? [...ids, chatId] : ids
      setUi({ foldedChats: next })
      keepFoldedChats(next)
    },
    /** The bottom pane's height as a fraction of the panel below its header. Null goes back to the default and forgets the saved one. */
    setBottomRatio: (ratio: number | null) => { setUi({ bottomRatio: ratio ?? BOTTOM_RATIO_DEFAULT }); keepBottomRatio(ratio) },
    /** Setup wait opens the pane for as long as it shows and passes `save: false`, so what the user chose comes back with `restoreBottomCollapsed`. */
    setBottomCollapsed: (kind: BottomKind, collapsed: boolean, save = true) => {
      setState((s) => ({ ui: { ...s.ui, bottomCollapsed: { ...s.ui.bottomCollapsed, [kind]: collapsed } } }))
      if (save) keepBottomCollapsed(kind, collapsed)
    },
    restoreBottomCollapsed: (kind: BottomKind) => actions.ui.setBottomCollapsed(kind, bottomCollapsed(kind), false),
    setSidebar: (open: boolean) => { folded.delete('sidebar'); setUi({ sidebar: open }); keep('sidebar', open) },
    /** Opening or closing the panel by hand ends the hold a New chat put on the workspace in view (KERNEL-788). */
    setRightPanel: (open: boolean) => {
      folded.delete('rightPanel')
      const { route, panelHeld } = state.ui
      const held = route.name === 'workspace' && panelHeld.includes(route.workspaceId)
      setUi({ rightPanel: open, ...(held && { panelHeld: panelHeld.filter((id) => id !== route.workspaceId) }) })
      keep('rightPanel', open)
    },
    /** The workspace's panel stays closed until the toggle is pressed in it, whatever the global setting says. The panel never opens by itself (KERNEL-788). */
    holdPanel: (workspaceId: string) => { if (!state.ui.panelHeld.includes(workspaceId)) setUi({ panelHeld: [...state.ui.panelHeld, workspaceId] }) },
    /** The window got too narrow for a panel, or wide enough again. Widening brings back only a panel that folding hid (D-080). */
    fold: (panel: keyof typeof HIDDEN, narrow: boolean) => {
      if (narrow && getState().ui[panel]) { folded.add(panel); setUi(panel === 'sidebar' ? { sidebar: false } : { rightPanel: false }) }
      else if (!narrow && folded.delete(panel)) setUi(panel === 'sidebar' ? { sidebar: true } : { rightPanel: true })
    }
  },
  projects: {
    set: (projects: Project[]) => setState({ projects }),
    upsert: (project: Project) => setState((s) => ({ projects: upsert(s.projects, project) })),
    remove: (projectId: string) => setState((s) => ({
      projects: s.projects.filter((r) => r.id !== projectId), workspaces: s.workspaces.filter((w) => w.projectId !== projectId),
      ui: { ...s.ui, tabs: dropTabs(s.ui.tabs, (id) => s.workspaces.find((w) => w.id === id)?.projectId === projectId) }
    })),
    setSetup: (projectId: string, steps: ProjectSetupStep[]) => setState((s) => ({ projectSetup: { ...s.projectSetup, [projectId]: steps } })),
    setOverlaps: (projectId: string, list: Overlap[]) => setState((s) => ({ overlaps: { ...s.overlaps, [projectId]: list } })),
    upsertOverlap: (o: Overlap) => setState((s) => ({ overlaps: { ...s.overlaps, [o.projectId]: upsert(s.overlaps[o.projectId] ?? [], o) } }))
  },
  agents: {
    set: (projectId: string, list: AgentDef[]) => setState((s) => ({ agents: { ...s.agents, [projectId]: list } })),
    setGlobal: (list: AgentDef[]) => setState({ globalAgents: list }),
    setStatus: (projectId: string, agentId: string, status: AgentStatus) => setState((s) => ({
      status: { ...s.status, [projectId]: { ...(s.status[projectId] ?? {}), [agentId]: status } }
    }))
  },
  workspaces: {
    set: (list: Workspace[]) => setState((s) => ({ workspaces: list, ui: { ...s.ui, tabs: dropTabs(s.ui.tabs, (id) => !list.some((w) => w.id === id && w.status !== 'archived')) } })),
    upsert: (ws: Workspace) => setState((s) => ({ workspaces: upsert(s.workspaces, ws), ui: ws.status === 'archived' ? { ...s.ui, tabs: dropTabs(s.ui.tabs, (id) => id === ws.id) } : s.ui })),
    /** Workspaces deleted from History: their chats, chat items, script lines and tabs go with them (KERNEL-333). */
    remove: (ids: string[]) => setState((s) => {
      const gone = new Set(ids)
      const chatIds = ids.flatMap((id) => (s.chats[id] ?? []).map((c) => c.id))
      return {
        workspaces: s.workspaces.filter((w) => !gone.has(w.id)),
        chats: omit(s.chats, ids),
        items: omit(s.items, chatIds),
        itemsLoaded: omit(s.itemsLoaded, chatIds),
        itemsFailed: omit(s.itemsFailed, chatIds),
        scripts: omit(s.scripts, ids),
        scriptData: omit(s.scriptData, ids),
        ui: { ...s.ui, tabs: dropTabs(s.ui.tabs, (id) => gone.has(id)) }
      }
    }),
    /** One script's lines from a `script.output` batch, added in one update (KERNEL-216). */
    appendScript: (workspaceId: string, kind: ScriptKind, name: string | undefined, lines: Pick<ScriptLine, 'line' | 'stream'>[]) =>
      setState((s) => ({ scripts: { ...s.scripts, [workspaceId]: keepLines(s.scripts[workspaceId] ?? [], kind, name, lines) } })),
    /** One script's terminal output from a `script.data` batch, trimmed the way main trims it (KERNEL-655). */
    appendScriptData: (workspaceId: string, kind: ScriptKind, name: string | undefined, data: string) => setState((s) => {
      const k = scriptKey(kind, name)
      return { scriptData: { ...s.scriptData, [workspaceId]: { ...s.scriptData[workspaceId], [k]: keepData(s.scriptData[workspaceId]?.[k], data) } } }
    }),
    /** Main's copy of the workspace's scripts, in place of the window's: a window that just loaded missed what came before (KERNEL-340). */
    setScripts: (workspaceId: string, lines: ScriptLine[], exit: Record<string, number | null>, url: Record<string, string>, data: Record<string, string>) => setState((s) => ({
      scripts: { ...s.scripts, [workspaceId]: lines },
      scriptExit: { ...s.scriptExit, [workspaceId]: exit },
      scriptUrl: { ...s.scriptUrl, [workspaceId]: url },
      scriptData: { ...s.scriptData, [workspaceId]: Object.fromEntries(Object.entries(data).map(([k, d]) => [k, d.slice(-TERMINAL_KEEP)])) },
      scriptReplays: { ...s.scriptReplays, [workspaceId]: (s.scriptReplays[workspaceId] ?? 0) + 1 }
    })),
    scriptExited: (workspaceId: string, kind: ScriptKind, name: string | undefined, code: number | null) => setState((s) => ({ scriptExit: { ...s.scriptExit, [workspaceId]: { ...s.scriptExit[workspaceId], [scriptKey(kind, name)]: code } } })),
    /** The URL a run script printed, or null when the push says the run started again or exited. */
    setScriptUrl: (workspaceId: string, name: string, url: string | null) => setState((s) => {
      const { [name]: _gone, ...rest } = s.scriptUrl[workspaceId] ?? {}
      return { scriptUrl: { ...s.scriptUrl, [workspaceId]: url ? { ...rest, [name]: url } : rest } }
    }),
    /** A new run starts clean, so the last exit code no longer says it stopped. */
    clearScriptExit: (workspaceId: string, kind: ScriptKind, name?: string) => setState((s) => ({ scriptExit: { ...s.scriptExit, [workspaceId]: { ...s.scriptExit[workspaceId], [scriptKey(kind, name)]: undefined } } })),
    setCheckpoints: (workspaceId: string, list: Checkpoint[]) => setState((s) => ({ checkpoints: { ...s.checkpoints, [workspaceId]: list } })),
    /** Only one checkpoint is where the worktree is now, so a new current one clears the flag on the rest. */
    upsertCheckpoint: (c: Checkpoint) => setState((s) => {
      const list = (s.checkpoints[c.workspaceId] ?? []).map((x) => (c.current && x.current && x.id !== c.id ? { ...x, current: false } : x))
      return { checkpoints: { ...s.checkpoints, [c.workspaceId]: upsert(list, c) } }
    })
  },
  chats: {
    set: (workspaceId: string, list: Chat[]) => { loadedChats.add(workspaceId); setState((s) => ({ chats: { ...s.chats, [workspaceId]: list } })) },
    upsert: (chat: Chat) => setState((s) => ({
      chats: { ...s.chats, [chat.workspaceId]: upsert(s.chats[chat.workspaceId] ?? [], chat) },
      // A chat that appears in a workspace whose chats are loaded was created now, so it has no history to wait for.
      ...(s.itemsLoaded[chat.id] === undefined && loadedChats.has(chat.workspaceId) && !s.chats[chat.workspaceId]?.some((c) => c.id === chat.id) ? { itemsLoaded: { ...s.itemsLoaded, [chat.id]: true } } : {})
    })),
    setItems: (chatId: string, list: ChatItem[]) => setState((s) => ({ items: { ...s.items, [chatId]: list }, itemsLoaded: { ...s.itemsLoaded, [chatId]: true }, itemsFailed: omit(s.itemsFailed, [chatId]) })),
    failItems: (chatId: string) => setState((s) => ({ itemsFailed: { ...s.itemsFailed, [chatId]: true } })),
    upsertItem: (chatId: string, item: ChatItem) => setState((s) => ({ items: { ...s.items, [chatId]: upsert(s.items[chatId] ?? [], item) } })),
    /** Takes an item out when it is still `item` itself: a row the engine has since replaced by id stays. For an optimistic row whose call failed. */
    dropItem: (chatId: string, item: ChatItem) => setState((s) => (s.items[chatId]?.includes(item) ? { items: { ...s.items, [chatId]: s.items[chatId].filter((i) => i !== item) } } : s)),
    setRunning: (chatId: string, running: boolean) => setState((s) => ({ running: { ...s.running, [chatId]: running }, assumed: omit(s.assumed, [chatId]) })),
    /**
     * What a user action draws in one render (KERNEL-895): a row in the chat, the queue with its message, and whether the chat is running, so the bubble, the tray and the Working line
     * arrive together. Main confirms each in place, by the row's id and by `chat.running`, and never redraws it.
     */
    draw: (chatId: string, d: { item?: ChatItem; queue?: QueuedMessage[]; why?: QueueReason | null; running?: boolean }) => setState((s) => {
      const out: Partial<State> = {}
      if (d.item) out.items = { ...s.items, [chatId]: upsert(s.items[chatId] ?? [], d.item) }
      if (d.queue) {
        const queueWhy = { ...s.queueWhy }
        if (!d.queue.length || d.why === null) delete queueWhy[chatId]
        else if (d.why) queueWhy[chatId] = d.why
        out.queue = { ...s.queue, [chatId]: d.queue }
        out.queueWhy = queueWhy
      }
      if (d.running !== undefined && s.running[chatId] !== d.running) { out.running = { ...s.running, [chatId]: d.running }; out.assumed = { ...s.assumed, [chatId]: true } }
      return out
    }),
    /** The state a call that failed, or did something else, leaves behind: the row (only while it is still the one drawn, so an engine row that replaced it stays), the queued message by id, and a running state main never confirmed. */
    undraw: (chatId: string, d: { item?: ChatItem; queued?: string; running?: boolean }) => setState((s) => {
      const out: Partial<State> = {}
      if (d.item && s.items[chatId]?.includes(d.item)) out.items = { ...s.items, [chatId]: s.items[chatId].filter((i) => i !== d.item) }
      if (d.queued && s.queue[chatId]?.some((q) => q.id === d.queued)) {
        const list = s.queue[chatId].filter((q) => q.id !== d.queued)
        const queueWhy = { ...s.queueWhy }
        if (!list.length) delete queueWhy[chatId]
        out.queue = { ...s.queue, [chatId]: list }
        out.queueWhy = queueWhy
      }
      if (d.running !== undefined && s.assumed[chatId]) { out.running = { ...s.running, [chatId]: d.running }; out.assumed = omit(s.assumed, [chatId]) }
      return out
    }),
    /** A `chat.queue` event passes its reason, or null when nothing holds the queue. A list handed back by a call passes none (undefined), so the last reason stays until the next event. An empty queue has none. */
    setQueue: (chatId: string, list: QueuedMessage[], why?: QueueReason | null) => setState((s) => {
      const queueWhy = { ...s.queueWhy }
      if (!list.length || why === null) delete queueWhy[chatId]
      else if (why) queueWhy[chatId] = why
      return { queue: { ...s.queue, [chatId]: list }, queueWhy }
    }),
    setQueueWhy: (chatId: string, why: QueueReason) => setState((s) => ({ queueWhy: { ...s.queueWhy, [chatId]: why } })),
    setRunMode: (chatId: string, mode: ChatRunMode) => setState((s) => ({ runModes: { ...s.runModes, [chatId]: mode } })),
    appendTerminal: (chatId: string, data: string) => setState((s) => ({ terminal: { ...s.terminal, [chatId]: ((s.terminal[chatId] ?? '') + data).slice(-TERMINAL_KEEP) } })),
    /** Main's copy of a terminal's output, in place of the window's (KERNEL-340). */
    replaceTerminal: (chatId: string, data: string) => setState((s) => ({
      terminal: { ...s.terminal, [chatId]: data.slice(-TERMINAL_KEEP) },
      terminalReplays: { ...s.terminalReplays, [chatId]: (s.terminalReplays[chatId] ?? 0) + 1 }
    })),
    setRetry: (chatId: string, retry: State['retry'][string] | null) => setState((s) => {
      const next = { ...s.retry }
      if (retry) next[chatId] = retry
      else delete next[chatId]
      return { retry: next }
    })
  },
  approvals: {
    set: (list: Approval[]) => setState({ approvals: byRecent(list) }),
    upsert: (a: Approval) => setState((s) => ({ approvals: byRecent(upsert(s.approvals, a)) }))
  },
  threads: {
    set: (list: Thread[]) => setState({ threads: Object.fromEntries(list.map((t) => [t.id, t])) }),
    upsert: (thread: Thread) => {
      setState((s) => ({ threads: { ...s.threads, [thread.id]: thread } }))
      // A closed chat has no tab to reopen on, and a new tab reopens it with a fresh entry.
      if (thread.closedAt) dropLastTabs((id) => id === thread.id)
    }
  },
  tasks: {
    set: (projectId: string, list: Task[]) => setState((s) => ({ tasks: { ...s.tasks, [projectId]: list } })),
    upsert: (t: Task) => setState((s) => ({ tasks: { ...s.tasks, [t.projectId]: upsert(s.tasks[t.projectId] ?? [], t) } }))
  },
  activity: {
    set: (list: ActivityEvent[]) => setState({ activity: list }),
    /** Also moves the agent's last activity forward, which outlasts the 200-event window. */
    add: (e: ActivityEvent) => setState((s) => ({
      activity: [e, ...s.activity].slice(0, 200),
      lastActivity: e.projectId && e.agentId ? newer(s.lastActivity, e.projectId, { [e.agentId]: e.ts }) : s.lastActivity
    })),
    /** A project's last activity by agent from `projects.lastActivity`. Keeps any newer time an event already brought in. */
    setLast: (projectId: string, times: Record<string, number>) => setState((s) => ({ lastActivity: newer(s.lastActivity, projectId, times) }))
  },
  notifications: {
    set: (list: Notification[]) => setState({ notifications: byRecent(list) }),
    upsert: (n: Notification) => setState((s) => ({ notifications: byRecent(upsert(s.notifications, n)) })),
    remove: (ids: string[]) => setState((s) => ({ notifications: s.notifications.filter((n) => !ids.includes(n.id)) }))
  },
  prs: {
    set: (info: PrInfo) => setState((s) => ({ prs: { ...s.prs, [info.workspaceId]: info } })),
    setState: (workspaceId: string, prState: Workspace['prState']) => setState((s) => ({ workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, prState } : w)) })),
    /** A PR action started, or ended with no `action`. */
    setPending: (workspaceId: string, action?: PrPending) => setState((s) => {
      const { [workspaceId]: _p, ...rest } = s.prPending
      return { prPending: action ? { ...rest, [workspaceId]: action } : rest }
    })
  },
  usage: {
    set: (limits: RateLimit[]) => setState({ usage: limits })
  },
  account: {
    set: (account: ClaudeAccount) => setState({ account })
  },
  accounts: {
    set: (accounts: AccountProfile[]) => setState({ accounts }),
    adding: (accountAdd: AccountAddStep | null) => setState({ accountAdd }),
    /**
     * The one way every switch starts. It switches at once (KERNEL-941): chats stay on the account that holds their cache while
     * it can run them, and move by the policy in Settings, Accounts when it can't. `onSwitched` runs once the switch is done. A
     * failed switch throws, so each entry point keeps its own error toast.
     */
    requestSwitch: (provider: Provider, accountId: string, opts: { reason?: 'banner'; onSwitched?: () => void } = {}) =>
      performSwitch(provider, accountId, opts.reason, opts.onSwitched),
    mcpRun: (run: McpSignInAll) => setState((s) => ({ mcpRuns: { ...s.mcpRuns, [mcpRunKey(run.provider ?? 'claude', run.accountId)]: run } })),
    clearMcpRun: (provider: Provider, accountId: string) => setState(({ mcpRuns: { [mcpRunKey(provider, accountId)]: _gone, ...mcpRuns } }) => ({ mcpRuns }))
  },
  shared: {
    set: (list: SharedFile[]) => setState({ shared: Object.fromEntries(list.map((f) => [f.id, f])) }),
    upsert: (file: SharedFile) => setState((s) => ({ shared: { ...s.shared, [file.id]: file } }))
  },
  settings: {
    set: (settings: AppSettings) => setState({ settings }),
    setProject: (projectId: string, rs: ProjectSettings) => setState((s) => ({ projectSettings: { ...s.projectSettings, [projectId]: rs } }))
  },
  system: {
    booted: () => setState((s) => ({ system: { ...s.system, booted: true } })),
    setOnline: (online: boolean) => setState((s) => ({ system: { ...s.system, online } })),
    setPreflight: (preflight: PreflightCheck[]) => setState((s) => ({ system: { ...s.system, preflight } })),
    setHooks: (hooks: HookStatus) => setState((s) => ({ system: { ...s.system, hooks } })),
    setGitHub: (github: GitHubStatus) => setState((s) => ({ system: { ...s.system, github } })),
    setUpdate: (update: AppUpdate) => setState((s) => ({ system: { ...s.system, update } }))
  }
}

/** Navigate. Shortcut for `actions.ui.go`. */
export const go = actions.ui.go

/** Settings, MCP servers on one account's tab. */
export function mcpRoute(provider: Provider, accountId: string): Route {
  return { name: 'settings', page: 'mcp', tab: provider, account: accountId }
}

/** "3 MCP servers need you", the words the Providers row, the notice after adding an account and the MCP servers page share. */
export const mcpNeedYou = (n: number) => `${n} MCP server${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you`

/** The notice after adding an account whose MCP servers need the user. Its action opens the Set up this account checklist. */
async function mcpNeededToast(n: McpNeeded) {
  const count = await call('mcp.accounts', undefined).then((all) => all.find((a) => a.provider === n.provider && a.accountId === n.accountId)?.needsYou).catch(() => undefined)
  actions.ui.toast({ title: mcpNeedYou(count || n.servers.length), action: { label: 'Set up', modal: { name: 'mcpSetUp', provider: n.provider, accountId: n.accountId } } })
}

let switchToastId: string | undefined

/**
 * One notice for each switch Kernel makes by itself, with Undo back to the account it left. The user's own switches say nothing:
 * the account menu already shows where they went (KERNEL-941). A newer switch replaces the last notice, so Undo always reverses
 * the latest one. `accounts` arrives before this event, so the names are current (KERNEL-699).
 */
function accountSwitchedToast(e: Extract<PushEvent, { type: 'accountSwitched' }>) {
  if (e.reason !== 'limit') return
  const accounts = getState().accounts
  const name = (id: string) => accounts.find((a) => a.provider === e.provider && a.id === id)?.label ?? 'another account'
  const provider = PROVIDERS.find((p) => p.id === e.provider)?.label ?? e.provider
  // A switch ahead of a limit has no window that was hit (KERNEL-844).
  const why = e.limit === 'five_hour' ? 'hit its 5-hour limit' : e.limit ? 'hit its weekly limit' : 'is close to its limit'
  const title = `Kernel switched ${provider} to ${name(e.to)}, ${name(e.from)} ${why}`
  if (switchToastId) actions.ui.dismissToast(switchToastId)
  switchToastId = actions.ui.toast({ title, action: { label: 'Undo', switchAccount: { provider: e.provider, accountId: e.from } } })
}

let burst: PushEvent[] | undefined

/**
 * A queued message that posts is three events sent together: the tray loses it (`chat.queue`), its row arrives (`chat.item`) and the chat runs (`chat.running`). Each
 * is its own message from main, so each could draw in a frame of its own. A `chat.queue` or a turn ending (`chat.running` false, which Send now follows with the next message) opens a burst that takes what follows, in order, and draws it as one (KERNEL-895).
 */
function applyTogether(e: PushEvent) {
  if (burst) { burst.push(e); return }
  if (e.type !== 'chat.queue' && !(e.type === 'chat.running' && !e.running)) return apply(e)
  const mine = (burst = [e])
  setTimeout(() => {
    if (burst === mine) burst = undefined
    for (const x of mine) apply(x)
  }, 0)
}

/** Apply one push event from main. Exported for tests and fixtures. */
export function apply(e: PushEvent) {
  switch (e.type) {
    case 'activity': return actions.activity.add(e.event)
    case 'chat': return actions.chats.upsert(e.chat)
    case 'chat.item': return actions.chats.upsertItem(e.chatId, e.item)
    case 'chat.cleared': return actions.chats.setItems(e.chatId, [])
    case 'chat.running': pushedLive?.running.add(e.chatId); return actions.chats.setRunning(e.chatId, e.running)
    case 'chat.queue': return actions.chats.setQueue(e.chatId, e.queue, e.why ?? null)
    case 'chat.runMode': return actions.chats.setRunMode(e.chatId, e.mode)
    case 'terminal.data': return e.replace ? actions.chats.replaceTerminal(e.chatId, e.data) : actions.chats.appendTerminal(e.chatId, e.data)
    case 'retry': pushedLive?.retry.add(e.chatId); return actions.chats.setRetry(e.chatId, e.retry)
    case 'approval': return actions.approvals.upsert(e.approval)
    case 'project': return actions.projects.upsert(e.project)
    case 'project.setup': return actions.projects.setSetup(e.projectId, e.steps)
    case 'overlap': return actions.projects.upsertOverlap(e.overlap)
    case 'agents': return actions.agents.set(e.projectId, e.agents)
    case 'globalAgents': return actions.agents.setGlobal(e.agents)
    case 'agent.status': return actions.agents.setStatus(e.projectId, e.agentId, e.status)
    case 'workspace': return actions.workspaces.upsert(e.workspace)
    case 'script.output': return actions.workspaces.appendScript(e.workspaceId, e.kind, e.name, e.lines)
    case 'script.data': return actions.workspaces.appendScriptData(e.workspaceId, e.kind, e.name, e.data)
    case 'script.exit': return actions.workspaces.scriptExited(e.workspaceId, e.kind, e.name, e.code)
    case 'script.url': return actions.workspaces.setScriptUrl(e.workspaceId, e.name, e.url)
    case 'script.state': return actions.workspaces.setScripts(e.workspaceId, e.lines, e.exit, e.url, e.data)
    case 'checkpoint': return actions.workspaces.upsertCheckpoint(e.checkpoint)
    case 'task': return actions.tasks.upsert(e.task)
    case 'notification': return actions.notifications.upsert(e.notification)
    case 'notification.removed': return actions.notifications.remove(e.ids)
    case 'usage': return actions.usage.set(e.limits)
    case 'pr': return actions.prs.setState(e.workspaceId, e.state)
    case 'pr.info': return actions.prs.set(e.info)
    case 'pr.pending': pushedPending?.add(e.workspaceId); return actions.prs.setPending(e.workspaceId, e.action)
    case 'thread': return actions.threads.upsert(e.thread)
    case 'shared': return actions.shared.upsert(e.file)
    case 'hooks': return actions.system.setHooks(e.status)
    case 'github': return actions.system.setGitHub(e.status)
    case 'update': return actions.system.setUpdate(e.update)
    case 'account': return actions.account.set(e.account)
    case 'accounts': return actions.accounts.set(e.accounts)
    case 'accountSwitched': return accountSwitchedToast(e)
    case 'account.add': return actions.accounts.adding(e.add)
    case 'account.mcpSignInAll': return actions.accounts.mcpRun(e.run)
    case 'account.mcpNeeded': return mcpNeededToast(e.needed)
    case 'online': return actions.system.setOnline(e.online)
    case 'settings.projectChanged': return actions.settings.setProject(e.projectId, e.settings)
    case 'toast': return void actions.ui.toast(e.toast)
  }
}

/**
 * Load everything once, then stay live on push events. Only built channels load here; a lane that builds
 * a channel adds its first load (for example `tasks.list` in loadProject) in the same PR.
 */
let listening = false

export async function boot() {
  if (!listening) { listening = true; onPush(applyTogether) }
  try { await start() } catch (e) { actions.ui.setStartError(cleanError(e)) }
}

/** Loads what the first screen needs and picks it. A failure here leaves `booted` unset and lands in `boot`'s catch, which Loading shows. */
async function start() {
  // Which chats are working, asked once. Pushes only report changes, so without it every agent working while the window
  // loaded would look stopped until its turn ended (KERNEL-340). An older main (a dev build mid-pull) has no such channel.
  pushedLive = { running: new Set(), retry: new Set() }
  void call('chats.live', undefined).then(applyLive, () => applyLive(null))
  // A PR action that started before this window loaded has no push to learn it from (KERNEL-519). An older main has no such channel.
  pushedPending = new Set()
  void call('pr.pendingAll', {}).then(applyPending, () => applyPending(null))
  const [projects, workspaces, approvals, notifications, activity, usage, settings, fixture, shared, threads] = await Promise.all([
    call('projects.list', undefined), call('workspaces.list', {}), call('approvals.list', {}), call('notifications.list', undefined), call('activity.recent', { limit: 100 }), call('usage.get', undefined),
    call('settings.get', undefined), call('system.fixture', undefined),
    // Cards and the Shared panel read these. A failed load only leaves them out until a push brings a file in.
    call('shared.list', {}).catch((): SharedFile[] => []),
    // The sidebar lists Lead chats from these. A failed load leaves the rows to the tabs alone until a push brings a thread in.
    call('threads.list', {}).catch((): Thread[] => [])
  ])
  fixtureMode = !!fixture
  fixturePersist = !!fixture?.persist
  // A retry that works drops the error here, so the error screen keeps its busy button until the lists are in.
  actions.ui.setStartError(undefined)
  setState({ projects, workspaces, approvals: byRecent(approvals), notifications: byRecent(notifications), activity, usage, settings, shared: Object.fromEntries(shared.map((f) => [f.id, f])), threads: Object.fromEntries(threads.map((t) => [t.id, t])) })
  // Last tabs of chats closed since, or gone, would otherwise pile up in localStorage. A failed load leaves no threads to judge them by.
  if (threads.length) dropLastTabs((id) => !state.threads[id] || !!state.threads[id].closedAt)
  // The footer and the account menu read these. Neither blocks the first paint, and a failure leaves them empty.
  void call('account.get', undefined).then(actions.account.set).catch(() => undefined)
  void call('accounts.list', undefined).then(actions.accounts.set).catch(() => undefined)
  void call('hooks.status', undefined).then(actions.system.setHooks).catch(() => undefined)
  void call('github.status', undefined).then(actions.system.setGitHub).catch(() => undefined)
  const update = call('update.get', undefined).then((u) => { actions.system.setUpdate(u); return u }).catch(() => null)
  // Chosen before the branches below, so a launch that stops at the checks still has its tabs back, and the first move after the checks
  // can't save an empty tab list over them. Continue on the checks screen asks again and lands on the same place.
  const opening = launchRoute()
  // A fresh install starts at the splash, which opens New chat when its wordmark has settled (KERNEL-942).
  // Replace, so Back right after launch has nowhere to go.
  const replace = { history: 'replace' } as const
  if (!projects.length) go({ name: 'onboarding', step: 'splash' }, replace)
  else go(opening, replace)
  for (const r of projects) void loadProject(r.id).catch(() => undefined)
  actions.system.booted()
  if (fixture) applyFixture(fixture.ui, fixture.push)
  // The checks rerun on every launch, after the app is up: they run claude and gh one after another and can take a while on a slow Mac.
  // They never take the screen (KERNEL-942). A blocking failure shows above New chat's box with its fix, and a launch that opens
  // somewhere else hears about it in a toast.
  void call('preflight.run', undefined).then((checks) => {
    actions.system.setPreflight(checks)
    const blocking = checks.find((c) => !c.ok && c.blocking)
    if (blocking && projects.length && state.ui.route.name !== 'leadNew') actions.ui.toast({ title: blocking.title, sub: 'New chat shows how to fix it.' })
  }).catch(() => undefined)
  // After an update installs, What's new opens once with that version's notes (KERNEL-30). It waits for the route above, which closes modals,
  // and carries its own copy, since the updater's first check pushes a new state that drops `installed` and the notes.
  void update.then((u) => { if (u?.installed) actions.ui.openModal({ name: 'whatsNew', update: u }) })
}

/** Chats a `chat.running` or `retry` push reached while `chats.live` was out. The push came later, so it wins. */
let pushedLive: { running: Set<string>; retry: Set<string> } | undefined

function applyLive(live: KernelApi['chats.live']['res'] | null) {
  const pushed = pushedLive
  pushedLive = undefined
  if (!live || !pushed) return
  setState((s) => ({
    running: { ...Object.fromEntries(live.running.filter((id) => !pushed.running.has(id)).map((id) => [id, true])), ...s.running },
    retry: { ...Object.fromEntries(Object.entries(live.retry).filter(([id]) => !pushed.retry.has(id))), ...s.retry }
  }))
}

/** Workspaces a `pr.pending` push reached while `pr.pendingAll` was out. The push came later, so it wins. */
let pushedPending: Set<string> | undefined

function applyPending(all: Record<string, PrPending> | null) {
  const pushed = pushedPending
  pushedPending = undefined
  if (!all || !pushed) return
  setState((s) => ({ prPending: { ...Object.fromEntries(Object.entries(all).filter(([id]) => !pushed.has(id))), ...s.prPending } }))
}

/**
 * Where the app opens once the checks pass: `boot` goes there, and so does Continue on the checks screen (call it with `go(..., { history: 'replace' })`),
 * so the two can't drift. Settings > General > Open to picks it. Where I left off reopens the saved place and brings back the tabs
 * of its workspaces that are still live (a tab already open wins, so asking twice changes nothing). Without a saved place (a first launch,
 * unreadable JSON, fixture mode) it opens the last project's Lead chat, found the way the sidebar does (the `lead` workspace on the main
 * checkout), since agents load after this. A project nobody has briefed opens its Agents page in Settings (D-104, KERNEL-642). Also the route Settings falls back to (`launch`).
 */
export function launchRoute(): Route {
  const openTo = state.settings?.general.openTo
  let route: Route = landing(state, lastProject() ?? undefined)
  if (openTo === 'inbox') route = { name: 'inbox' }
  else if (openTo === 'lastPlace') {
    const restored = fixtureMode ? undefined : restorePlace(savedPlace(), state)
    const last = state.projects.find((r) => r.id === lastProject())
    if (restored) {
      setState((s) => ({ ui: { ...s.ui, tabs: { ...restored.tabs, ...s.ui.tabs } } }))
      route = restored.route
    } else if (last) route = nearest(projectHome(last.id, state), state)
  }
  return launch = route
}

/** Fixture mode: force the screen, replay its push events, then tell the screenshot harness it can capture. */
function applyFixture(ui: ForcedUi, push: PushEvent[]) {
  setState((s) => ({ ui: { ...s.ui, ...ui, modal: ui.modal ?? null, workspace: { ...s.ui.workspace, ...ui.workspace }, tabs: { ...s.ui.tabs, ...ui.tabs } } }))
  // useAppearance applies settings.appearance.theme, so a fixture's theme goes there too or it would be painted over.
  if (ui.theme) setState((s) => (s.settings ? { settings: { ...s.settings, appearance: { ...s.settings.appearance, theme: ui.theme! } } } : {}))
  push.forEach(apply)
  if (ui.theme) document.documentElement.dataset.theme = ui.theme
  document.documentElement.dataset.fixture = 'ready'
}

export async function loadProject(projectId: string) {
  const [agents, status, tasks, last] = await Promise.all([
    call('agents.list', { projectId }), call('agents.status', { projectId }), call('tasks.list', { projectId }), call('projects.lastActivity', { projectId })
  ])
  actions.tasks.set(projectId, tasks)
  actions.activity.setLast(projectId, last)
  setState((s) => ({ agents: { ...s.agents, [projectId]: agents }, status: { ...s.status, [projectId]: { ...status, ...(s.status[projectId] ?? {}) } } }))
  // The Inbox lists open overlaps (D-104). Pushes keep them current after this; a failed check only leaves them out.
  void call('projects.overlaps', { projectId }).then((list) => actions.projects.setOverlaps(projectId, list)).catch(() => undefined)
}

/**
 * Workspaces and terminals whose output this window has asked main for. Once is enough: from then on every line reaches
 * the store as it is printed, open or not (KERNEL-340).
 */
const replayedScripts = new Set<string>()
const replayedTerminals = new Set<string>()

/** Asks main for the terminal's output so far, the first time this window shows it. Its answer arrives as a `terminal.data` push. */
export function replayTerminal(id: string) {
  if (replayedTerminals.has(id)) return
  replayedTerminals.add(id)
  void call('terminal.replay', { chatId: id }).catch(() => { replayedTerminals.delete(id) })
}

/** Switches a chat with Kernel to Hand off or Build here (KERNEL-770). The saved workspace replaces the store's copy, so the composer chip and the right panel follow at once. */
export async function setLeadMode(workspaceId: string, mode: LeadMode) {
  const ws = await call('lead.setMode', { workspaceId, mode })
  actions.workspaces.upsert(ws)
  return ws
}

export async function loadWorkspace(workspaceId: string) {
  if (!replayedScripts.has(workspaceId)) {
    replayedScripts.add(workspaceId)
    void call('scripts.replay', { workspaceId }).catch(() => { replayedScripts.delete(workspaceId) })
  }
  const chats = await call('chats.list', { workspaceId })
  actions.chats.set(workspaceId, chats)
  // One chat failing to load must not hold back the others. The failed one shows Try again (KERNEL-860).
  for (const c of chats) {
    try { actions.chats.setItems(c.id, await call('chats.items', { chatId: c.id })) } catch { actions.chats.failItems(c.id) }
  }
  return chats
}

export const pending = (s: State) => s.approvals.filter((a) => a.status === 'pending')
