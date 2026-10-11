import { useRef, useSyncExternalStore } from 'react'
import type {
  ActivityEvent, AgentDef, AgentStatus, AppSettings, AppUpdate, Approval, Banner, Chat, ChatItem, Checkpoint, ClaudeAccount,
  ForcedUi, HookStatus, MenuId, Modal, Notification, Overlap, PreflightCheck, PrInfo, QueuedMessage, QueueReason, QuickAskState, RateLimit, Room, RoomSettings,
  RoomSettingsSection, RoomSetupStep, Route, ScriptKind, ScriptTrust, SettingsPage, ScriptLine, SharedFile, Task, Theme, Thread, Toast, UiState, Workspace, WorkspaceTabs, WorkspaceView
} from '@shared/types'
import type { KernelApi, PushEvent, Retry } from '@shared/ipc'
import { keepLines, scriptKey, TERMINAL_KEEP } from '@shared/scriptLog'
import { call, cleanError, onPush } from './api'
import { hasTab, isChatTab, nearest, placeToSave, restorePlace, roomHome, samePlace, stillThere, tabOf, type Place } from './nav'

export type { Modal, Route }
export { scriptKey }

/**
 * The renderer's state: one top-level key per domain, plus `ui`. Keys stay flat so selectors read `s.rooms`, `s.items[chatId]`.
 * Write through `actions` (typed, one group per slice) or push events; `setState` is the escape hatch.
 */
export interface State {
  // rooms
  rooms: Room[]
  /** By room id. Progress of a room being set up (RoomSetup.png). */
  roomSetup: Record<string, RoomSetupStep[]>
  /** By room id. The scripts and files.copy list a room waits on the user to trust. A room with nothing to trust has no entry (KERNEL-218). */
  scriptTrust: Record<string, ScriptTrust>
  /** By room id. */
  overlaps: Record<string, Overlap[]>
  // agents
  /** By room id. */
  agents: Record<string, AgentDef[]>
  /** By room id, then agent id. */
  status: Record<string, Record<string, AgentStatus>>
  /** By agent id. The latest "what I'm doing" line for the floor tag and bubble. */
  saying: Record<string, string>
  // workspaces
  workspaces: Workspace[]
  /** By workspace id. Lines carry the run script's `name`, and each script keeps its own last 400. */
  scripts: Record<string, ScriptLine[]>
  /** By workspace id, then `scriptKey`. Exit code of the last run of each script. */
  scriptExit: Record<string, Record<string, number | null | undefined>>
  /** By workspace id, then run script name. The first local URL the script printed, while it runs (`script.url`, KERNEL-246). */
  scriptUrl: Record<string, Record<string, string>>
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
  /** By chat id. */
  running: Record<string, boolean>
  /** By chat id. */
  queue: Record<string, QueuedMessage[]>
  /** By chat id. What the queue waits for, absent while it is empty (KERNEL-273). */
  queueWhy: Record<string, QueueReason>
  /** By chat id. Raw pty output for terminal chats. */
  terminal: Record<string, string>
  /** By chat id. How many times main's copy replaced `terminal`, so an open terminal knows to draw it again from the top (KERNEL-340). */
  terminalReplays: Record<string, number>
  /** By chat id. Set while Claude is overloaded and the session retries. */
  retry: Record<string, Retry>
  // approvals, tasks, activity, notifications
  approvals: Approval[]
  /** By room id. */
  tasks: Record<string, Task[]>
  activity: ActivityEvent[]
  /** By room id, then agent id. When each agent's newest event in the room happened, from the whole log rather than the `activity` window. */
  lastActivity: Record<string, Record<string, number>>
  notifications: Notification[]
  // pull requests
  /** By workspace id. */
  prs: Record<string, PrInfo>
  // usage, account, settings, system
  usage: RateLimit[]
  account: ClaudeAccount | null
  settings: AppSettings | null
  /** By room id. */
  roomSettings: Record<string, RoomSettings>
  /** By shared id. Every file agents shared, from `shared.list` and the `shared` push (KERNEL-305). */
  shared: Record<string, SharedFile>
  system: { booted: boolean; online: boolean; preflight: PreflightCheck[] | null; hooks: HookStatus | null; update: AppUpdate | null }
  /** By room id. The Ask Rowan popover's draft and last question, kept while it is closed. */
  quickAsk: Record<string, QuickAskState>
  ui: UiState
}

