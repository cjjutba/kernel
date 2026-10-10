import { useRef, useSyncExternalStore } from 'react'
import type {
  ActivityEvent, AgentDef, AgentStatus, AppSettings, AppUpdate, Approval, Banner, Chat, ChatItem, Checkpoint, ClaudeAccount,
  ForcedUi, HookStatus, MenuId, Modal, Notification, Overlap, PreflightCheck, PrInfo, QueuedMessage, QuickAskState, RateLimit, Room, RoomSettings,
  RoomSetupStep, Route, ScriptKind, SettingsPage, ScriptLine, Task, Theme, Toast, UiState, Workspace, WorkspaceTabs, WorkspaceView
} from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { call, onPush } from './api'
import { hasTab, isChatTab, nearest, placeToSave, restorePlace, roomHome, samePlace, stillThere, tabOf, type Place } from './nav'

export type { Modal, Route }

/**
 * The renderer's state: one top-level key per domain, plus `ui`. Keys stay flat so selectors read `s.rooms`, `s.items[chatId]`.
 * Write through `actions` (typed, one group per slice) or push events; `setState` is the escape hatch.
 */
export interface State {
  // rooms
  rooms: Room[]
  /** By room id. Progress of a room being set up (RoomSetup.png). */
  roomSetup: Record<string, RoomSetupStep[]>
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
  /** By workspace id. */
  scripts: Record<string, ScriptLine[]>
  /** By workspace id. Exit code of the last run of each script. */
  scriptExit: Record<string, Partial<Record<ScriptKind, number | null>>>
  /** By workspace id. */
  checkpoints: Record<string, Checkpoint[]>
  // chats
  /** By workspace id. */
  chats: Record<string, Chat[]>
  /** By chat id. */
  items: Record<string, ChatItem[]>
  /** By chat id. */
  running: Record<string, boolean>
  /** By chat id. */
  queue: Record<string, QueuedMessage[]>
  /** By chat id. Raw pty output for terminal chats. */
  terminal: Record<string, string>
  /** By chat id. Set while Claude is overloaded and the session retries. */
  retry: Record<string, { attempt: number; of: number; nextAt: number }>
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
  system: { booted: boolean; online: boolean; preflight: PreflightCheck[] | null; hooks: HookStatus | null; update: AppUpdate | null }
  /** By room id. The Ask Rowan popover's draft and last question, kept while it is closed. */
  quickAsk: Record<string, QuickAskState>
  ui: UiState
}

const workspaceView: WorkspaceView = { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false }

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
/** Panels a narrow window folded (`ui.fold`). A fold never touches the saved toggle, and toggling a panel by hand forgets its fold. */
const folded = new Set<keyof typeof HIDDEN>()

