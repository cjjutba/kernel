import { useRef, useSyncExternalStore } from 'react'
import type {
  ActivityEvent, AgentDef, AgentStatus, AppSettings, AppUpdate, Approval, Banner, Chat, ChatItem, Checkpoint, ClaudeAccount,
  ForcedUi, HookStatus, MenuId, Modal, Notification, Overlap, PreflightCheck, PrInfo, QueuedMessage, RateLimit, Room, RoomSettings,
  RoomSetupStep, Route, ScriptKind, ScriptLine, Task, Theme, Toast, UiState, Workspace, WorkspaceView
} from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { call, onPush } from './api'

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
  ui: UiState
}

const workspaceView: WorkspaceView = { right: 'changes', bottom: 'run', focus: false, checkpoints: false, toolsOpen: false }

let state: State = {
  rooms: [], roomSetup: {}, overlaps: {},
  agents: {}, status: {}, saying: {},
  workspaces: [], scripts: {}, scriptExit: {}, checkpoints: {},
  chats: {}, items: {}, running: {}, queue: {}, terminal: {}, retry: {},
  approvals: [], tasks: {}, activity: [], notifications: [],
  prs: {},
  usage: [], account: null, settings: null, roomSettings: {},
  system: { booted: false, online: true, preflight: null, hooks: null, update: null },
  ui: { route: { name: 'home' }, modal: null, menu: null, toasts: [], banner: null, theme: 'dark', workspace: workspaceView }
}
const listeners = new Set<() => void>()

export function getState() { return state }
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

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
const setUi = (patch: Partial<UiState>) => setState((s) => ({ ui: { ...s.ui, ...patch } }))
let toastSeq = 0

/** Typed writes, one group per slice. Screens call these instead of reshaping state themselves. */
export const actions = {
  ui: {
    /** Navigate. Closes any modal and menu. */
    go: (route: Route) => setUi({ route, modal: null, menu: null }),
    openModal: (modal: Exclude<Modal, null>) => setUi({ modal, menu: null }),
    closeModal: () => setUi({ modal: null }),
    /** Opens the menu, or closes it when it is already open. */
    toggleMenu: (menu: MenuId) => setState((s) => ({ ui: { ...s.ui, menu: s.ui.menu === menu ? null : menu } })),
    closeMenu: () => setUi({ menu: null }),
    /** Shows a toast and drops it after 2.6s (DESIGN.md). Returns its id. */
    toast: (t: Omit<Toast, 'id'>, ms = 2600) => {
      const toast = { ...t, id: `toast-${++toastSeq}` }
      setState((s) => ({ ui: { ...s.ui, toasts: [...s.ui.toasts, toast] } }))
      if (ms > 0) setTimeout(() => actions.ui.dismissToast(toast.id), ms)
      return toast.id
    },
    dismissToast: (id: string) => setState((s) => ({ ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== id) } })),
    showBanner: (banner: Banner) => setUi({ banner }),
    clearBanner: () => setUi({ banner: null }),
    setTheme: (theme: Theme) => { setUi({ theme }); document.documentElement.dataset.theme = theme },
    setStage: (stage: string | undefined) => setUi({ stage }),
    setWorkspaceView: (patch: Partial<WorkspaceView>) => setState((s) => ({ ui: { ...s.ui, workspace: { ...s.ui.workspace, ...patch } } }))
  },
  rooms: {
    set: (rooms: Room[]) => setState({ rooms }),
    upsert: (room: Room) => setState((s) => ({ rooms: upsert(s.rooms, room) })),
    remove: (roomId: string) => setState((s) => ({ rooms: s.rooms.filter((r) => r.id !== roomId), workspaces: s.workspaces.filter((w) => w.roomId !== roomId) })),
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
    set: (list: Workspace[]) => setState({ workspaces: list }),
    upsert: (ws: Workspace) => setState((s) => ({ workspaces: upsert(s.workspaces, ws) })),
    appendScript: (workspaceId: string, line: ScriptLine) => setState((s) => ({ scripts: { ...s.scripts, [workspaceId]: [...(s.scripts[workspaceId] ?? []), line].slice(-400) } })),
    scriptExited: (workspaceId: string, kind: ScriptKind, code: number | null) => setState((s) => ({ scriptExit: { ...s.scriptExit, [workspaceId]: { ...(s.scriptExit[workspaceId] ?? {}), [kind]: code } } })),
    setCheckpoints: (workspaceId: string, list: Checkpoint[]) => setState((s) => ({ checkpoints: { ...s.checkpoints, [workspaceId]: list } })),
    upsertCheckpoint: (c: Checkpoint) => setState((s) => ({ checkpoints: { ...s.checkpoints, [c.workspaceId]: upsert(s.checkpoints[c.workspaceId] ?? [], c) } }))
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
    add: (e: ActivityEvent) => setState((s) => ({ activity: [e, ...s.activity].slice(0, 200) }))
  },
  notifications: {
    set: (list: Notification[]) => setState({ notifications: byRecent(list) }),
    upsert: (n: Notification) => setState((s) => ({ notifications: byRecent(upsert(s.notifications, n)) }))
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
  const [rooms, workspaces, approvals, activity, usage, settings, fixture] = await Promise.all([
    call('rooms.list', undefined), call('workspaces.list', {}), call('approvals.list', {}), call('activity.recent', { limit: 100 }), call('usage.get', undefined),
    call('settings.get', undefined), call('system.fixture', undefined)
  ])
  setState({ rooms, workspaces, approvals: byRecent(approvals), activity, usage, settings })
  // The checks rerun on every launch. A failing check shows its screen even when rooms exist (KERNEL-27).
  const checks = await call('preflight.run', undefined).catch(() => null)
  if (checks) actions.system.setPreflight(checks)
  if (checks?.some((c) => !c.ok)) go({ name: 'onboarding', step: 'checks' })
  else go(rooms.length ? { name: 'home' } : { name: 'onboarding', step: 'welcome' })
  for (const r of rooms) void loadRoom(r.id)
  actions.system.booted()
  if (fixture) applyFixture(fixture.ui, fixture.push)
}

/** Fixture mode: force the screen, replay its push events, then tell the screenshot harness it can capture. */
function applyFixture(ui: ForcedUi, push: PushEvent[]) {
  setState((s) => ({ ui: { ...s.ui, ...ui, modal: ui.modal ?? null, workspace: { ...s.ui.workspace, ...ui.workspace } } }))
  push.forEach(apply)
  if (ui.theme) document.documentElement.dataset.theme = ui.theme
  document.documentElement.dataset.fixture = 'ready'
}

export async function loadRoom(roomId: string) {
  const [agents, status] = await Promise.all([call('agents.list', { roomId }), call('agents.status', { roomId })])
  setState((s) => ({ agents: { ...s.agents, [roomId]: agents }, status: { ...s.status, [roomId]: { ...status, ...(s.status[roomId] ?? {}) } } }))
}

export async function loadWorkspace(workspaceId: string) {
  const chats = await call('chats.list', { workspaceId })
  actions.chats.set(workspaceId, chats)
  for (const c of chats) actions.chats.setItems(c.id, await call('chats.items', { chatId: c.id }))
  return chats
}

export const pending = (s: State) => s.approvals.filter((a) => a.status === 'pending')
