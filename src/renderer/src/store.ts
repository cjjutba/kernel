import { useSyncExternalStore } from 'react'
import type { ActivityEvent, AgentDef, AgentStatus, Approval, Chat, ChatItem, ForcedUi, Modal, RateLimit, Room, Route, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { call, onPush } from './api'

export type { Modal, Route }

export interface State {
  route: Route
  modal: Modal
  rooms: Room[]
  agents: Record<string, AgentDef[]>
  status: Record<string, Record<string, AgentStatus>>
  saying: Record<string, string>
  workspaces: Workspace[]
  chats: Record<string, Chat[]>
  items: Record<string, ChatItem[]>
  running: Record<string, boolean>
  approvals: Approval[]
  activity: ActivityEvent[]
  usage: RateLimit[]
  scripts: Record<string, { kind: string; line: string; stream: string }[]>
  /** Menu, banner, stage and theme forced by a fixture. Empty in a real run. */
  ui: ForcedUi
}

let state: State = {
  route: { name: 'home' }, modal: null, rooms: [], agents: {}, status: {}, saying: {}, workspaces: [], chats: {}, items: {},
  running: {}, approvals: [], activity: [], usage: [], scripts: {}, ui: {}
}
const listeners = new Set<() => void>()

export function getState() { return state }
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  listeners.forEach((l) => l())
}
export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => select(state))
}
export const go = (route: Route) => setState({ route, modal: null })

const upsert = <T extends { id: string }>(list: T[], item: T) => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item])

function apply(e: PushEvent) {
  switch (e.type) {
    case 'activity': return setState((s) => ({ activity: [e.event, ...s.activity].slice(0, 200) }))
    case 'chat.item': return setState((s) => ({ items: { ...s.items, [e.chatId]: upsert(s.items[e.chatId] ?? [], e.item) } }))
    case 'chat.running': return setState((s) => ({ running: { ...s.running, [e.chatId]: e.running } }))
    case 'approval': return setState((s) => ({ approvals: upsert(s.approvals, e.approval).sort((a, b) => b.createdAt - a.createdAt) }))
    case 'workspace': return setState((s) => ({ workspaces: upsert(s.workspaces, e.workspace) }))
    case 'agent.status': return setState((s) => ({
      status: { ...s.status, [e.roomId]: { ...(s.status[e.roomId] ?? {}), [e.agentId]: e.status } },
      saying: e.activity ? { ...s.saying, [e.agentId]: e.activity } : s.saying
    }))
    case 'script.output': return setState((s) => ({ scripts: { ...s.scripts, [e.workspaceId]: [...(s.scripts[e.workspaceId] ?? []), { kind: e.kind, line: e.line, stream: e.stream }].slice(-400) } }))
    case 'usage': return setState({ usage: e.limits })
    default: return
  }
}

/** Load everything once, then stay live on push events. */
export async function boot() {
  onPush(apply)
  const [rooms, workspaces, approvals, activity, usage, fixture] = await Promise.all([
    call('rooms.list', undefined), call('workspaces.list', {}), call('approvals.list', {}), call('activity.recent', { limit: 100 }), call('usage.get', undefined),
    call('system.fixture', undefined)
  ])
  setState({ rooms, workspaces, approvals, activity, usage, route: rooms.length ? { name: 'home' } : { name: 'onboarding' } })
  for (const r of rooms) void loadRoom(r.id)
  if (fixture) applyFixture(fixture.ui, fixture.push)
}

/** Fixture mode: force the screen, replay its push events, then tell the screenshot harness it can capture. */
function applyFixture(ui: ForcedUi, push: PushEvent[]) {
  setState((s) => ({ ui, route: ui.route ?? s.route, modal: ui.modal ?? null }))
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
  setState((s) => ({ chats: { ...s.chats, [workspaceId]: chats } }))
  for (const c of chats) {
    const items = await call('chats.items', { chatId: c.id })
    setState((s) => ({ items: { ...s.items, [c.id]: items } }))
  }
  return chats
}

export const pending = (s: State) => s.approvals.filter((a) => a.status === 'pending')