/** The Changes tab's list or tree, kept across launches like the panel toggles (KERNEL-399). localStorage may be missing or blocked. */
const CHANGES_VIEW = 'kernel.changesView'
function changesView(): 'list' | 'tree' {
  try { return localStorage.getItem(CHANGES_VIEW) === 'tree' ? 'tree' : 'list' } catch { return 'list' }
}

const workspaceView: WorkspaceView = { right: 'changes', leadRight: 'prs', bottom: 'run', checkpoints: false, toolsOpen: false, changesView: changesView() }

/** The sidebar and right panel toggles outlast a restart. A key is stored only while its panel is hidden, and localStorage may be missing or blocked. */
const HIDDEN = { sidebar: 'kernel.sidebarHidden', rightPanel: 'kernel.rightPanelHidden' } as const
function showing(panel: keyof typeof HIDDEN) {
  try { return localStorage.getItem(HIDDEN[panel]) !== '1' } catch { return true }
}
function keep(panel: keyof typeof HIDDEN, open: boolean) {
  try { if (open) localStorage.removeItem(HIDDEN[panel]); else localStorage.setItem(HIDDEN[panel], '1') } catch { /* not remembered */ }
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
  rooms: [], roomSetup: {}, scriptTrust: {}, overlaps: {},
  agents: {}, status: {}, saying: {},
  workspaces: [], scripts: {}, scriptExit: {}, scriptUrl: {}, checkpoints: {},
  chats: {}, threads: {}, lastThread: {}, lastTabs: lastTabs(), items: {}, running: {}, queue: {}, queueWhy: {}, terminal: {}, terminalReplays: {}, retry: {},
  approvals: [], tasks: {}, activity: [], lastActivity: {}, notifications: [],
  prs: {},
  usage: [], account: null, settings: null, roomSettings: {}, shared: {},
  system: { booted: false, online: true, preflight: null, hooks: null, update: null },
  quickAsk: {},
  ui: { route: { name: 'home' }, modal: null, menu: null, toasts: [], banner: null, theme: 'dark', workspace: workspaceView, tabs: {}, foldedChats: foldedChats(), sidebar: showing('sidebar'), rightPanel: showing('rightPanel') }
}
const listeners = new Set<() => void>()

