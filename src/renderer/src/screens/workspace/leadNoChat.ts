import type { Chat } from '@shared/types'

/**
 * The Lead's workspace with no open chat: a room whose last chat was closed (KERNEL-365). It draws New chat with Rowan in place of a chat,
 * and the chat and its sidebar row appear when the first message is sent (KERNEL-366). A terminal tab is not a chat.
 */
export const leadHasNoChat = (isLead: boolean, chats: Pick<Chat, 'kind' | 'closed'>[]) => isLead && !chats.some((c) => c.kind === 'chat' && !c.closed)

/**
 * What the New tab button and ⌘T do. With no chat on screen there is nothing to add a tab to, so they put the caret in the New chat box
 * instead of calling `chats.create`, which would start a chat row. Only sending from that box starts one.
 */
export function newChatTab<T>(noChat: boolean, focus: () => void, create: () => Promise<T>): Promise<T | undefined> {
  if (!noChat) return create()
  focus()
  return Promise.resolve(undefined)
}
