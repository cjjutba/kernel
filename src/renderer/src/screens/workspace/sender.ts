import type { ChatItem } from '@shared/types'
import { isKernelUpdate } from '@shared/teamUpdate'

/**
 * How the transcript draws a user message (KERNEL-120). The user's own messages, and the Lead's briefs and follow-ups in
 * a teammate's chat, are the bubble WorkspaceMerged.png shows. Kernel's team updates are a card; Kernel's other messages,
 * such as its restart and limit nudges, are a note.
 */
export type UserView = 'bubble' | 'update' | 'note'

export function userView(item: Extract<ChatItem, { kind: 'user' }>): UserView {
  // An unmarked message with the old header is an update only when its lines are an update's, not one the user typed.
  if (isKernelUpdate(item) && (item.update || item.from || LEGACY_LINE.test(text(item)))) return 'update'
  if (item.from === 'kernel') return 'note'
  return 'bubble'
}

/** A line of a teammate update before KERNEL-117: "- Kai · Inbox actions (workspace <id>): what happened". */
const LEGACY_LINE = /^- .+ \(workspace [^)]+\): /m

const text = (item: Extract<ChatItem, { kind: 'user' }>) => item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')