export function getState() { return state }
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
/** `all` with each of `times` written into the room's entry when it is later than what is there. Unchanged rooms keep their identity. */
function newer(all: State['lastActivity'], roomId: string, times: Record<string, number>): State['lastActivity'] {
  const room = all[roomId] ?? {}
  const later = Object.entries(times).filter(([id, ts]) => ts > (room[id] ?? -Infinity))
  return later.length ? { ...all, [roomId]: { ...room, ...Object.fromEntries(later) } } : all
}
/** Settings > General > Last room: the room whose floor, board, team or workspace was open last. localStorage may be missing or blocked, so every access is guarded. */
const LAST_ROOM = 'kernel.lastRoom'
function rememberRoom(route: Route) {
  const id = 'roomId' in route && route.roomId ? route.roomId : route.name === 'workspace' ? state.workspaces.find((w) => w.id === route.workspaceId)?.roomId : undefined
  if (!id || route.name === 'settings') return
  try { localStorage.setItem(LAST_ROOM, id) } catch { /* not remembered */ }
}
export function lastRoom(): string | null {
  try { return localStorage.getItem(LAST_ROOM) } catch { return null }
}
const emptyTabs: WorkspaceTabs = { files: [], diffs: [], shared: [] }
/** `tabs` with `tab` selected. A chat id also becomes `lastChat`; a file, diff or shared tab joins the open ones. */
function withTab(tabs: WorkspaceTabs | undefined, tab: string): WorkspaceTabs {
  const t = { ...emptyTabs, ...tabs, tab }
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
let lastSettings: { page: SettingsPage; roomId?: string; section?: RoomSettingsSection } | undefined
let launch: Route = { name: 'home' }
/**
 * The place a relaunch reopens (KERNEL-201), kept in localStorage like the other `kernel.*` keys, which may be missing or blocked.
 * Nothing is written before the first route is chosen (`system.booted`), so a restore never overwrites what it read, and none in fixture mode.
 */
const LAST_PLACE = 'kernel.lastPlace'
let fixtureMode = false
/** Fixture mode runs on a shared folder of its own and must neither read nor write what a real launch saved. */
export const isFixture = () => fixtureMode
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
  if (to.route.name === 'settings') {
    if (from.route.name !== 'settings') returnTo = from
    lastSettings = { page: to.route.page, ...(to.route.roomId ? { roomId: to.route.roomId } : {}), ...(to.route.section ? { section: to.route.section } : {}) }
  }
  // Callers apply the move before calling this, so the state is already `to` with its tabs. Saved ahead of the history block, which returns early, and for Back and Forward too.
  savePlace()
  if (history === 'none' || samePlace(from, to)) return
  // Onboarding and the dev pages are not somewhere to come back to, and nor is a page of Settings once you are in Settings.
  const quiet = to.route.name === 'onboarding' || to.route.name === 'devUi' || from.route.name === 'onboarding' || (from.route.name === 'settings' && to.route.name === 'settings')
  if (history === 'replace' || quiet) return
  past = capped([...past, from])
  future = []
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
  if (!taken) { if (dir === 'back') past = []; else future = []; return false }
  const other = capped([...(dir === 'back' ? future : past), now])
  if (dir === 'back') { past = taken.rest; future = other } else { future = taken.rest; past = other }
  arrive(taken.entry)
  return true
}
/** Is there a place Back or Forward would reach. */
export const canBack = () => takeNewest(past, leaving()) !== undefined
export const canForward = () => takeNewest(future, leaving()) !== undefined
/** Empties both lists. For tests, which share the module. */
export function resetHistory() { past = []; future = [] }
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

