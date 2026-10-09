import type { ChatItem } from './types'

/** First line of Kernel's teammate updates before KERNEL-111. Older Lead chats still hold messages that start with it. */
export const LEGACY_UPDATE_HEADER = 'Update from Kernel (not the user):'

/** A Kernel team update to a Lead chat: one that carries the card's data, or an older one that starts with the legacy header. */
export function isKernelUpdate(item: ChatItem): boolean {
  if (item.kind !== 'user') return false
  if (item.update) return true
  const first = item.parts[0]
  return !item.from && first?.type === 'text' && first.text.startsWith(LEGACY_UPDATE_HEADER)
}
