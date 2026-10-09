import type { ChatItem } from './types'

/** First line of Kernel's teammate updates before KERNEL-111. Older Lead chats still hold messages that start with it. */
export const LEGACY_UPDATE_HEADER = 'Update from Kernel (not the user):'

/** A line of an update before KERNEL-117: "- Kai · Inbox actions (workspace <id>): what happened". */
const LEGACY_LINE = /^- .+ \(workspace [^)]+\): /m

/**
 * A Kernel team update to a Lead chat: one that carries the card's data, or an older one that starts with the legacy header.
 * An older one sent again with Retry is marked as Kernel's but still has no card data (KERNEL-116). An unmarked one counts
 * only when its lines are an update's too, so a message the user typed that starts with the old header stays theirs.
 */
export function isKernelUpdate(item: ChatItem): boolean {
  if (item.kind !== 'user') return false
  if (item.update) return true
  if (item.from === 'lead') return false
  const text = item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')
  return text.startsWith(LEGACY_UPDATE_HEADER) && (item.from === 'kernel' || LEGACY_LINE.test(text))
}
