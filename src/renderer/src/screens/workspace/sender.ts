import type { ChatItem } from '@shared/types'
import { isKernelUpdate } from '@shared/teamUpdate'

/**
 * How the transcript draws a user message (KERNEL-120). The user's own messages, and the Lead's briefs and follow-ups in
 * a teammate's chat, are the bubble WorkspaceMerged.png shows. Kernel's team updates are a card; Kernel's other messages,
 * such as its restart and limit nudges, are a note.
 */
export type UserView = 'bubble' | 'update' | 'note'

export function userView(item: Extract<ChatItem, { kind: 'user' }>): UserView {
  // An unmarked message with the old header is an update only when its lines are an update's (`isKernelUpdate`).
  if (isKernelUpdate(item)) return 'update'
  if (item.from === 'kernel') return 'note'
  return 'bubble'
}
