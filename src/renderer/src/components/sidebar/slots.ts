import type { AgentDef, Chat, Project, Route, Thread, Workspace } from '@shared/types'
import { actions, getState, go } from '../../store'
import { chatWorkspaces, isLeadWorkspace, leadOf, openLead, openLeadChat } from '../../lead'
import { projectInView } from '../../screens/search/model'
import { focusComposerIn, focusComposerWhenOpen } from '../../screens/workspace/composer/bus'

/** The ⌘1 to ⌘9 shortcuts reach this many Lead chats. */
const MAX_SLOTS = 9

/**
 * One row under a project: the Lead (only while it has no open chat to list), one of the Lead's open chats, or a live workspace.
 * A Lead chat is its own workspace (`ws`, KERNEL-405) holding several tabs (`tabs`, the open ones in tab order), so it is
 * one row, whatever its tab count (KERNEL-338). A workspace is `nested` under the chat that handed it off (`Workspace.threadId`).
 * A chat carries those workspaces (`owned`, shown or not) and whether it is `folded`, which hides them.
 */
export type Slot =
  | { kind: 'lead' }
  | { kind: 'chat'; thread: Thread; ws?: Workspace; tabs: Chat[]; owned: Workspace[]; folded: boolean }
  | { kind: 'workspace'; ws: Workspace; nested: boolean }

/** The workspace rows under a project, in store order. A Lead chat's own workspace is its chat's row, not one of these. */
export const liveWorkspaces = (workspaces: Workspace[], projectId: string): Workspace[] =>
  workspaces.filter((w) => w.projectId === projectId && w.status !== 'archived' && !w.lead)

/** A stable key for a row, so the sidebar can look up its number without holding slot objects. */
export const slotKey = (slot: Slot): string => (slot.kind === 'lead' ? 'lead' : slot.kind === 'chat' ? `chat:${slot.thread.id}` : `workspace:${slot.ws.id}`)

/** The open chat tabs of a Lead chat's workspace, in tab order: chats, not terminals, and not closed. */
export const openTabs = (chats: Record<string, Chat[]>, workspaceId: string): Chat[] => (chats[workspaceId] ?? []).filter((c) => c.kind === 'chat' && !c.closed)

/** The tab a Lead chat's row opens: the one last shown in it while it is still open, else its first tab. */
export function threadTab(tabs: Chat[], lastTabs: Record<string, string>, threadId: string): Chat | undefined {
  return tabs.find((c) => c.id === lastTabs[threadId]) ?? tabs[0]
}

/**
 * The project's open Lead chats, each with its workspace and open tabs (D-139, KERNEL-338, KERNEL-405). The chat the user last sent a
 * message in comes first, and one with no send yet goes by when it started (KERNEL-498). The title is the thread's, or the first tab's
 * while the thread hasn't reached the store.
 */
export function openThreads(project: Project, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread>): { thread: Thread; ws: Workspace; tabs: Chat[] }[] {
  return chatWorkspaces(workspaces, threads, project.id).map((ws) => {
    const tabs = openTabs(chats, ws.id)
    const id = ws.threadId!
    return { ws, tabs, thread: threads[id] ?? { id, projectId: project.id, title: tabs[0]?.title ?? ws.title ?? ws.name, createdAt: ws.createdAt } }
  })
}

/**
 * Every row under a project, top to bottom (D-139). Each open Lead chat, the one last sent in first (KERNEL-498), is followed by the
 * workspaces it handed off, oldest first, then come the workspaces no open chat owns (an archived chat's too). A project whose Lead has no
 * open chat keeps one Lead row; a project with no Lead has only workspaces. A chat in `folded` that handed off workspaces hides them; one
 * with none never counts as folded. The sidebar draws these and the shortcuts count them, so the two can't disagree. Workspaces group
 * by `Workspace.threadId`.
 */
export function sidebarRows(
  project: Project, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread> = {}, folded: string[] = []
): Slot[] {
  const live = liveWorkspaces(workspaces, project.id)
  const open = openThreads(project, workspaces, chats, threads)
  if (!open.length) return [...(leadOf(agents, project.id) ? [{ kind: 'lead' as const }] : []), ...live.map((ws) => ({ kind: 'workspace' as const, ws, nested: false }))]
  const rows: Slot[] = []
  const owned = new Set<string>()
  for (const { thread, ws: home, tabs } of open) {
    const started = live.filter((ws) => ws.threadId === thread.id)
    // Before threads a fold was kept under the chat's id. Migration 5 gave each such chat a thread of its own, so a fold under any tab's id still counts.
    const hidden = !!started.length && (folded.includes(thread.id) || tabs.some((c) => folded.includes(c.id)))
    rows.push({ kind: 'chat', thread, ws: home, tabs, owned: started, folded: hidden })
    for (const ws of started) { owned.add(ws.id); if (!hidden) rows.push({ kind: 'workspace', ws, nested: true }) }
  }
  for (const ws of live) if (!owned.has(ws.id)) rows.push({ kind: 'workspace', ws, nested: false })
  return rows
}

/**
 * What holds the row of the page in view: its project, and the chat that folded it away when it is a workspace under a folded chat. Nothing when no
 * row stands for the page (any page but a workspace or New chat, an archived workspace, a project that isn't listed). The sidebar opens
 * these two, and no other project or chat, when you arrive on a page whose row is hidden. Reads the rows the sidebar draws, so the two agree.
 */
