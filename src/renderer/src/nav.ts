import type { Chat, Route, Thread, UiState, Workspace } from '@shared/types'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import type { State } from './store'

/**
 * Where you are: a route and, on a workspace, the tab open in it. Pure functions over `State` live here, importing nothing that needs one,
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

/** Is `tab` open in the workspace: an open chat, or a file, diff or shared file in its lists. Image and text tabs live in the screen, which checks them itself. */
export function hasTab(s: State, workspaceId: string, tab: string): boolean {
  const t = s.ui.tabs[workspaceId]
  if ((s.chats[workspaceId] ?? []).some((c) => c.id === tab && !c.closed)) return true
  if (tab.startsWith('file:')) return !!t?.files.includes(tab.slice(5))
  if (tab.startsWith('diff:')) return !!t?.diffs.includes(tab.slice(5))
  if (tab.startsWith('shared:')) return !!t?.shared?.includes(tab.slice(7))
  return tab.startsWith('image:') || tab.startsWith('text:')
}

/** The tab a workspace shows. The stored tab while it is still open, else the last chat if it is still open, else the first open chat. */
export function tabOf(s: State, workspaceId: string): string | undefined {
  const t = s.ui.tabs[workspaceId]
  if (t?.tab && hasTab(s, workspaceId, t.tab)) return t.tab
  if (t?.lastChat && hasTab(s, workspaceId, t.lastChat)) return t.lastChat
  return (s.chats[workspaceId] ?? []).find((c) => !c.closed)?.id
}

/** The Lead chat a tab is in. A tab with no thread (threads not loaded yet, or an older fixture) is a chat of its own. */
export const threadIdOf = (chat: Chat): string => chat.threadId ?? chat.id

/**
 * The Lead chat a workspace shows (KERNEL-338): the thread of its open chat tab, or of the chat it was last on while a file or diff tab is open,
 * else the one remembered for the workspace, else the first open chat. Nothing for a workspace with no open chat.
 */
export function currentThread(s: State, workspaceId: string): string | undefined {
  const chats = (s.chats[workspaceId] ?? []).filter((c) => c.kind === 'chat' && !c.closed)
  const picks = [tabOf(s, workspaceId), s.ui.tabs[workspaceId]?.lastChat]
  const chat = picks.map((id) => chats.find((c) => c.id === id)).find(Boolean)
    // A terminal tab has no chat of its own, so the chat you were in stays current.
    ?? chats.find((c) => threadIdOf(c) === s.lastThread[workspaceId]) ?? chats[0]
  return chat && threadIdOf(chat)
}

/** A tab of the chat kind, as opposed to a file, diff, shared, image or text tab. */
export const isChatTab = (tab: string) => !/^(file|diff|shared|image|text):/.test(tab)

/** The same route and the same tab. */
export const samePlace = (a: Place, b: Place) => a.tab === b.tab && JSON.stringify(a.route) === JSON.stringify(b.route)

/**
 * Is the route still somewhere to go? Not an archived workspace or one whose folder was deleted outside Kernel (KERNEL-291), a
 * hidden or archived room, or a Settings page of a room that is gone. Opening a workspace with no folder still works: only
 * reopening at launch, ⌘[ and Back to app skip it.
 */
export function stillThere(route: Route, s: State): boolean {
  if (route.name === 'workspace') {
    const ws = s.workspaces.find((w) => w.id === route.workspaceId)
    return !!ws && ws.status !== 'archived' && !ws.folderGone && roomVisible(s, ws.roomId)
  }
  if (route.name === 'onboarding') return true
  if (route.name === 'settings') return route.page !== 'room' || (!!route.roomId && roomVisible(s, route.roomId))
  if ('roomId' in route && route.roomId) return roomVisible(s, route.roomId)
  return true
}

/**
 * The workspaces of the room's open chats with Rowan as the sidebar lists them: the one the user last sent a message in first, and a
 * chat with no send yet by when it started (KERNEL-405, KERNEL-498).
 */
