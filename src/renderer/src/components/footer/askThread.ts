import { isLeadWorkspace, leadOf } from '../../lead'
import { currentThread, threadIdOf } from '../../nav'
import type { State } from '../../store'

/**
 * The Lead chat a question from Ask Rowan joins (KERNEL-339), or nothing when it starts a chat of its own. You are in a chat when the Lead's
 * workspace is open on one, or when a workspace that chat started is open (it sits under the chat's row). From Home, the Inbox, a workspace no
 * chat started, or a chat that has since closed, there is none, so the answer opens as a new chat.
 */
export function askThreadOf(s: State): string | undefined {
  const route = s.ui.route
  if (route.name !== 'workspace') return undefined
  const ws = s.workspaces.find((w) => w.id === route.workspaceId)
  if (!ws || ws.status === 'archived') return undefined
  if (isLeadWorkspace(ws, ws.roomId, leadOf(s.agents, ws.roomId)?.id)) return currentThread(s, ws.id)
  // A workspace names the chat that handed it off, by thread or, from before threads, by the tab that did.
  const from = ws.leadChatId ? Object.values(s.chats).flat().find((c) => c.id === ws.leadChatId) : undefined
  const id = ws.threadId ?? (from && threadIdOf(from))
  return id && !s.threads[id]?.closedAt ? id : undefined
}