export function rowHolder(
  route: Route, projects: Project[], agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread>, folded: string[]
): { projectId: string; unfold?: Extract<Slot, { kind: 'chat' }> } | undefined {
  const ws = route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId) : undefined
  const project = projects.find((r) => r.id === (route.name === 'leadNew' ? route.projectId : ws?.projectId))
  if (!project) return undefined
  const rows = sidebarRows(project, agents, workspaces, chats, threads, folded)
  if (!ws) return rows.some((r) => r.kind === 'lead') ? { projectId: project.id } : undefined
  // The Lead row stands for the project's Lead workspace while no chat is open; a chat row for its own workspace, or for the one its tabs are in.
  const leadId = leadOf(agents, project.id)?.id
  const listed = (r: Slot) => (r.kind === 'lead' ? isLeadWorkspace(ws, project.id, leadId) : r.kind === 'workspace' ? r.ws.id === ws.id : (r.ws ? r.ws.id : r.tabs[0]?.workspaceId) === ws.id)
  if (rows.some(listed)) return { projectId: project.id }
  const unfold = rows.find((r): r is Extract<Slot, { kind: 'chat' }> => r.kind === 'chat' && r.folded && r.owned.some((w) => w.id === ws.id))
  return unfold && { projectId: project.id, unfold }
}

/**
 * A chat list that came back from `chats.list`, merged with what the store holds by then. A `chat` push can create a one-chat list
 * before the fetch lands, so the pushed copy wins over the fetched one and a chat only the push knows about is kept.
 */
export function mergeChatList(fetched: Chat[], current: Chat[] | undefined): Chat[] {
  if (!current?.length) return fetched
  const pushed = new Map(current.map((c) => [c.id, c]))
  const known = new Set(fetched.map((c) => c.id))
  return [...fetched.map((c) => pushed.get(c.id) ?? c), ...current.filter((c) => !known.has(c.id))]
}

/**
 * The rows the ⌘1 to ⌘9 shortcuts reach: the Lead's open chats in sidebar order, so ⌘1 is the chat last sent in, or the Lead row while it
 * has no open chat (KERNEL-357, KERNEL-498).
 * Workspace rows get no number, so a chat's number doesn't move when workspaces come and go or a chat is folded. A project with no Lead has none.
 */
export const slotsFor = (
  project: Project, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread> = {}
): Slot[] => sidebarRows(project, agents, workspaces, chats, threads).filter((r) => r.kind !== 'workspace').slice(0, MAX_SLOTS)

/**
 * Opens the n-th Lead chat (1 to 9) of the project in view, which falls back to the first project on Home, Inbox and History.
 * A number past the last chat does nothing.
 */
export function openSlot(n: number): void {
  const s = getState()
  const project = projectInView(s.ui.route, s.projects, s.workspaces)
  const slot = project && slotsFor(project, s.agents, s.workspaces, s.chats, s.threads)[n - 1]
  if (!project || !slot) return
  openRow(project.id, slot)
}

/**
 * The workspaces the ⌃1 to ⌃9 shortcuts reach: those the current chat handed off, oldest first as the sidebar draws them, folded away or not
 * (KERNEL-814). The current chat is the one whose row holds the page in view: the Lead chat you are in, or the chat that handed off the
 * workspace you are in while that chat is open. Any other page, and a workspace no open chat owns, has none.
 */
export function workspaceSlotsFor(
  route: Route, project: Project, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread> = {}
): Workspace[] {
  if (route.name !== 'workspace') return []
  const id = route.workspaceId
  const chat = sidebarRows(project, agents, workspaces, chats, threads).find((r): r is Extract<Slot, { kind: 'chat' }> => r.kind === 'chat' && (r.ws?.id === id || r.owned.some((w) => w.id === id)))
  return chat ? chat.owned.slice(0, MAX_SLOTS) : []
}

/** Opens the n-th workspace (1 to 9) of the current chat. With no current chat, or a number past the last workspace, it returns false and does nothing. */
export function openWorkspaceSlot(n: number): boolean {
  const s = getState()
  const route = s.ui.route
  const project = route.name === 'workspace' ? s.projects.find((r) => r.id === s.workspaces.find((w) => w.id === route.workspaceId)?.projectId) : undefined
  const ws = project && workspaceSlotsFor(route, project, s.agents, s.workspaces, s.chats, s.threads)[n - 1]
  if (!project || !ws) return false
  openRow(project.id, { kind: 'workspace', ws, nested: true })
  return true
}

/**
 * Opens a row with the caret in the message box of the chat it shows, whether it was clicked or reached with ⌘1 to ⌘9.
 * The Lead row asks the engine which chat to open, and lands on New chat when none is open (KERNEL-405).
 */
export function openRow(projectId: string, slot: Slot): void {
  if (slot.kind === 'lead') { void openLead(projectId).then((ws) => focusComposerIn(ws ? ws.id : leadNewKey(projectId))); return }
  if (slot.kind === 'chat') {
    // A Lead chat opens on the tab last shown in it (KERNEL-338), in its own workspace (KERNEL-405).
    const tab = threadTab(slot.tabs, getState().lastTabs, slot.thread.id)
    if (tab) focusComposerWhenOpen(tab.id)
    if (!slot.ws) { if (tab) void openLeadChat(projectId, tab.id); return }
    if (tab) actions.ui.openTab(slot.ws.id, tab.id)
    else focusComposerIn(slot.ws.id)
    go({ name: 'workspace', workspaceId: slot.ws.id })
    return
  }
  focusComposerIn(slot.ws.id)
  go({ name: 'workspace', workspaceId: slot.ws.id })
}

/** The key New chat's composer takes focus requests under, since no workspace exists before its first message. */
export const leadNewKey = (projectId: string) => `leadNew:${projectId}`
