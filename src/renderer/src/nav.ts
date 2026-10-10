import type { Route, UiState } from '@shared/types'
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

/** What `kernel.lastPlace` holds: the route and every workspace's tabs, enough to open the app where it was left. */
export interface SavedPlace { v: 1; route: Route; tabs: UiState['tabs'] }

/**
 * The value to save for the state as it is now, or nothing when this is not somewhere to reopen. Onboarding and the dev pages are not,
 * and Settings saves the place it was opened from (`openedFrom`), so a relaunch never lands in Settings. An image or text tab lives in
 * the screen and is gone after a restart, so a workspace on one is saved on the chat it was last on.
 */
export function placeToSave(s: State, openedFrom?: Place): SavedPlace | undefined {
  const route = s.ui.route.name === 'settings' ? openedFrom?.route : s.ui.route
  if (!route || route.name === 'onboarding' || route.name === 'devUi') return undefined
  const tabs: UiState['tabs'] = {}
  for (const [id, t] of Object.entries(s.ui.tabs)) tabs[id] = t.tab?.startsWith('image:') || t.tab?.startsWith('text:') ? { ...t, tab: t.lastChat } : t
  return { v: 1, route, tabs }
}

const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''
/** Paths, where an empty one is real: the diff tab of all changes is `diff:` with no path. */
const paths = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** A saved route made sound, or nothing. Missing ids would open a screen with no room or workspace, so they are rejected here. */
function soundRoute(r: any): Route | undefined {
  switch (r?.name) {
    case 'home': case 'inbox': case 'history': case 'rooms': return { name: r.name }
    case 'issues': return isText(r.issueId) ? { name: 'issues', issueId: r.issueId } : { name: 'issues' }
    case 'workspace': return isText(r.workspaceId) ? { name: 'workspace', workspaceId: r.workspaceId } : undefined
    // Agents load after the first route is chosen, and the floor and the Board are hidden (D-104), so these open their room's Team page.
    case 'team': case 'agent': case 'task': case 'floor': case 'board': return isText(r.roomId) ? { name: 'team', roomId: r.roomId } : undefined
    default: return undefined // onboarding, devUi, settings and anything unknown are never reopened
  }
}

/**
 * Reads `kernel.lastPlace` into where to open and the tabs to bring back. The tabs are only those of workspaces that are still live, and
 * the route is the nearest place that is still there (a closed workspace opens its room's Lead chat, a removed room opens Home). Nothing
 * when there is nothing saved, it is not JSON, or it is a version this build doesn't know.
 */
export function restorePlace(raw: string | null, s: State): { route: Route; tabs: UiState['tabs'] } | undefined {
  let saved: any
  try { saved = raw ? JSON.parse(raw) : undefined } catch { return undefined }
  if (saved?.v !== 1) return undefined
  const route = soundRoute(saved.route)
  if (!route) return undefined
  const tabs: UiState['tabs'] = {}
  for (const w of s.workspaces) {
    const t = saved.tabs?.[w.id]
    if (w.status === 'archived' || !t || typeof t !== 'object') continue
    tabs[w.id] = { ...(isText(t.tab) ? { tab: t.tab } : {}), ...(isText(t.lastChat) ? { lastChat: t.lastChat } : {}), files: paths(t.files), diffs: paths(t.diffs) }
  }
  return { route: nearest(route, s), tabs }
}
