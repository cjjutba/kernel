import type { AgentDef, Chat, Room, Thread, Workspace } from '@shared/types'
import { actions, getState, go } from '../../store'
import { chatWorkspaces, leadOf, openLead, openLeadChat } from '../../lead'
import { roomInView } from '../../screens/search/model'
import { focusComposerIn, focusComposerWhenOpen } from '../../screens/workspace/composer/bus'

/** The ⌘1 to ⌘9 shortcuts reach this many Lead chats. */
const MAX_SLOTS = 9

/**
 * One row under a room: the Lead (only while it has no open chat to list), one of the Lead's open chats, or a live workspace.
 * A chat with Rowan is its own workspace (`ws`, KERNEL-405) holding several tabs (`tabs`, the open ones in tab order), so it is
 * one row, whatever its tab count (KERNEL-338). A workspace is `nested` under the chat that handed it off (`Workspace.threadId`).
 * A chat carries those workspaces (`owned`, shown or not) and whether it is `folded`, which hides them.
 */
export type Slot =
  | { kind: 'lead' }
  | { kind: 'chat'; thread: Thread; ws?: Workspace; tabs: Chat[]; owned: Workspace[]; folded: boolean }
  | { kind: 'workspace'; ws: Workspace; nested: boolean }

/** The workspace rows under a room, in store order. A chat with Rowan's own workspace is its chat's row, not one of these. */
export const liveWorkspaces = (workspaces: Workspace[], roomId: string): Workspace[] =>
  workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && !w.lead)

/** A stable key for a row, so the sidebar can look up its number without holding slot objects. */
export const slotKey = (slot: Slot): string => (slot.kind === 'lead' ? 'lead' : slot.kind === 'chat' ? `chat:${slot.thread.id}` : `workspace:${slot.ws.id}`)

/** The open chat tabs of a chat with Rowan's workspace, in tab order: chats, not terminals, and not closed. */
export const openTabs = (chats: Record<string, Chat[]>, workspaceId: string): Chat[] => (chats[workspaceId] ?? []).filter((c) => c.kind === 'chat' && !c.closed)

/** The tab a Lead chat's row opens: the one last shown in it while it is still open, else its first tab. */
export function threadTab(tabs: Chat[], lastTabs: Record<string, string>, threadId: string): Chat | undefined {
  return tabs.find((c) => c.id === lastTabs[threadId]) ?? tabs[0]
}

/**
 * The room's open chats with Rowan, oldest first, each with its workspace and open tabs (D-139, KERNEL-338, KERNEL-405). The title is
 * the thread's, or the first tab's while the thread hasn't reached the store.
 */
export function openThreads(room: Room, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread>): { thread: Thread; ws: Workspace; tabs: Chat[] }[] {
  return chatWorkspaces(workspaces, threads, room.id).map((ws) => {
    const tabs = openTabs(chats, ws.id)
    const id = ws.threadId!
    return { ws, tabs, thread: threads[id] ?? { id, roomId: room.id, title: tabs[0]?.title ?? ws.title ?? ws.name, createdAt: ws.createdAt } }
  })
}

/**
 * Every row under a room, top to bottom (D-139). Each open chat with Rowan is followed by the workspaces it handed off, then come the
 * workspaces no open chat owns (an archived chat's too). A room whose Lead has no open chat keeps one Lead row; a room with no Lead has only
 * workspaces. A chat in `folded` that handed off workspaces hides them; one with none never counts as folded. The sidebar draws these
 * and the shortcuts count them, so the two can't disagree. Workspaces group by `Workspace.threadId`.
 */
export function sidebarRows(
  room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread> = {}, folded: string[] = []
): Slot[] {
  const live = liveWorkspaces(workspaces, room.id)
  const open = openThreads(room, workspaces, chats, threads)
  if (!open.length) return [...(leadOf(agents, room.id) ? [{ kind: 'lead' as const }] : []), ...live.map((ws) => ({ kind: 'workspace' as const, ws, nested: false }))]
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
 * The rows the ⌘1 to ⌘9 shortcuts reach: the Lead's open chats in sidebar order, or the Lead row while it has no open chat (KERNEL-357).
 * Workspace rows get no number, so a chat's number doesn't move when workspaces come and go or a chat is folded. A room with no Lead has none.
 */
export const slotsFor = (
  room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, threads: Record<string, Thread> = {}
): Slot[] => sidebarRows(room, agents, workspaces, chats, threads).filter((r) => r.kind !== 'workspace').slice(0, MAX_SLOTS)

/**
 * Opens the n-th Lead chat (1 to 9) of the room in view, which falls back to the first room on Home, Inbox and History.
 * A number past the last chat does nothing.
 */
export function openSlot(n: number): void {
  const s = getState()
  const room = roomInView(s.ui.route, s.rooms, s.workspaces)
  const slot = room && slotsFor(room, s.agents, s.workspaces, s.chats, s.threads)[n - 1]
  if (!room || !slot) return
  openRow(room.id, slot)
}

/**
 * Opens a row with the caret in the message box of the chat it shows, whether it was clicked or reached with ⌘1 to ⌘9.
 * The Lead row asks the engine which chat to open, and lands on New chat with Rowan when none is open (KERNEL-405).
 */
export function openRow(roomId: string, slot: Slot): void {
  if (slot.kind === 'lead') { void openLead(roomId).then((ws) => focusComposerIn(ws ? ws.id : leadNewKey(roomId))); return }
  if (slot.kind === 'chat') {
    // A Lead chat opens on the tab last shown in it (KERNEL-338), in its own workspace (KERNEL-405).
    const tab = threadTab(slot.tabs, getState().lastTabs, slot.thread.id)
    if (tab) focusComposerWhenOpen(tab.id)
    if (!slot.ws) { if (tab) void openLeadChat(roomId, tab.id); return }
    if (tab) actions.ui.openTab(slot.ws.id, tab.id)
    else focusComposerIn(slot.ws.id)
    go({ name: 'workspace', workspaceId: slot.ws.id })
    return
  }
  focusComposerIn(slot.ws.id)
  go({ name: 'workspace', workspaceId: slot.ws.id })
}

/** The key New chat with Rowan's composer takes focus requests under, since no workspace exists before its first message. */
export const leadNewKey = (roomId: string) => `leadNew:${roomId}`
