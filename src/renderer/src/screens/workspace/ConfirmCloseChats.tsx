import { useState } from 'react'
import type { Thread } from '@shared/types'
import { call, cleanError } from '../../api'
import { isLeadWorkspace, leadOf } from '../../lead'
import { roomHome, tabOf, threadIdOf } from '../../nav'
import { actions, getState, go, loadWorkspace, useStore, type State } from '../../store'
import { openRow, sidebarRows, type Slot } from '../../components/sidebar/slots'
import { ConfirmDialog, useBusy } from '../../ui'
import { dropDrafts } from './composer/draftStore'
import './confirm.css'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * The Lead chat these tabs are all the open tabs of, or nothing. Closing them closes that chat (KERNEL-338), which asks first when it is running and
 * leaves the sidebar for the next chat. Only the Lead's workspace has such chats.
 */
export function closesThread(s: State, workspaceId: string, ids: string[]): Thread | undefined {
  const ws = s.workspaces.find((w) => w.id === workspaceId)
  if (!ws || !isLeadWorkspace(ws, ws.roomId, leadOf(s.agents, ws.roomId)?.id)) return undefined
  const open = (s.chats[workspaceId] ?? []).filter((c) => c.kind === 'chat' && !c.closed)
  const first = open.find((c) => ids.includes(c.id))
  if (!first) return undefined
  const id = threadIdOf(first)
  if (!open.filter((c) => threadIdOf(c) === id).every((c) => ids.includes(c.id))) return undefined
  return s.threads[id] ?? { id, roomId: ws.roomId, title: first.title, createdAt: first.createdAt }
}

/** The Lead's chat rows as the sidebar lists them, top to bottom. */
function chatRows(s: State, roomId: string) {
  const room = s.rooms.find((r) => r.id === roomId)
  return room ? sidebarRows(room, s.agents, s.workspaces, s.chats, s.threads, s.ui.foldedChats).filter((r): r is Extract<Slot, { kind: 'chat' }> => r.kind === 'chat') : []
}

/**
 * Close chat tabs. Main stops each chat's session, which ends a running turn and drops its queued messages, and opens a
 * new chat when no chat tab is left. When the open tab is one of them, the next tab to its right opens, or to its left when
 * none is left on the right, like closing a browser tab. In the Lead's workspace that is the next tab of the same chat. Closing a chat's
 * last tab closes the chat, and the chat row above it opens, or the one below when it was the first, or the room when no chat is left (KERNEL-338).
 */
export async function closeChats(workspaceId: string, ids: string[], active: string | undefined, select: (id: string) => void) {
  const s = getState()
  const closing = closesThread(s, workspaceId, ids)
  const roomId = s.workspaces.find((w) => w.id === workspaceId)?.roomId
  const order = closing && roomId ? chatRows(s, roomId).map((r) => r.thread.id) : []
  const all = s.chats[workspaceId] ?? []
  const shown = all.find((c) => c.id === active)
  // The tabs a neighbour is picked from: the active tab's own chat in the Lead's workspace, else every tab.
  const before = shown?.threadId ? all.filter((c) => c.threadId === shown.threadId) : all
  for (const id of ids) {
    await call('chats.close', { chatId: id })
    dropDrafts([id])
  }
  await loadWorkspace(workspaceId)
  if (closing && roomId) {
    const rows = chatRows(getState(), roomId)
    const at = order.indexOf(closing.id)
    const next = [...order.slice(0, at).reverse(), ...order.slice(at + 1)].map((id) => rows.find((r) => r.thread.id === id)).find(Boolean) ?? rows[0]
    if (next) openRow(roomId, next)
    else go(roomHome(roomId, getState()))
    return
  }
  if (!active || !ids.includes(active)) return
  const left = getState().chats[workspaceId] ?? []
  const was = before.findIndex((c) => c.id === active)
  const kept = new Set(left.map((c) => c.id))
  const next = [...before.slice(was + 1), ...before.slice(0, was).reverse()].find((c) => kept.has(c.id)) ?? left.find((c) => !shown?.threadId || c.threadId === shown.threadId) ?? left[0]
  if (next) select(next.id)
}

/** Asks before closing chats that are still running, since closing stops the agent mid-turn. `ChatTabs` closes idle chats without asking. */
export function ConfirmCloseChats({ workspaceId, chatIds }: { workspaceId: string; chatIds: string[] }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const agent = useStore((s) => (ws ? s.agents[ws.roomId]?.find((a) => a.id === ws.agentId)?.name : undefined)) ?? 'The agent'
  const chats = useStore((s) => s.chats[workspaceId])?.filter((c) => chatIds.includes(c.id)) ?? []
  const working = useStore((s) => chatIds.filter((id) => s.running[id]))
  const queued = useStore((s) => chatIds.reduce((n, id) => n + (s.queue[id]?.length ?? 0), 0))
  // Every open tab of a Lead chat: the whole chat closes, which has its own words (GroupedCloseLastTab.png).
  const thread = useStore((s) => closesThread(s, workspaceId, chatIds))
  const started = useStore((s) => ws && thread ? chatRows(s, ws.roomId).find((r) => r.thread.id === thread.id)?.owned.length ?? 0 : 0)
  const [closing, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  if (!ws) return null

  const close = () => run('close', async () => {
    setError(null)
    try {
      await closeChats(workspaceId, chatIds, tabOf(getState(), workspaceId), (tab) => actions.ui.openTab(workspaceId, tab))
      actions.ui.closeModal()
    } catch (e) { setError(cleanError(e)) }
  })

  const one = chatIds.length === 1
  const where = one ? 'this chat' : working.length === 1 ? chats.find((c) => c.id === working[0])?.title ?? 'one of them' : `${working.length} of them`
  const drops = queued ? ` and drops ${plural(queued, 'queued message')}` : ''
  const body = `${agent} is still working in ${where}. Closing stops ${working.length > 1 ? 'those turns' : 'the turn'}${drops}. Changes already in the worktree stay.`

  if (thread) {
    const handed = started ? ` The ${started === 1 ? 'workspace' : `${started} workspaces`} it started ${started === 1 ? 'stays' : 'stay'} in the sidebar.` : ''
    return (
      <ConfirmDialog
        title="Close this chat?" body={`${agent} is still working in this chat. Closing its last tab stops that turn and closes the chat.${handed}`}
        busy={!!closing} busyLabel="Closing" confirmLabel="Close chat" onConfirm={() => void close()} onCancel={actions.ui.closeModal}
      >
        <div className="wsc-facts mono"><span>{thread.title}</span><span>{plural(chatIds.length, 'tab')} · {agent} is working</span></div>
        {error && <p role="alert" className="wsc-error">{error}</p>}
      </ConfirmDialog>
    )
  }

  return (
    <ConfirmDialog
      title={one ? `Close ${chats[0]?.title ?? 'this chat'}?` : `Close ${plural(chatIds.length, 'tab')}?`} body={body}
      danger busy={!!closing} busyLabel="Closing" confirmLabel="Stop and close" onConfirm={() => void close()} onCancel={actions.ui.closeModal}
    >
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
