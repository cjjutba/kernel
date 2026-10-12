import type { Chat, Workspace } from '@shared/types'
import type { Slot } from './slots'

/** A chat is unread from the moment a turn ends in it until it is shown. Unset reads as read, as does every chat from before (KERNEL-507). */
export const isUnread = (chat: Chat): boolean => chat.unreadAt !== undefined

/** Whether a workspace has a chat tab with something new. A terminal runs no turns, and a closed tab can't be opened to read it. */
export const workspaceUnread = (chats: Chat[] | undefined): boolean => !!chats?.some((c) => c.kind === 'chat' && !c.closed && isUnread(c))

/** What a chat row needs from the store to know what is new in it, so the rule can be tested without a window (KERNEL-508). */
export interface ChatUnreadInput {
  /** The chat's open tabs. */
  tabs: Chat[]
  /** The workspaces this chat started. */
  owned: Workspace[]
  /** Every chat the store holds, by workspace id. */
  chats: Record<string, Chat[]>
  folded: boolean
  /** The row on screen. */
  current: boolean
}

/**
 * Whether a Lead chat's row shows a bold title. One rule for the row, like `chatWaits` (KERNEL-339): a chat has something new when one
 * of its tabs does. While it is folded the workspaces it started stand in its row, so one of theirs counts too. The chat you are on is read.
 */
export function chatUnread({ tabs, owned, chats, folded, current }: ChatUnreadInput): boolean {
  if (current) return false
  return tabs.some(isUnread) || (folded && owned.some((w) => workspaceUnread(chats[w.id])))
}

/** Whether a workspace row shows a bold title: one of its chats has something new, and it isn't the row on screen. */
export const workspaceRowUnread = (chats: Chat[] | undefined, current: boolean): boolean => !current && workspaceUnread(chats)

/**
 * Whether a room's row shows a bold title. Only a collapsed room does, since an open one shows its own rows. Anything inside it counts:
 * a Lead chat's tab, a workspace it started (folded or not) or a workspace of its own.
 */
export function roomUnread({ rows, chats, expanded }: { rows: Slot[]; chats: Record<string, Chat[]>; expanded: boolean }): boolean {
  if (expanded) return false
  return rows.some((row) => {
    if (row.kind === 'lead') return false
    if (row.kind === 'workspace') return workspaceUnread(chats[row.ws.id])
    return row.tabs.some(isUnread) || row.owned.some((w) => workspaceUnread(chats[w.id]))
  })
}