/** Typed writes, one group per slice. Screens call these instead of reshaping state themselves. */
export const actions = {
  ui: {
    /** Navigate. Closes any modal and menu. Entering a workspace opens its right panel on Changes, or on PRs for the Lead's. */
    go: (route: Route, opts?: { history?: HistoryMode }) => {
      const from = leaving()
      const now = state.ui.route
      const entering = route.name === 'workspace' && !(now.name === 'workspace' && now.workspaceId === route.workspaceId)
      setUi({ route, modal: null, menu: null, ...(entering && { workspace: { ...state.ui.workspace, right: workspaceView.right, leadRight: workspaceView.leadRight } }) })
      rememberRoom(route)
      moved(from, placeNow(), opts?.history)
    },
    /** ⌘[ and the mouse's back button: the newest place you left that is still there. False when there is none. */
    back: () => step('back'),
    /** ⌘] and the mouse's forward button: undoes a Back. */
    forward: () => step('forward'),
    /** ⌘, : the Settings page you were on last, or General when that page's room is gone. */
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
      else actions.ui.go(nearest((returnTo ?? { route: launch }).route, state), { history: 'replace' })
    },
    openModal: (modal: Exclude<Modal, null>) => setUi({ modal, menu: null }),
    closeModal: () => setUi({ modal: null }),
    /** Opens the menu, or closes it when it is already open. */
    toggleMenu: (menu: MenuId) => setState((s) => ({ ui: { ...s.ui, menu: s.ui.menu === menu ? null : menu } })),
    closeMenu: () => setUi({ menu: null }),
    /**
     * Shows a toast. Returns its id. `components/Toasts.tsx` drops it after 2.6s (DESIGN.md) and holds it while hovered,
     * so the store sets no timer of its own unless `ms` asks for one.
     */
    toast: (t: Omit<Toast, 'id'>, ms?: number) => {
      const toast = { ...t, id: `toast-${++toastSeq}` }
      setState((s) => ({ ui: { ...s.ui, toasts: [...s.ui.toasts, toast] } }))
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
    setChangesView: (view: 'list' | 'tree') => {
      setState((s) => ({ ui: { ...s.ui, workspace: { ...s.ui.workspace, changesView: view } } }))
      try { localStorage.setItem(CHANGES_VIEW, view) } catch { /* not remembered */ }
    },
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
    setSidebar: (open: boolean) => { folded.delete('sidebar'); setUi({ sidebar: open }); keep('sidebar', open) },
    setRightPanel: (open: boolean) => { folded.delete('rightPanel'); setUi({ rightPanel: open }); keep('rightPanel', open) },
    /** The window got too narrow for a panel, or wide enough again. Widening brings back only a panel that folding hid (D-080). */
    fold: (panel: keyof typeof HIDDEN, narrow: boolean) => {
      if (narrow && getState().ui[panel]) { folded.add(panel); setUi(panel === 'sidebar' ? { sidebar: false } : { rightPanel: false }) }
      else if (!narrow && folded.delete(panel)) setUi(panel === 'sidebar' ? { sidebar: true } : { rightPanel: true })
    }
  },
  rooms: {
    set: (rooms: Room[]) => setState({ rooms }),
    upsert: (room: Room) => setState((s) => ({ rooms: upsert(s.rooms, room) })),
    remove: (roomId: string) => setState((s) => ({
      rooms: s.rooms.filter((r) => r.id !== roomId), workspaces: s.workspaces.filter((w) => w.roomId !== roomId),
      ui: { ...s.ui, tabs: dropTabs(s.ui.tabs, (id) => s.workspaces.find((w) => w.id === id)?.roomId === roomId) }
    })),
    setSetup: (roomId: string, steps: RoomSetupStep[]) => setState((s) => ({ roomSetup: { ...s.roomSetup, [roomId]: steps } })),
    setTrust: (roomId: string, trust: ScriptTrust | null) => setState((s) => {
      const { [roomId]: _, ...rest } = s.scriptTrust
      return { scriptTrust: trust ? { ...rest, [roomId]: trust } : rest }
    }),
    setOverlaps: (roomId: string, list: Overlap[]) => setState((s) => ({ overlaps: { ...s.overlaps, [roomId]: list } })),
    upsertOverlap: (o: Overlap) => setState((s) => ({ overlaps: { ...s.overlaps, [o.roomId]: upsert(s.overlaps[o.roomId] ?? [], o) } }))
  },
  agents: {
    set: (roomId: string, list: AgentDef[]) => setState((s) => ({ agents: { ...s.agents, [roomId]: list } })),
    setStatus: (roomId: string, agentId: string, status: AgentStatus, activity?: string) => setState((s) => ({
      status: { ...s.status, [roomId]: { ...(s.status[roomId] ?? {}), [agentId]: status } },
      saying: activity ? { ...s.saying, [agentId]: activity } : s.saying
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
        scripts: omit(s.scripts, ids),
        ui: { ...s.ui, tabs: dropTabs(s.ui.tabs, (id) => gone.has(id)) }
      }
    }),
    /** One script's lines from a `script.output` batch, added in one update (KERNEL-216). */
    appendScript: (workspaceId: string, kind: ScriptKind, name: string | undefined, lines: Pick<ScriptLine, 'line' | 'stream'>[]) =>
      setState((s) => ({ scripts: { ...s.scripts, [workspaceId]: keepLines(s.scripts[workspaceId] ?? [], kind, name, lines) } })),
    /** Main's copy of the workspace's scripts, in place of the window's: a window that just loaded missed what came before (KERNEL-340). */
    setScripts: (workspaceId: string, lines: ScriptLine[], exit: Record<string, number | null>, url: Record<string, string>) => setState((s) => ({
      scripts: { ...s.scripts, [workspaceId]: lines },
      scriptExit: { ...s.scriptExit, [workspaceId]: exit },
      scriptUrl: { ...s.scriptUrl, [workspaceId]: url }
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
    upsert: (chat: Chat) => setState((s) => ({ chats: { ...s.chats, [chat.workspaceId]: upsert(s.chats[chat.workspaceId] ?? [], chat) } })),
    setItems: (chatId: string, list: ChatItem[]) => setState((s) => ({ items: { ...s.items, [chatId]: list } })),
    upsertItem: (chatId: string, item: ChatItem) => setState((s) => ({ items: { ...s.items, [chatId]: upsert(s.items[chatId] ?? [], item) } })),
    setRunning: (chatId: string, running: boolean) => setState((s) => ({ running: { ...s.running, [chatId]: running } })),
    /** A `chat.queue` event passes its reason, or null when nothing holds the queue. A list handed back by a call passes none (undefined), so the last reason stays until the next event. An empty queue has none. */
    setQueue: (chatId: string, list: QueuedMessage[], why?: QueueReason | null) => setState((s) => {
      const queueWhy = { ...s.queueWhy }
      if (!list.length || why === null) delete queueWhy[chatId]
      else if (why) queueWhy[chatId] = why
      return { queue: { ...s.queue, [chatId]: list }, queueWhy }
    }),
    setQueueWhy: (chatId: string, why: QueueReason) => setState((s) => ({ queueWhy: { ...s.queueWhy, [chatId]: why } })),
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
  quickAsk: {
    setDraft: (roomId: string, draft: string) => setState((s) => ({ quickAsk: { ...s.quickAsk, [roomId]: { ...s.quickAsk[roomId], draft } } })),
    setSending: (roomId: string, sending: boolean) => setState((s) => ({ quickAsk: { ...s.quickAsk, [roomId]: { ...s.quickAsk[roomId], draft: s.quickAsk[roomId]?.draft ?? '', sending } } })),
    /** The question sent. Clears the draft, which is what was just asked. */
    setAsked: (roomId: string, asked: NonNullable<QuickAskState['asked']>) => setState((s) => ({ quickAsk: { ...s.quickAsk, [roomId]: { draft: '', asked } } })),
    clearAsked: (roomId: string) => setState((s) => ({ quickAsk: { ...s.quickAsk, [roomId]: { draft: s.quickAsk[roomId]?.draft ?? '' } } }))
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
    set: (roomId: string, list: Task[]) => setState((s) => ({ tasks: { ...s.tasks, [roomId]: list } })),
    upsert: (t: Task) => setState((s) => ({ tasks: { ...s.tasks, [t.roomId]: upsert(s.tasks[t.roomId] ?? [], t) } }))
  },
  activity: {
    set: (list: ActivityEvent[]) => setState({ activity: list }),
    /** Also moves the agent's last activity forward, which outlasts the 200-event window. */
    add: (e: ActivityEvent) => setState((s) => ({
      activity: [e, ...s.activity].slice(0, 200),
      lastActivity: e.roomId && e.agentId ? newer(s.lastActivity, e.roomId, { [e.agentId]: e.ts }) : s.lastActivity
    })),
    /** A room's last activity by agent from `rooms.lastActivity`. Keeps any newer time an event already brought in. */
    setLast: (roomId: string, times: Record<string, number>) => setState((s) => ({ lastActivity: newer(s.lastActivity, roomId, times) }))
  },
  notifications: {
    set: (list: Notification[]) => setState({ notifications: byRecent(list) }),
    upsert: (n: Notification) => setState((s) => ({ notifications: byRecent(upsert(s.notifications, n)) })),
    remove: (ids: string[]) => setState((s) => ({ notifications: s.notifications.filter((n) => !ids.includes(n.id)) }))
  },
  prs: {
    set: (info: PrInfo) => setState((s) => ({ prs: { ...s.prs, [info.workspaceId]: info } })),
    setState: (workspaceId: string, prState: Workspace['prState']) => setState((s) => ({ workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, prState } : w)) }))
  },
  usage: {
    set: (limits: RateLimit[]) => setState({ usage: limits })
  },
  account: {
    set: (account: ClaudeAccount) => setState({ account })
  },
  shared: {
    set: (list: SharedFile[]) => setState({ shared: Object.fromEntries(list.map((f) => [f.id, f])) }),
    upsert: (file: SharedFile) => setState((s) => ({ shared: { ...s.shared, [file.id]: file } }))
  },
  settings: {
    set: (settings: AppSettings) => setState({ settings }),
    setRoom: (roomId: string, rs: RoomSettings) => setState((s) => ({ roomSettings: { ...s.roomSettings, [roomId]: rs } }))
  },
  system: {
    booted: () => setState((s) => ({ system: { ...s.system, booted: true } })),
    setOnline: (online: boolean) => setState((s) => ({ system: { ...s.system, online } })),
    setPreflight: (preflight: PreflightCheck[]) => setState((s) => ({ system: { ...s.system, preflight } })),
    setHooks: (hooks: HookStatus) => setState((s) => ({ system: { ...s.system, hooks } })),
    setUpdate: (update: AppUpdate) => setState((s) => ({ system: { ...s.system, update } }))
  }
}

/** Navigate. Shortcut for `actions.ui.go`. */
export const go = actions.ui.go

/** Apply one push event from main. Exported for tests and fixtures. */
export function apply(e: PushEvent) {
  switch (e.type) {
    case 'activity': return actions.activity.add(e.event)
    case 'chat': return actions.chats.upsert(e.chat)
    case 'chat.item': return actions.chats.upsertItem(e.chatId, e.item)
    case 'chat.cleared': return actions.chats.setItems(e.chatId, [])
    case 'chat.running': pushedLive?.running.add(e.chatId); return actions.chats.setRunning(e.chatId, e.running)
    case 'chat.queue': return actions.chats.setQueue(e.chatId, e.queue, e.why ?? null)
    case 'terminal.data': return e.replace ? actions.chats.replaceTerminal(e.chatId, e.data) : actions.chats.appendTerminal(e.chatId, e.data)
    case 'retry': pushedLive?.retry.add(e.chatId); return actions.chats.setRetry(e.chatId, e.retry)
    case 'approval': return actions.approvals.upsert(e.approval)
    case 'room': return actions.rooms.upsert(e.room)
    case 'room.setup': return actions.rooms.setSetup(e.roomId, e.steps)
    case 'room.trust': return actions.rooms.setTrust(e.roomId, e.trust)
    case 'overlap': return actions.rooms.upsertOverlap(e.overlap)
    case 'agents': return actions.agents.set(e.roomId, e.agents)
    case 'agent.status': return actions.agents.setStatus(e.roomId, e.agentId, e.status, e.activity)
    case 'workspace': return actions.workspaces.upsert(e.workspace)
    case 'script.output': return actions.workspaces.appendScript(e.workspaceId, e.kind, e.name, e.lines)
    case 'script.exit': return actions.workspaces.scriptExited(e.workspaceId, e.kind, e.name, e.code)
    case 'script.url': return actions.workspaces.setScriptUrl(e.workspaceId, e.name, e.url)
    case 'script.state': return actions.workspaces.setScripts(e.workspaceId, e.lines, e.exit, e.url)
    case 'checkpoint': return actions.workspaces.upsertCheckpoint(e.checkpoint)
    case 'task': return actions.tasks.upsert(e.task)
    case 'notification': return actions.notifications.upsert(e.notification)
    case 'notification.removed': return actions.notifications.remove(e.ids)
    case 'usage': return actions.usage.set(e.limits)
    case 'pr': return actions.prs.setState(e.workspaceId, e.state)
    case 'pr.info': return actions.prs.set(e.info)
    case 'thread': return actions.threads.upsert(e.thread)
    case 'shared': return actions.shared.upsert(e.file)
    case 'hooks': return actions.system.setHooks(e.status)
    case 'update': return actions.system.setUpdate(e.update)
    case 'account': return actions.account.set(e.account)
    case 'online': return actions.system.setOnline(e.online)
    case 'toast': return void actions.ui.toast(e.toast)
  }
}

/**
 * Load everything once, then stay live on push events. Only built channels load here; a lane that builds
 * a channel adds its first load (for example `tasks.list` in loadRoom) in the same PR.
 */
let listening = false

export async function boot() {
  if (!listening) { listening = true; onPush(apply) }
  try { await start() } catch (e) { actions.ui.setStartError(cleanError(e)) }
}

/** Loads what the first screen needs and picks it. A failure here leaves `booted` unset and lands in `boot`'s catch, which Loading shows. */
async function start() {
  // Which chats are working, asked once. Pushes only report changes, so without it every agent working while the window
  // loaded would look stopped until its turn ended (KERNEL-340). An older main (a dev build mid-pull) has no such channel.
  pushedLive = { running: new Set(), retry: new Set() }
  void call('chats.live', undefined).then(applyLive, () => applyLive(null))
  const [rooms, workspaces, approvals, notifications, activity, usage, settings, fixture, shared, threads] = await Promise.all([
    call('rooms.list', undefined), call('workspaces.list', {}), call('approvals.list', {}), call('notifications.list', undefined), call('activity.recent', { limit: 100 }), call('usage.get', undefined),
    call('settings.get', undefined), call('system.fixture', undefined),
    // Cards and the Shared panel read these. A failed load only leaves them out until a push brings a file in.
    call('shared.list', {}).catch((): SharedFile[] => []),
    // The sidebar lists Lead chats from these. A failed load leaves the rows to the tabs alone until a push brings a thread in.
    call('threads.list', {}).catch((): Thread[] => [])
  ])
  fixtureMode = !!fixture
  // A retry that works drops the error here, so the error screen keeps its busy button until the lists are in.
  actions.ui.setStartError(undefined)
  setState({ rooms, workspaces, approvals: byRecent(approvals), notifications: byRecent(notifications), activity, usage, settings, shared: Object.fromEntries(shared.map((f) => [f.id, f])), threads: Object.fromEntries(threads.map((t) => [t.id, t])) })
  // Last tabs of chats closed since, or gone, would otherwise pile up in localStorage. A failed load leaves no threads to judge them by.
  if (threads.length) dropLastTabs((id) => !state.threads[id] || !!state.threads[id].closedAt)
  // The footer and the account menu read these. Neither blocks the first paint, and a failure leaves them empty.
  void call('account.get', undefined).then(actions.account.set).catch(() => undefined)
  void call('hooks.status', undefined).then(actions.system.setHooks).catch(() => undefined)
  const update = call('update.get', undefined).then((u) => { actions.system.setUpdate(u); return u }).catch(() => null)
  // Chosen before the branches below, so a launch that stops at the checks still has its tabs back, and the first move after the checks
  // can't save an empty tab list over them. Continue on the checks screen asks again and lands on the same place.
  const opening = launchRoute()
  // A fresh install always starts at Welcome, whose Get started runs the checks.
  // Replace, so Back right after launch has nowhere to go.
  const replace = { history: 'replace' } as const
  if (!rooms.length) go({ name: 'onboarding', step: 'welcome' }, replace)
  else go(opening, replace)
  for (const r of rooms) void loadRoom(r.id).catch(() => undefined)
  actions.system.booted()
  if (fixture) applyFixture(fixture.ui, fixture.push)
  // The checks rerun on every launch, after the app is up: they run claude and gh one after another and can take a while on a slow Mac.
  // Only a blocking failure takes the screen (KERNEL-27, KERNEL-213), and only if nothing has moved you since the route above and no modal is open,
  // because `go` closes modals. Otherwise a toast says so and nothing you are doing is interrupted.
  const shown = state.ui.route
  void call('preflight.run', undefined).then((checks) => {
    actions.system.setPreflight(checks)
    const blocking = checks.find((c) => !c.ok && c.blocking)
    if (!rooms.length || !blocking) return
    if (state.ui.route === shown && !state.ui.modal) go({ name: 'onboarding', step: 'checks' }, replace)
    else actions.ui.toast({ title: blocking.title, sub: 'Kernel will show the checks the next time it starts.' })
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

/**
 * Where the app opens once the checks pass: `boot` goes there, and so does Continue on the checks screen (call it with `go(..., { history: 'replace' })`),
 * so the two can't drift. Settings > General > Default home view picks it. Where I left off reopens the saved place and brings back the tabs
 * of its workspaces that are still live (a tab already open wins, so asking twice changes nothing). Without a saved place (a first launch,
 * unreadable JSON, fixture mode) it opens the last room's Lead chat, found the way the sidebar does (the `lead` workspace on the main
 * checkout), since agents load after this. A room nobody has briefed opens Team (D-104). Also the route Settings falls back to (`launch`).
 */
export function launchRoute(): Route {
  const openTo = state.settings?.general.openTo
  let route: Route = { name: 'home' }
  if (openTo === 'inbox') route = { name: 'inbox' }
  else if (openTo === 'lastPlace') {
    const restored = fixtureMode ? undefined : restorePlace(savedPlace(), state)
    const last = state.rooms.find((r) => r.id === lastRoom())
    if (restored) {
      setState((s) => ({ ui: { ...s.ui, tabs: { ...restored.tabs, ...s.ui.tabs } } }))
      route = restored.route
    } else if (last) route = nearest(roomHome(last.id, state), state)
  }
  return launch = route
}

/** Fixture mode: force the screen, replay its push events, then tell the screenshot harness it can capture. */
function applyFixture({ quickAsk, ...ui }: ForcedUi, push: PushEvent[]) {
  setState((s) => ({ ui: { ...s.ui, ...ui, modal: ui.modal ?? null, workspace: { ...s.ui.workspace, ...ui.workspace }, tabs: { ...s.ui.tabs, ...ui.tabs } }, quickAsk: quickAsk ?? s.quickAsk }))
  // useAppearance applies settings.appearance.theme, so a fixture's theme goes there too or it would be painted over.
  if (ui.theme) setState((s) => (s.settings ? { settings: { ...s.settings, appearance: { ...s.settings.appearance, theme: ui.theme! } } } : {}))
  push.forEach(apply)
  if (ui.theme) document.documentElement.dataset.theme = ui.theme
  document.documentElement.dataset.fixture = 'ready'
}

export async function loadRoom(roomId: string) {
  const [agents, status, tasks, last] = await Promise.all([
    call('agents.list', { roomId }), call('agents.status', { roomId }), call('tasks.list', { roomId }), call('rooms.lastActivity', { roomId })
  ])
  actions.tasks.set(roomId, tasks)
  actions.activity.setLast(roomId, last)
  setState((s) => ({ agents: { ...s.agents, [roomId]: agents }, status: { ...s.status, [roomId]: { ...status, ...(s.status[roomId] ?? {}) } } }))
  // The Inbox lists open overlaps (D-104). Pushes keep them current after this; a failed check only leaves them out.
  void call('rooms.overlaps', { roomId }).then((list) => actions.rooms.setOverlaps(roomId, list)).catch(() => undefined)
  // A workspace held in `trust` before this launch has no push to learn it from. Null isn't applied: a push may have landed first, and `room.trust` clears it (KERNEL-218).
  void call('rooms.scriptTrust', { roomId }).then((trust) => { if (trust) actions.rooms.setTrust(roomId, trust) }).catch(() => undefined)
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

export async function loadWorkspace(workspaceId: string) {
  if (!replayedScripts.has(workspaceId)) {
    replayedScripts.add(workspaceId)
    void call('scripts.replay', { workspaceId }).catch(() => { replayedScripts.delete(workspaceId) })
  }
  const chats = await call('chats.list', { workspaceId })
  actions.chats.set(workspaceId, chats)
  for (const c of chats) actions.chats.setItems(c.id, await call('chats.items', { chatId: c.id }))
  return chats
}

export const pending = (s: State) => s.approvals.filter((a) => a.status === 'pending')
