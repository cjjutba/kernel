import { call } from '../../../api'
import { actions } from '../../../store'

/**
 * Retry now: send the last message again at once. The waiting retry is interrupted and the copy goes first. The engine
 * sends it with its sender, so a Kernel update sent again is still Kernel's, not the user's (KERNEL-127).
 */
export async function retryNow(chatId: string) {
  const items = await call('chats.items', { chatId })
  const user = [...items].reverse().find((i) => i.kind === 'user')
  if (user?.kind !== 'user') return
  await call('chats.retry', { chatId, itemId: user.id, now: true })
  actions.chats.setQueue(chatId, await call('chats.queue', { chatId }))
}