export function chatWorkspaces(workspaces: Workspace[], threads: Record<string, Thread>, roomId: string): Workspace[] {
  const touched = (w: Workspace) => { const t = threads[w.threadId!]; return t ? t.lastSentAt ?? t.createdAt : w.createdAt }
  return workspaces.filter((w) => w.roomId === roomId && isLeadChatWorkspace(w) && w.status !== 'archived').sort((a, b) => touched(b) - touched(a) || b.createdAt - a.createdAt)
}

/** Settings, a room, Agents: the one place for a room's agents (KERNEL-642). */
export const roomAgents = (roomId: string): Route => ({ name: 'settings', page: 'room', roomId, section: 'agents' })

/**
 * A room's front door: its top open chat with Rowan in the sidebar, New chat with Rowan when none is open, or the room's Agents page in
 * Settings when the room has no Lead (D-104, KERNEL-405, KERNEL-498, KERNEL-642). Before agents load, which is after the first route is chosen, a room with a workspace
 * marked `lead` has one.
 */
export function roomHome(roomId: string, s: State): Route {
  const chat = chatWorkspaces(s.workspaces, s.threads, roomId).find((w) => !w.folderGone)
  if (chat) return { name: 'workspace', workspaceId: chat.id }
  return frontDoor(roomId, s)
}

/**
 * A room's neutral home: New chat with Rowan, or the room's Agents page in Settings when the room has no Lead (D-104, KERNEL-405, KERNEL-642). It never picks a chat, so it is the
 * same place whatever else is open in the room.
 */
export function frontDoor(roomId: string, s: State): Route {
  const agents = s.agents[roomId]
  const lead = agents ? agents.some((a) => a.lead) : s.workspaces.some((w) => w.roomId === roomId && !!w.lead)
  return lead ? { name: 'leadNew', roomId } : roomAgents(roomId)
}

/**
 * Where an archive takes you (KERNEL-596), one rule for every way a chat or workspace is archived. Archiving the one on screen goes to its
 * room's front door, never History and never another chat. Archiving anything else leaves you where you are, which is nothing here.
 * `archived` says which workspaces the archive just stored.
 */
export function archiveDestination(route: Route, s: State, archived: (workspaceId: string) => boolean): Route | undefined {
  if (route.name !== 'workspace' || !archived(route.workspaceId)) return undefined
  const roomId = s.workspaces.find((w) => w.id === route.workspaceId)?.roomId
  return roomId ? frontDoor(roomId, s) : undefined
}

/** The route if it is still there, else its room's Lead workspace, then the room's Agents page, then Home. */
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
    case 'issues': return { name: 'issues', ...(isText(r.issueId) ? { issueId: r.issueId } : {}), ...(isText(r.roomId) ? { roomId: r.roomId } : {}) }
    case 'workspace': return isText(r.workspaceId) ? { name: 'workspace', workspaceId: r.workspaceId } : undefined
    case 'leadNew': return isText(r.roomId) ? { name: 'leadNew', roomId: r.roomId } : undefined
    // Agents load after the first route is chosen, and older builds saved task, floor and board routes that no longer exist, so these open their room's Agents page in Settings (KERNEL-642).
    case 'team': case 'agent': case 'task': case 'floor': case 'board': return isText(r.roomId) ? roomAgents(r.roomId) : undefined
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
    const shared = paths(t.shared).filter(isText)
    const picks = Object.entries(t.sharedVersion && typeof t.sharedVersion === 'object' ? t.sharedVersion : {}).filter(([id, n]) => shared.includes(id) && Number.isInteger(n))
    tabs[w.id] = {
      ...(isText(t.tab) ? { tab: t.tab } : {}), ...(isText(t.lastChat) ? { lastChat: t.lastChat } : {}), files: paths(t.files), diffs: paths(t.diffs),
      ...(shared.length ? { shared } : {}), ...(picks.length ? { sharedVersion: Object.fromEntries(picks) as Record<string, number> } : {})
    }
  }
  return { route: nearest(route, s), tabs }
}