let state: State = {
  rooms: [], roomSetup: {}, overlaps: {},
  agents: {}, status: {}, saying: {},
  workspaces: [], scripts: {}, scriptExit: {}, checkpoints: {},
  chats: {}, items: {}, running: {}, queue: {}, terminal: {}, retry: {},
  approvals: [], tasks: {}, activity: [], lastActivity: {}, notifications: [],
  prs: {},
  usage: [], account: null, settings: null, roomSettings: {},
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
function lastRoom(): string | null {
  try { return localStorage.getItem(LAST_ROOM) } catch { return null }
}
const emptyTabs: WorkspaceTabs = { files: [], diffs: [] }
/** `tabs` with `tab` selected. A chat id also becomes `lastChat`; a file or diff tab joins the open ones. */
function withTab(tabs: WorkspaceTabs | undefined, tab: string): WorkspaceTabs {
  const t = { ...emptyTabs, ...tabs, tab }
  if (tab.startsWith('file:')) { const path = tab.slice(5); return t.files.includes(path) ? t : { ...t, files: [...t.files, path] } }
  if (tab.startsWith('diff:')) { const path = tab.slice(5); return t.diffs.includes(path) ? t : { ...t, diffs: [...t.diffs, path] } }
  if (tab.startsWith('image:') || tab.startsWith('text:')) return t
  return { ...t, lastChat: tab }
}
/** Selects the tab without recording a step. */
function selectTab(workspaceId: string, tab: string) {
  setState((s) => ({ ui: { ...s.ui, tabs: { ...s.ui.tabs, [workspaceId]: withTab(s.ui.tabs[workspaceId], tab) } } }))
}
/** Where the app is now. */
const placeNow = (): Place => {
  const { route } = state.ui
  return route.name === 'workspace' ? { route, tab: tabOf(state, route.workspaceId) } : { route }
}
/** Where Settings was opened from, the last Settings page, and where the app opened. Module level like `folded`: none of it outlasts a restart. */
let returnTo: Place | undefined
let lastSettings: { page: SettingsPage; roomId?: string } | undefined
let launch: Route = { name: 'home' }
/**
 * The place a relaunch reopens (KERNEL-201), kept in localStorage like the other `kernel.*` keys, which may be missing or blocked.
 * Nothing is written before the first route is chosen (`system.booted`), so a restore never overwrites what it read, and none in fixture mode.
 */
const LAST_PLACE = 'kernel.lastPlace'
let fixtureMode = false
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
    lastSettings = { page: to.route.page, ...(to.route.roomId ? { roomId: to.route.roomId } : {}) }
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
const setUi = (patch: Partial<UiState>) => setState((s) => ({ ui: { ...s.ui, ...patch } }))
let toastSeq = 0

/** Typed writes, one group per slice. Screens call these instead of reshaping state themselves. */
export const actions = {
  ui: {
    /** Navigate. Closes any modal and menu. */
    go: (route: Route, opts?: { history?: HistoryMode }) => {
      const from = leaving()
      setUi({ route, modal: null, menu: null })
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
    setWorkspaceView: (patch: Partial<WorkspaceView>) => setState((s) => ({ ui: { ...s.ui, workspace: { ...s.ui.workspace, ...patch } } })),
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
    /** Changes a workspace's tabs without selecting anything new, for closing a tab. */
    setTabs: (workspaceId: string, patch: Partial<WorkspaceTabs>) => setState((s) => ({ ui: { ...s.ui, tabs: { ...s.ui.tabs, [workspaceId]: { ...emptyTabs, ...s.ui.tabs[workspaceId], ...patch } } } })),
    /** Folds or unfolds a Lead chat's workspaces in the sidebar. Unfolding drops the id, so the list holds only folded chats. */
    foldChat: (chatId: string, fold: boolean) => {
      const ids = getState().ui.foldedChats.filter((id) => id !== chatId)
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
    appendScript: (workspaceId: string, line: ScriptLine) => setState((s) => ({ scripts: { ...s.scripts, [workspaceId]: [...(s.scripts[workspaceId] ?? []), line].slice(-400) } })),
    scriptExited: (workspaceId: string, kind: ScriptKind, code: number | null) => setState((s) => ({ scriptExit: { ...s.scriptExit, [workspaceId]: { ...(s.scriptExit[workspaceId] ?? {}), [kind]: code } } })),
    setCheckpoints: (workspaceId: string, list: Checkpoint[]) => setState((s) => ({ checkpoints: { ...s.checkpoints, [workspaceId]: list } })),
    /** Only one checkpoint is where the worktree is now, so a new current one clears the flag on the rest. */
    upsertCheckpoint: (c: Checkpoint) => setState((s) => {
      const list = (s.checkpoints[c.workspaceId] ?? []).map((x) => (c.current && x.current && x.id !== c.id ? { ...x, current: false } : x))
      return { checkpoints: { ...s.checkpoints, [c.workspaceId]: upsert(list, c) } }
    })
  },
  chats: {
    set: (workspaceId: string, list: Chat[]) => setState((s) => ({ chats: { ...s.chats, [workspaceId]: list } })),
    upsert: (chat: Chat) => setState((s) => ({ chats: { ...s.chats, [chat.workspaceId]: upsert(s.chats[chat.workspaceId] ?? [], chat) } })),
    setItems: (chatId: string, list: ChatItem[]) => setState((s) => ({ items: { ...s.items, [chatId]: list } })),
    upsertItem: (chatId: string, item: ChatItem) => setState((s) => ({ items: { ...s.items, [chatId]: upsert(s.items[chatId] ?? [], item) } })),
    setRunning: (chatId: string, running: boolean) => setState((s) => ({ running: { ...s.running, [chatId]: running } })),
    setQueue: (chatId: string, list: QueuedMessage[]) => setState((s) => ({ queue: { ...s.queue, [chatId]: list } })),
    appendTerminal: (chatId: string, data: string) => setState((s) => ({ terminal: { ...s.terminal, [chatId]: ((s.terminal[chatId] ?? '') + data).slice(-200_000) } })),
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
    case 'chat.running': return actions.chats.setRunning(e.chatId, e.running)
    case 'chat.queue': return actions.chats.setQueue(e.chatId, e.queue)
    case 'terminal.data': return actions.chats.appendTerminal(e.chatId, e.data)
    case 'retry': return actions.chats.setRetry(e.chatId, e.retry)
    case 'approval': return actions.approvals.upsert(e.approval)
    case 'room': return actions.rooms.upsert(e.room)
    case 'room.setup': return actions.rooms.setSetup(e.roomId, e.steps)
    case 'overlap': return actions.rooms.upsertOverlap(e.overlap)
    case 'agents': return actions.agents.set(e.roomId, e.agents)
    case 'agent.status': return actions.agents.setStatus(e.roomId, e.agentId, e.status, e.activity)
    case 'workspace': return actions.workspaces.upsert(e.workspace)
    case 'script.output': return actions.workspaces.appendScript(e.workspaceId, { kind: e.kind, line: e.line, stream: e.stream })
    case 'script.exit': return actions.workspaces.scriptExited(e.workspaceId, e.kind, e.code)
    case 'checkpoint': return actions.workspaces.upsertCheckpoint(e.checkpoint)
    case 'task': return actions.tasks.upsert(e.task)
    case 'notification': return actions.notifications.upsert(e.notification)
    case 'notification.removed': return actions.notifications.remove(e.ids)
    case 'usage': return actions.usage.set(e.limits)
    case 'pr': return actions.prs.setState(e.workspaceId, e.state)
    case 'pr.info': return actions.prs.set(e.info)
    case 'hooks': return actions.system.setHooks(e.status)
    case 'update': return actions.system.setUpdate(e.update)
    case 'account': return actions.account.set(e.account)
    case 'online': return actions.system.setOnline(e.online)
  }
}

/**
 * Load everything once, then stay live on push events. Only built channels load here; a lane that builds
 * a channel adds its first load (for example `tasks.list` in loadRoom) in the same PR.
 */
export async function boot() {
  onPush(apply)
  const [rooms, workspaces, approvals, notifications, activity, usage, settings, fixture] = await Promise.all([
    call('rooms.list', undefined), call('workspaces.list', {}), call('approvals.list', {}), call('notifications.list', undefined), call('activity.recent', { limit: 100 }), call('usage.get', undefined),
    call('settings.get', undefined), call('system.fixture', undefined)
  ])
  fixtureMode = !!fixture
  setState({ rooms, workspaces, approvals: byRecent(approvals), notifications: byRecent(notifications), activity, usage, settings })
  // The footer and the account menu read these. Neither blocks the first paint, and a failure leaves them empty.
  void call('account.get', undefined).then(actions.account.set).catch(() => undefined)
  void call('hooks.status', undefined).then(actions.system.setHooks).catch(() => undefined)
  const update = call('update.get', undefined).then((u) => { actions.system.setUpdate(u); return u }).catch(() => null)
  // The checks rerun on every launch. A failing check shows its screen even when rooms exist (KERNEL-27).
  const checks = await call('preflight.run', undefined).catch(() => null)
  if (checks) actions.system.setPreflight(checks)
  // A fresh install always starts at Welcome, whose Get started runs the checks.
  // Replace, so Back right after launch has nowhere to go.
  const replace = { history: 'replace' } as const
  if (!rooms.length) go({ name: 'onboarding', step: 'welcome' }, replace)
  else if (checks?.some((c) => !c.ok)) go({ name: 'onboarding', step: 'checks' }, replace)
  else { launch = homeRoute(settings); go(launch, replace) }
  for (const r of rooms) void loadRoom(r.id)
  actions.system.booted()
  if (fixture) applyFixture(fixture.ui, fixture.push)
  // After an update installs, What's new opens once with that version's notes (KERNEL-30). It waits for the route above, which closes modals,
  // and carries its own copy, since the updater's first check pushes a new state that drops `installed` and the notes.
  void update.then((u) => { if (u?.installed) actions.ui.openModal({ name: 'whatsNew', update: u }) })
}

/**
 * Settings > General > Default home view: where the app opens. Where I left off reopens the saved place and brings back the tabs
 * of its workspaces that are still live. Without one (a first launch, unreadable JSON, fixture mode) it opens the last room's Lead chat,
 * found the way the sidebar does (the `lead` workspace on the main checkout), since agents load after this. A room nobody
 * has briefed opens Team (D-104).
 */
function homeRoute(settings: AppSettings): Route {
  const { openTo } = settings.general
  if (openTo === 'inbox') return { name: 'inbox' }
  if (openTo === 'home') return { name: 'home' }
  const restored = fixtureMode ? undefined : restorePlace(savedPlace(), state)
  if (restored) {
    setState((s) => ({ ui: { ...s.ui, tabs: { ...s.ui.tabs, ...restored.tabs } } }))
    return restored.route
  }
  const last = state.rooms.find((r) => r.id === lastRoom())
  return last ? nearest(roomHome(last.id, state), state) : { name: 'home' }
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
}

export async function loadWorkspace(workspaceId: string) {
  const chats = await call('chats.list', { workspaceId })
  actions.chats.set(workspaceId, chats)
  for (const c of chats) actions.chats.setItems(c.id, await call('chats.items', { chatId: c.id }))
  return chats
}

export const pending = (s: State) => s.approvals.filter((a) => a.status === 'pending')
