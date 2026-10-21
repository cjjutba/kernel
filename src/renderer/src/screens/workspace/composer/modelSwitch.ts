import type { Toast } from '@shared/types'
import { formatTokens } from './formatTokens'

/**
 * Switching models in a chat that has run a turn says what it costs (KERNEL-771, KERNEL-1095): the next turn reads the whole chat again on the new model's cache. Undo goes back
 * through the screen that registered `key`, the chat's composer (retry.ts).
 */
export const switchToast = (label: string, tokens: number | undefined, key: string): Omit<Toast, 'id'> => ({
  title: `Switched to ${label}`,
  sub: tokens ? `The next turn re-reads ${formatTokens(tokens)} tokens on ${label}.` : `The next turn re-reads the chat on ${label}.`,
  glyph: 'switch',
  action: { label: 'Undo', retry: key }
})
export const SWITCH_TOAST_MS = 6000

const ranOn = new Map<string, string>()

export const noteOpened = (chatId: string, model: string) => { if (!ranOn.has(chatId)) ranOn.set(chatId, model) }
export const noteSent = (chatId: string, model: string) => { ranOn.set(chatId, model) }
export const lastRanOn = (chatId: string) => ranOn.get(chatId)

export const warnsOnSwitch = (started: boolean, lastRan: string | undefined, next: string) => started && lastRan !== undefined && lastRan !== next
