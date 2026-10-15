import type { ChatArchivePreview, Thread } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState } from '../../store'
import { archiveChatByHand } from './byHand'
import { dropPlace } from './chatPlace'

/** Whether archiving would stop this workspace's work or lose something on it, which the confirm then names (KERNEL-405). */
export const stopsSomething = (w: ChatArchivePreview['workspaces'][number]) => w.running || !!w.pr || w.dirty > 0 || w.unpushed > 0 || !!w.unknown

const archiving = new Set<string>()

/** Whether the chat is being archived by hand, from the click to main's answer. Its workspaces' rows wait for its own row, so they fold together (KERNEL-580). */
export const archivingChat = (threadId: string) => archiving.has(threadId)

/**
 * Archives the Lead chat and its workspaces (KERNEL-405). The row leaving the sidebar says so, so there is no toast (KERNEL-495).
 * Where you go is not decided here: the chat or workspace on screen going archived takes you to the project's front door, the same for every
 * way to archive (archiveLanding.ts, KERNEL-596). That happens in the step that stores the archived status, before main answers, and a failed
 * archive never reaches it, so you stay on the chat and the error is thrown for the caller to show.
 */
export async function archiveChatNow(threadId: string, workspaceIds: string[]): Promise<void> {
  archiving.add(threadId)
  try {
    const chats = workspaceIds.flatMap((id) => getState().chats[id] ?? [])
    await archiveChatByHand(threadId, workspaceIds)
    for (const c of chats) dropPlace(c.id)
  } finally { archiving.delete(threadId) }
}

/**
 * The chat row's Archive, and closing a chat's last tab (KERNEL-405). It archives in one click, like a workspace row, when nothing
 * would be lost. A running agent, an open PR, uncommitted changes, commits not on GitHub yet, or a status Kernel can't read open
 * ConfirmArchiveChat instead, which names them.
 */
export async function archiveChatFromSidebar(thread: Thread): Promise<void> {
  const preview = await call('threads.archivePreview', { threadId: thread.id }).catch(() => null)
  if (!preview || preview.workspaces.some(stopsSomething)) return actions.ui.openModal({ name: 'confirm', kind: 'archiveChat', threadId: thread.id })
  try { await archiveChatNow(thread.id, preview.workspaces.map((w) => w.id)) }
  catch (e) { actions.ui.toast({ title: `Could not archive ${thread.title}`, sub: cleanError(e) }) }
}
