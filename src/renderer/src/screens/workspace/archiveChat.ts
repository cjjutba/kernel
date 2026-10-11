import type { ChatArchivePreview, Thread } from '@shared/types'
import { call, cleanError } from '../../api'
import { roomHome } from '../../nav'
import { actions, getState, go } from '../../store'
import { openRow, sidebarRows, type Slot } from '../../components/sidebar/slots'
import { archiveChatByHand } from './byHand'

/** Whether archiving would stop this workspace's work or lose something on it, which the confirm then names (KERNEL-405). */
export const stopsSomething = (w: ChatArchivePreview['workspaces'][number]) => w.running || !!w.pr || w.dirty > 0 || w.unpushed > 0 || !!w.unknown

/** The room's chat rows as the sidebar lists them, top to bottom. */
function chatRows(roomId: string) {
  const s = getState()
  const room = s.rooms.find((r) => r.id === roomId)
  return room ? sidebarRows(room, s.agents, s.workspaces, s.chats, s.threads, s.ui.foldedChats).filter((r): r is Extract<Slot, { kind: 'chat' }> => r.kind === 'chat') : []
}

/**
 * Archives the chat with Rowan and its workspaces, then says so (KERNEL-405). When the chat was on screen, the chat row above it
 * opens, or the one below when it was the first, or the room's front door when no chat is left, as closing a chat did (KERNEL-338).
 */
export async function archiveChatNow(thread: Thread, workspaceIds: string[]): Promise<void> {
  const before = chatRows(thread.roomId)
  const order = before.map((r) => r.thread.id)
  const own = before.find((r) => r.thread.id === thread.id)?.ws?.id
  const route = getState().ui.route
  const shown = route.name === 'workspace' && (route.workspaceId === own || workspaceIds.includes(route.workspaceId))
  await archiveChatByHand(thread.id, workspaceIds)
  actions.ui.toast({ title: `Archived ${thread.title}.`, sub: 'Find it in History.' })
  if (!shown) return
  const rows = chatRows(thread.roomId).filter((r) => r.thread.id !== thread.id)
  const at = order.indexOf(thread.id)
  const next = [...order.slice(0, at).reverse(), ...order.slice(at + 1)].map((id) => rows.find((r) => r.thread.id === id)).find(Boolean) ?? rows[0]
  if (next) openRow(thread.roomId, next)
  else go(roomHome(thread.roomId, getState()))
}

/**
 * The chat row's Archive, and closing a chat's last tab (KERNEL-405). It archives in one click, like a workspace row, when nothing
 * would be lost. A running agent, an open PR, uncommitted changes, commits not on GitHub yet, or a status Kernel can't read open
 * ConfirmArchiveChat instead, which names them.
 */
export async function archiveChatFromSidebar(thread: Thread): Promise<void> {
  const preview = await call('threads.archivePreview', { threadId: thread.id }).catch(() => null)
  if (!preview || preview.workspaces.some(stopsSomething)) return actions.ui.openModal({ name: 'confirm', kind: 'archiveChat', threadId: thread.id })
  try { await archiveChatNow({ ...thread, title: preview.title || thread.title }, preview.workspaces.map((w) => w.id)) }
  catch (e) { actions.ui.toast({ title: `Could not archive ${thread.title}`, sub: cleanError(e) }) }
}
