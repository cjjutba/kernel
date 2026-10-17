import type { Chat } from '@shared/types'

export const isLeadSeat = (chat: Chat): boolean => chat.kind === 'terminal' && chat.terminal?.preset === 'lead'

/** A Lead seat's tab is named as the Lead's terminal until its title is changed. */
export const seatTitle = (chat: Chat): string => (isLeadSeat(chat) && chat.title === 'Terminal (lead)' ? 'Lead terminal' : chat.title)

/** Whether the tab is a seat that Kernel does not hear from now. A terminal that is not a seat has no signal and reads as connected. */
export const seatConnected = (chat: Chat): boolean => chat.seat?.connected !== false

/** The key a tab's Terminal or Transcript choice is kept under, so each tab remembers its own (DESIGN.md, Remembered choices). */
export const seatViewKey = (chatId: string) => `kernel.seatView.${chatId}`
