import type { Chat } from '@shared/types'
import { isChatTab } from '../../nav'

/**
 * The Lead's workspace with no open chat: a room whose last chat was closed (KERNEL-365). It draws New chat with Rowan in place of a chat,
 * and the chat and its sidebar row appear when the first message is sent (KERNEL-366). A terminal tab is not a chat.
 */
export const leadHasNoChat = (isLead: boolean, chats: Pick<Chat, 'kind' | 'closed'>[]) => isLead && !chats.some((c) => c.kind === 'chat' && !c.closed)

/**
 * Whether New chat with Rowan is what the workspace shows. A terminal tab is shown while it is the one open, until + or ⌘T ask for the box (`asked`).
 * `tab` is the open tab, so a file, diff, shared, image or text tab never matches a chat and gives way to the box once the room has no chat.
 */
export const showsNewChat = (noChat: boolean, asked: boolean, chats: Pick<Chat, 'id'>[], tab?: string) => noChat && (asked || !chats.some((c) => c.id === tab))

/** A file, diff, shared, image or text tab is open in front, so it is what the workspace draws. A terminal is not one: it counts as a chat tab here. */
export const tabInFront = (tab?: string) => !!tab && !isChatTab(tab)

/** The New chat box is on screen, not only the state it is picked in: a file, diff or shared tab in front still draws first, and stays selected in the tab row. */
export const newChatOnScreen = (noChat: boolean, asked: boolean, chats: Pick<Chat, 'id'>[], tab?: string) => showsNewChat(noChat, asked, chats, tab) && !tabInFront(tab)

/**
 * What the New tab button and ⌘T do. With no chat on screen there is nothing to add a tab to, so they put the caret in the New chat box
 * instead of calling `chats.create`, which would start a chat row. Only sending from that box starts one.
 */
export function newChatTab<T>(noChat: boolean, focus: () => void, create: () => Promise<T>): Promise<T | undefined> {
  if (!noChat) return create()
  focus()
  return Promise.resolve(undefined)
}
