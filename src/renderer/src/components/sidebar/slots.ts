import type { AgentDef, Chat, Room, Thread, Workspace } from '@shared/types'
import { getState, go } from '../../store'
import { isLeadWorkspace, leadOf, openLead, openLeadChat } from '../../lead'
import { threadIdOf } from '../../nav'
import { roomInView } from '../../screens/search/model'
import { focusComposerIn, focusComposerWhenOpen } from '../../screens/workspace/composer/bus'

/** The ⌘1 to ⌘9 shortcuts reach this many rows. */
const MAX_SLOTS = 9

/**
 * One row under a room: the Lead (only while it has no open chat to list), one of the Lead's open chats, or a live workspace.
 * A Lead chat holds several tabs (`tabs`, the open ones in tab order), so it is one row, whatever its tab count (KERNEL-338).
 * A workspace is `nested` under the chat whose tabs handed it off (`Workspace.threadId`). A chat carries those workspaces
 * (`owned`, shown or not) and whether it is `folded`, which hides them.
 */
export type Slot =
  | { kind: 'lead' }
  | { kind: 'chat'; thread: Thread; tabs: Chat[]; owned: Workspace[]; folded: boolean }
  | { kind: 'workspace'; ws: Workspace; nested: boolean }

/** The workspace rows under a room, in store order. */
export const liveWorkspaces = (workspaces: Workspace[], roomId: string): Workspace[] =>
  workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && w.name !== 'lead')

/** A stable key for a row, so the sidebar can look up its number without holding slot objects. */
export const slotKey = (slot: Slot): string => (slot.kind === 'lead' ? 'lead' : slot.kind === 'chat' ? `chat:${slot.thread.id}` : `workspace:${slot.ws.id}`)

/** The id of the room's Lead workspace, once it exists. */
export const leadHomeOf = (room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[]): string | undefined => {
  const lead = leadOf(agents, room.id)
  return lead && workspaces.find((w) => isLeadWorkspace(w, room.id, lead.id))?.id
}

/** The Lead workspace's chats that show as tabs: chats, not terminals, and not closed. Tab order. */
export function openLeadChats(room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>): Chat[] {
  const home = leadHomeOf(room, agents, workspaces)
  return (home ? chats[home] ?? [] : []).filter((c) => c.kind === 'chat' && !c.closed)
}

/** The tab a Lead chat's row opens: the one last shown in it while it is still open, else its first tab. */
export function threadTab(tabs: Chat[], lastTabs: Record<string, string>, threadId: string): Chat | undefined {
  return tabs.find((c) => c.id === lastTabs[threadId]) ?? tabs[0]
}

/**
 * The Lead's open chats, in the order of their first open tab, each with its open tabs (D-139, KERNEL-338). The title is the thread's, or the
 * first tab's while the thread hasn't reached the store. A thread with no open tab is closed and has no row.
 */
export function openThreads(open: Chat[], threads: Record<string, Thread>, roomId: string): { thread: Thread; tabs: Chat[] }[] {
  const groups = new Map<string, Chat[]>()
  for (const c of open) groups.set(threadIdOf(c), [...(groups.get(threadIdOf(c)) ?? []), c])
  return [...groups].map(([id, tabs]) => ({ thread: threads[id] ?? { id, roomId, title: tabs[0].title, createdAt: tabs[0].createdAt }, tabs }))
}

/**
 * Every row under a room, top to bottom (D-139). Each open Lead chat is followed by the workspaces its tabs handed off, then come the
 * workspaces no open chat owns (a closed chat's too). A room whose Lead has no open chat keeps one Lead row; a room with no Lead has only
 * workspaces. A chat in `folded` that handed off workspaces hides them; one with none never counts as folded. The sidebar draws these
 * and the shortcuts count them, so the two can't disagree. Workspaces group by `Workspace.threadId`, falling back to the chat
 * `leadChatId` names, so a workspace handed off by a tab that was closed since stays with its chat.
 */
export function sidebarRows(
  room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread> = {}, folded: string[] = []
): Slot[] {
  const live = liveWorkspaces(workspaces, room.id)
  const home = leadHomeOf(room, agents, workspaces)
  const all = home ? chats[home] ?? [] : []
  const open = openThreads(openLeadChats(room, agents, workspaces, chats), threads, room.id)
  const rows: Slot[] = []
  if (!open.length) {
    // The Lead row stands in for a chat list that came back empty, or for a Lead with no workspace yet. While the list loads, no row flashes in its place.
    if (leadOf(agents, room.id) && (!home || chats[home])) rows.push({ kind: 'lead' })
    return [...rows, ...live.map((ws) => ({ kind: 'workspace' as const, ws, nested: false }))]
  }
  const threadOfChat = new Map(all.map((c) => [c.id, threadIdOf(c)]))
  const owner = (ws: Workspace) => ws.threadId ?? (ws.leadChatId ? threadOfChat.get(ws.leadChatId) : undefined)
  const owned = new Set<string>()
  for (const { thread, tabs } of open) {
    const started = live.filter((ws) => owner(ws) === thread.id)
    const hidden = !!started.length && folded.includes(thread.id)
    rows.push({ kind: 'chat', thread, tabs, owned: started, folded: hidden })
    for (const ws of started) { owned.add(ws.id); if (!hidden) rows.push({ kind: 'workspace', ws, nested: true }) }
  }
  for (const ws of live) if (!owned.has(ws.id)) rows.push({ kind: 'workspace', ws, nested: false })
  return rows
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

/** The rows the ⌘1 to ⌘9 shortcuts reach. */
export const slotsFor = (
  room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread> = {}, folded: string[] = []
): Slot[] => sidebarRows(room, agents, workspaces, chats, threads, folded).slice(0, MAX_SLOTS)

/**
 * Opens the n-th row (1 to 9) of the room in view, which falls back to the first room on Home, Inbox and History.
 * A number past the last row does nothing.
 */
export function openSlot(n: number): void {
  const s = getState()
  const room = roomInView(s.ui.route, s.rooms, s.workspaces)
  const slot = room && slotsFor(room, s.agents, s.workspaces, s.chats, s.threads, s.ui.foldedChats)[n - 1]
  if (!room || !slot) return
  openRow(room.id, slot)
}

/**
 * Opens a row with the caret in the message box of the chat it shows, whether it was clicked or reached with ⌘1 to ⌘9.
 * The Lead row's workspace may not exist until `lead.open` makes it, so that row asks once the answer is back.
 */
export function openRow(roomId: string, slot: Slot): void {
  if (slot.kind === 'lead') { void openLead(roomId).then((ws) => { if (ws) focusComposerIn(ws.id) }); return }
  if (slot.kind === 'chat') {
    // A Lead chat opens on the tab last shown in it (KERNEL-338).
    const tab = threadTab(slot.tabs, getState().lastTabs, slot.thread.id)
    if (!tab) return
    focusComposerWhenOpen(tab.id)
    void openLeadChat(roomId, tab.id)
    return
  }
  focusComposerIn(slot.ws.id)
  go({ name: 'workspace', workspaceId: slot.ws.id })
}
