import type { Chat } from '@shared/types'

export const isLeadSeat = (chat: Chat): boolean => chat.kind === 'terminal' && chat.terminal?.preset === 'lead'

/** A Lead seat's tab is named as the Lead's terminal until its title is changed. */
export const seatTitle = (chat: Chat): string => (isLeadSeat(chat) && chat.title === 'Terminal (lead)' ? 'Lead terminal' : chat.title)

/**
 * Whether the tab's seat is connected to Kernel. A tab with no signal reads as connected.
 * TODO(KERNEL-999): read the per-chat seat connection signal Noor adds there, and drop this cast.
 */
export const seatConnected = (chat: Chat): boolean => (chat as Chat & { seat?: { connected: boolean } }).seat?.connected !== false
