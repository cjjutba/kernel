import type { ChatArchivePreview, Thread } from '@shared/types'
import { call, cleanError } from '../../api'
import { roomHome } from '../../nav'
import { actions, getState, go, subscribe } from '../../store'
import { openRow, sidebarRows, type Slot } from '../../components/sidebar/slots'
import { archiveChatByHand } from './byHand'

/** Whether archiving would stop this workspace's work or lose something on it, which the confirm then names (KERNEL-405). */
export const stopsSomething = (w: ChatArchivePreview['workspaces'][number]) => w.running || !!w.pr || w.dirty > 0 || w.unpushed > 0 || !!w.unknown

const archiving = new Set<string>()

/** Whether the chat is being archived by hand, from the click to main's answer. Its workspaces' rows wait for its own row, so they fold together (KERNEL-580). */
export const archivingChat = (threadId: string) => archiving.has(threadId)

/** The room's chat rows as the sidebar lists them, top to bottom. */
function chatRows(roomId: string) {
  const s = getState()
  const room = s.rooms.find((r) => r.id === roomId)
  return room ? sidebarRows(room, s.agents, s.workspaces, s.chats, s.threads, s.ui.foldedChats).filter((r): r is Extract<Slot, { kind: 'chat' }> => r.kind === 'chat') : []
}

/**
 * Archives the chat with Rowan and its workspaces (KERNEL-405). The row leaving the sidebar says so, so there is no toast (KERNEL-495).
 * When the chat is on screen, the chat row above it opens, or the one below when it was the first, or the room's front door when
 * no chat is left, as closing a chat did (KERNEL-338). Main stops sessions and removes worktrees before it answers, so the move
 * doesn't wait for that: the order of rows is read now, and the route leaves in the step that stores the archived workspace, before
 * the browser paints the workspace stripped of its tabs (KERNEL-578, as KERNEL-547 did for PrHeader). A failed archive never reaches
 * that step, so you stay on the chat.
 */
export async function archiveChatNow(thread: Thread, workspaceIds: string[]): Promise<void> {
  archiving.add(thread.id)
  const before = chatRows(thread.roomId)
  const order = before.map((r) => r.thread.id)
  const at = order.indexOf(thread.id)
  const after = at < 0 ? order : [...order.slice(0, at).reverse(), ...order.slice(at + 1)]
  const own = before[at]?.ws?.id
  const mine = new Set(own ? [own, ...workspaceIds] : workspaceIds)
  const onMine = () => {
    const route = getState().ui.route
    return route.name === 'workspace' && mine.has(route.workspaceId) ? route.workspaceId : undefined
  }
  let left = false
  const leave = () => {
    left = true
    const rows = chatRows(thread.roomId).filter((r) => r.thread.id !== thread.id)
    const next = after.map((id) => rows.find((r) => r.thread.id === id)).find(Boolean) ?? rows[0]
    if (next) openRow(thread.roomId, next)
    else go(roomHome(thread.roomId, getState()))
  }
  // A listener, not an effect: the archived status is applied and the route moves in one synchronous step, and no screen has to be
  // mounted for it. `left` stops the moves it makes from running it again.
  const stop = subscribe(() => {
    if (left) return
    const id = onMine()
    if (id && getState().workspaces.find((w) => w.id === id)?.status === 'archived') leave()
  })
  try { await archiveChatByHand(thread.id, workspaceIds) } finally { stop(); archiving.delete(thread.id) }
  if (!left && onMine()) leave()
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
