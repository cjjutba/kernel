import type { Chat, NewChatPicks, Route, Thread, UiState, Workspace, WorkspaceSource } from '@shared/types'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import type { State } from './store'

/**
 * Where you are: a route and, on a workspace, the tab open in it. Pure functions over `State` live here, importing nothing that needs one,
 * so tests and the store use them without a window.
 */
export interface Place { route: Route; tab?: string }

const visible = (r: { hidden?: boolean; archived?: boolean }) => !r.hidden && !r.archived
const projectVisible = (s: State, projectId: string) => { const r = s.projects.find((x) => x.id === projectId); return !!r && visible(r) }

/** The project a route belongs to, if it belongs to one. */
export function projectOf(route: Route, s: State): string | undefined {
  if (route.name === 'workspace') return s.workspaces.find((w) => w.id === route.workspaceId)?.projectId
  return 'projectId' in route ? route.projectId : undefined
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
 * hidden or archived project, or a Settings page of a project that is gone. Opening a workspace with no folder still works: only
 * reopening at launch, ⌘[ and Back to app skip it.
 */
export function stillThere(route: Route, s: State): boolean {
  if (route.name === 'workspace') {
    const ws = s.workspaces.find((w) => w.id === route.workspaceId)
    return !!ws && ws.status !== 'archived' && !ws.folderGone && projectVisible(s, ws.projectId)
  }
  if (route.name === 'onboarding') return true
  if (route.name === 'settings') return route.page !== 'project' || (!!route.projectId && projectVisible(s, route.projectId))
  if ('projectId' in route && route.projectId) return projectVisible(s, route.projectId)
  return true
}

/**
 * The workspaces of the project's open Lead chats as the sidebar lists them: the one the user last sent a message in first, and a
 * chat with no send yet by when it started (KERNEL-405, KERNEL-498).
 */
export function chatWorkspaces(workspaces: Workspace[], threads: Record<string, Thread>, projectId: string): Workspace[] {
  const touched = (w: Workspace) => { const t = threads[w.threadId!]; return t ? t.lastSentAt ?? t.createdAt : w.createdAt }
  return workspaces.filter((w) => w.projectId === projectId && isLeadChatWorkspace(w) && w.status !== 'archived').sort((a, b) => touched(b) - touched(a) || b.createdAt - a.createdAt)
}

/** Settings, a project, Agents: the one place for a project's agents (KERNEL-642). */
export const projectAgents = (projectId: string): Route => ({ name: 'settings', page: 'project', projectId, section: 'agents' })

/**
 * A project's front door: its top open Lead chat in the sidebar, New chat when none is open, or the project's Agents page in
 * Settings when the project has no Lead (D-104, KERNEL-405, KERNEL-498, KERNEL-642). Before agents load, which is after the first route is chosen, a project with a workspace
 * marked `lead` has one.
 */
export function projectHome(projectId: string, s: State): Route {
  const chat = chatWorkspaces(s.workspaces, s.threads, projectId).find((w) => !w.folderGone)
  if (chat) return { name: 'workspace', workspaceId: chat.id }
  return frontDoor(projectId, s)
}

/**
 * A project's neutral home: New chat, or the project's Agents page in Settings when the project has no Lead (D-104, KERNEL-405, KERNEL-642). It never picks a chat, so it is the
 * same place whatever else is open in the project.
 */
export function frontDoor(projectId: string, s: State): Route {
  const agents = s.agents[projectId]
  const lead = agents ? agents.some((a) => a.lead) : s.workspaces.some((w) => w.projectId === projectId && !!w.lead)
  return lead ? { name: 'leadNew', projectId } : projectAgents(projectId)
}

/**
 * Where an archive takes you (KERNEL-596), one rule for every way a chat or workspace is archived. Archiving the one on screen goes to its
 * project's front door, never History and never another chat. Archiving anything else leaves you where you are, which is nothing here.
 * `archived` says which workspaces the archive just stored.
 */
export function archiveDestination(route: Route, s: State, archived: (workspaceId: string) => boolean): Route | undefined {
  if (route.name !== 'workspace' || !archived(route.workspaceId)) return undefined
  const projectId = s.workspaces.find((w) => w.id === route.workspaceId)?.projectId
  return projectId ? frontDoor(projectId, s) : undefined
}

/** Where the app lands when nothing better is known: New chat in the first visible project, or Welcome when there is no project. */
export function landing(s: State, projectId?: string): Route {
  const project = s.projects.find((r) => r.id === projectId && projectVisible(s, r.id)) ?? s.projects.find((r) => projectVisible(s, r.id))
  return project ? frontDoor(project.id, s) : { name: 'onboarding', step: 'welcome' }
}

/** The route if it is still there, else its project's Lead workspace, then the project's Agents page, then New chat in the first project, then Welcome. */
export function nearest(route: Route, s: State): Route {
  if (stillThere(route, s)) return route
  const projectId = projectOf(route, s)
  if (projectId && projectVisible(s, projectId)) {
    const home = projectHome(projectId, s)
    if (stillThere(home, s)) return home
  }
  return landing(s)
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

/** What New chat starts from, as a saved route holds it, or nothing when it isn't one of the three kinds. */
function soundSource(v: any): WorkspaceSource | undefined {
  if (v?.kind === 'issue' && isText(v.id) && typeof v.title === 'string') return { kind: 'issue', id: v.id, title: v.title, ...(isText(v.url) ? { url: v.url } : {}), ...(['linear', 'github'].includes(v.tracker) ? { tracker: v.tracker } : {}) }
  if (v?.kind === 'pr' && typeof v.number === 'number' && typeof v.title === 'string') return { kind: 'pr', number: v.number, title: v.title }
  if (v?.kind === 'branch' && isText(v.branch)) return { kind: 'branch', branch: v.branch }
  return undefined
}

/** What New chat had picked, as a saved route holds it, or nothing when a field is missing or the wrong type. */
function soundPicks(v: any): NewChatPicks | undefined {
  const ok = (v?.mode === 'worktree' || v?.mode === 'current') && isText(v.model) && isText(v.effort) && typeof v.plan === 'boolean' && typeof v.baseRef === 'string'
  return ok ? { mode: v.mode, model: v.model, effort: v.effort, plan: v.plan, baseRef: v.baseRef } : undefined
}

/**
 * A saved route made sound, or nothing. Missing ids would open a screen with no project or workspace, so they are rejected here. A
 * route saved before rooms were renamed projects (KERNEL-880) says `rooms` and `roomId`, and reads as `projects` and `projectId`.
 */
function soundRoute(saved: any): Route | undefined {
  const r = saved && typeof saved === 'object' ? { ...saved, name: saved.name === 'rooms' ? 'projects' : saved.name, projectId: saved.projectId ?? saved.roomId } : saved
  switch (r?.name) {
    case 'inbox': case 'projects': return { name: r.name }
    case 'history': return { name: 'history', ...(isText(r.projectId) ? { projectId: r.projectId } : {}) }
    case 'issues': return { name: 'issues', ...(isText(r.issueId) ? { issueId: r.issueId } : {}), ...(isText(r.projectId) ? { projectId: r.projectId } : {}) }
    case 'workspace': return isText(r.workspaceId) ? { name: 'workspace', workspaceId: r.workspaceId } : undefined
    case 'leadNew': return isText(r.projectId) ? { name: 'leadNew', projectId: r.projectId, ...(soundSource(r.source) ? { source: soundSource(r.source) } : {}), ...(soundPicks(r.picks) ? { picks: soundPicks(r.picks) } : {}) } : undefined
    // Agents load after the first route is chosen, and older builds saved task, floor and board routes that no longer exist, so these open their project's Agents page in Settings (KERNEL-642).
    case 'team': case 'agent': case 'task': case 'floor': case 'board': return isText(r.projectId) ? projectAgents(r.projectId) : undefined
    default: return undefined // onboarding, devUi, settings and anything unknown are never reopened
  }
}

/**
 * Reads `kernel.lastPlace` into where to open and the tabs to bring back. The tabs are only those of workspaces that are still live, and
 * the route is the nearest place that is still there (a closed workspace opens its project's Lead chat, a removed project opens New chat in another project). Nothing
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
    const recent = paths(t.recent).filter(isText).slice(0, 20)
    tabs[w.id] = {
      ...(isText(t.tab) ? { tab: t.tab } : {}), ...(isText(t.lastChat) ? { lastChat: t.lastChat } : {}), files: paths(t.files), diffs: paths(t.diffs),
      ...(shared.length ? { shared } : {}), ...(picks.length ? { sharedVersion: Object.fromEntries(picks) as Record<string, number> } : {}),
      ...(recent.length ? { recent } : {})
    }
  }
  return { route: nearest(route, s), tabs }
}
