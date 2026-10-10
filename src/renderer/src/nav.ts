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

/** Is `tab` open in the workspace: an open chat, or a file or diff in its lists. Image and text tabs live in the screen, which checks them itself. */
export function hasTab(s: State, workspaceId: string, tab: string): boolean {
  const t = s.ui.tabs[workspaceId]
  if ((s.chats[workspaceId] ?? []).some((c) => c.id === tab && !c.closed)) return true
  if (tab.startsWith('file:')) return !!t?.files.includes(tab.slice(5))
  if (tab.startsWith('diff:')) return !!t?.diffs.includes(tab.slice(5))
  return tab.startsWith('image:') || tab.startsWith('text:')
}

/** The tab a workspace shows. The stored tab while it is still open, else the last chat if it is still open, else the first open chat. */
export function tabOf(s: State, workspaceId: string): string | undefined {
  const t = s.ui.tabs[workspaceId]
  if (t?.tab && hasTab(s, workspaceId, t.tab)) return t.tab
  if (t?.lastChat && hasTab(s, workspaceId, t.lastChat)) return t.lastChat
  return (s.chats[workspaceId] ?? []).find((c) => !c.closed)?.id
}

/** A tab of the chat kind, as opposed to a file, diff, image or text tab. */
export const isChatTab = (tab: string) => !/^(file|diff|image|text):/.test(tab)

/** The same route and the same tab. */
export const samePlace = (a: Place, b: Place) => a.tab === b.tab && JSON.stringify(a.route) === JSON.stringify(b.route)

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
