import type { AgentDef, Chat, Room, Workspace } from '@shared/types'
import { getState, go } from '../../store'
import { isLeadWorkspace, leadOf, openLead, openLeadChat } from '../../lead'
import { roomInView } from '../../screens/search/model'

/** The ⌘1 to ⌘9 shortcuts reach this many rows. */
const MAX_SLOTS = 9

/**
 * One row under a room: the Lead (only while it has no open chat to list), one of the Lead's open chats, or a live
 * workspace. A workspace is `nested` under the chat that started it (`leadChatId`). A chat carries the workspaces it started
 * (`owned`, shown or not) and whether it is `folded`, which hides them.
 */
export type Slot =
  | { kind: 'lead' }
  | { kind: 'chat'; chat: Chat; owned: Workspace[]; folded: boolean }
  | { kind: 'workspace'; ws: Workspace; nested: boolean }

/** The workspace rows under a room, in store order. */
export const liveWorkspaces = (workspaces: Workspace[], roomId: string): Workspace[] =>
  workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && w.name !== 'lead')

/** A stable key for a row, so the sidebar can look up its number without holding slot objects. */
export const slotKey = (slot: Slot): string => (slot.kind === 'lead' ? 'lead' : slot.kind === 'chat' ? `chat:${slot.chat.id}` : `workspace:${slot.ws.id}`)

/** The id of the room's Lead workspace, once it exists. */
export const leadHomeOf = (room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[]): string | undefined => {
  const lead = leadOf(agents, room.id)
  return lead && workspaces.find((w) => isLeadWorkspace(w, room.id, lead.id))?.id
}

/** The Lead workspace's chats that show as tabs and rows: chats, not terminals, and not closed. Tab order. */
export function openLeadChats(room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>): Chat[] {
  const home = leadHomeOf(room, agents, workspaces)
  return (home ? chats[home] ?? [] : []).filter((c) => c.kind === 'chat' && !c.closed)
}

/**
 * Every row under a room, top to bottom (D-139). Each open Lead chat is followed by the workspaces it started, then come the
 * workspaces with no open owning chat. A room whose Lead has no open chat keeps one Lead row; a room with no Lead has only
 * workspaces. A chat in `folded` that started workspaces hides them; one with none never counts as folded. The sidebar draws these
 * and the shortcuts count them, so the two can't disagree.
 */
export function sidebarRows(room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, folded: string[] = []): Slot[] {
  const live = liveWorkspaces(workspaces, room.id)
  const open = openLeadChats(room, agents, workspaces, chats)
  const home = leadHomeOf(room, agents, workspaces)
  const rows: Slot[] = []
  if (!open.length) {
    // The Lead row stands in for a chat list that came back empty, or for a Lead with no workspace yet. While the list loads, no row flashes in its place.
    if (leadOf(agents, room.id) && (!home || chats[home])) rows.push({ kind: 'lead' })
    return [...rows, ...live.map((ws) => ({ kind: 'workspace' as const, ws, nested: false }))]
  }
  const owned = new Set<string>()
  for (const chat of open) {
    const started = live.filter((ws) => ws.leadChatId === chat.id)
    const hidden = !!started.length && folded.includes(chat.id)
    rows.push({ kind: 'chat', chat, owned: started, folded: hidden })
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
export const slotsFor = (room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[], chats: Record<string, Chat[]>, folded: string[] = []): Slot[] =>
  sidebarRows(room, agents, workspaces, chats, folded).slice(0, MAX_SLOTS)

/**
 * Opens the n-th row (1 to 9) of the room in view, which falls back to the first room on Home, Inbox and History.
 * A number past the last row does nothing.
 */
export function openSlot(n: number): void {
  const s = getState()
  const room = roomInView(s.ui.route, s.rooms, s.workspaces)
  const slot = room && slotsFor(room, s.agents, s.workspaces, s.chats, s.ui.foldedChats)[n - 1]
  if (!room || !slot) return
  if (slot.kind === 'lead') void openLead(room.id)
  else if (slot.kind === 'chat') void openLeadChat(room.id, slot.chat.id)
  else go({ name: 'workspace', workspaceId: slot.ws.id })
}
