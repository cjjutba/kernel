import type { ChatItem, Toast } from '@shared/types'
import { actions, getState } from '../../store'
import { chatTitle, whoWorks } from './setupFailed'

/**
 * A turn that ended on an error (KERNEL-1094, Pen 7.12). The chat keeps one quiet line, "The turn stopped on an error", and the toast carries the error and its Retry.
 * A turn the reader stopped ends the same way in the data, with an `interrupted` row before its result, and isn't an error. Null for any other item.
 */
export function turnFailedToast(chatId: string, item: ChatItem): Omit<Toast, 'id'> | undefined {
  // A turn that ran into a usage limit has its own choice above the box, so it isn't an error.
  if (item.kind !== 'result' || item.ok || item.limit) return undefined
  const s = getState()
  const items = s.items[chatId] ?? []
  const start = items.map((i) => i.kind).lastIndexOf('user')
  if (items.slice(start + 1).some((i) => i.kind === 'interrupted')) return undefined
  const ws = s.workspaces.find((w) => s.chats[w.id]?.some((c) => c.id === chatId))
  if (!ws) return undefined
  const detail = chatTitle(ws, chatId)
  return { title: `${whoWorks(ws)}'s turn failed`, sub: item.error ?? 'The turn failed.', glyph: 'error', ...(detail ? { detail } : {}), action: { label: 'Retry', retryNow: chatId, primary: true } }
}

/** `chat.item` as the store hears it: a result that is an error raises its toast. */
export function raiseTurnFailed(chatId: string, item: ChatItem) {
  const toast = turnFailedToast(chatId, item)
  if (toast) actions.ui.toast(toast)
}
