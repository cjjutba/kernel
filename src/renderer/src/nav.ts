import type { Route } from '@shared/types'
import type { State } from './store'

/**
 * Where you are: a route and, on a workspace, the tab open in it. Pure functions over `State` live here, with type-only imports,
 * so tests and the store use them without a window.
 */
export interface Place { route: Route; tab?: string }

const visible = (r: { hidden?: boolean; archived?: boolean }) => !r.hidden && !r.archived
const roomVisible = (s: State, roomId: string) => { const r = s.rooms.find((x) => x.id === roomId); return !!r && visible(r) }

/** The room a route belongs to, if it belongs to one. */
export function roomOf(route: Route, s: State): string | undefined {
  if (route.name === 'workspace') return s.workspaces.find((w) => w.id === route.workspaceId)?.roomId
  return 'roomId' in route ? route.roomId : undefined
}

/**
 * The tab a workspace shows. The stored tab while it still exists (an open chat, or a file or diff in the workspace's lists),
 * else the last chat if it is still open, else the first open chat. Image and text tabs live in the screen, which checks them itself.
 */
export function tabOf(s: State, workspaceId: string): string | undefined {
  const t = s.ui.tabs[workspaceId]
  const open = (s.chats[workspaceId] ?? []).filter((c) => !c.closed)
  const isChat = (id: string | undefined) => !!id && open.some((c) => c.id === id)
  const tab = t?.tab
  if (tab) {
    if (isChat(tab)) return tab
    if (tab.startsWith('file:') && t.files.includes(tab.slice(5))) return tab
    if (tab.startsWith('diff:') && t.diffs.includes(tab.slice(5))) return tab
    if (tab.startsWith('image:') || tab.startsWith('text:')) return tab
  }
  return isChat(t?.lastChat) ? t?.lastChat : open[0]?.id
}

/** Is the route still somewhere to go? Not an archived workspace, a hidden or archived room, or a Settings page of a room that is gone. */
export function stillThere(route: Route, s: State): boolean {
  if (route.name === 'workspace') {
    const ws = s.workspaces.find((w) => w.id === route.workspaceId)
    return !!ws && ws.status !== 'archived' && roomVisible(s, ws.roomId)
  }
  if (route.name === 'onboarding') return true
  if (route.name === 'settings') return route.page !== 'room' || (!!route.roomId && roomVisible(s, route.roomId))
  if ('roomId' in route && route.roomId) return roomVisible(s, route.roomId)
  return true
}

/**
 * A room's front door: the Lead's workspace on the main checkout, or Team when the room has none (D-104). The Lead is found by its
 * agent once agents have loaded, and by the `lead` workspace name before, since agents load after the first route is chosen.
 */
export function roomHome(roomId: string, s: State): Route {
  const leadId = s.agents[roomId]?.find((a) => a.lead)?.id
  const lead = s.workspaces.find((w) => w.roomId === roomId && w.mode === 'current' && w.status !== 'archived' && (leadId ? w.agentId === leadId : w.name === 'lead'))
  return lead ? { name: 'workspace', workspaceId: lead.id } : { name: 'team', roomId }
}

/** The route if it is still there, else its room's Lead workspace, then the room's Team page, then Home. */
export function nearest(route: Route, s: State): Route {
  if (stillThere(route, s)) return route
  const roomId = roomOf(route, s)
  if (roomId && roomVisible(s, roomId)) {
    const home = roomHome(roomId, s)
    if (stillThere(home, s)) return home
  }
  return { name: 'home' }
}
