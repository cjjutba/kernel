import { useState } from 'react'
import { call } from '../../api'
import { actions, getState, loadWorkspace, useStore } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import { dropDrafts } from './composer/draftStore'
import './confirm.css'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * Close chat tabs. Main stops each chat's session, which ends a running turn and drops its queued messages, and opens a
 * new chat when no chat tab is left. When the open tab is one of them, the tab to its left opens.
 */
export async function closeChats(workspaceId: string, ids: string[], active: string | undefined, select: (id: string) => void) {
  const before = getState().chats[workspaceId] ?? []
  for (const id of ids) {
    await call('chats.close', { chatId: id })
    dropDrafts([id])
  }
  await loadWorkspace(workspaceId)
  if (!active || !ids.includes(active)) return
  const left = getState().chats[workspaceId] ?? []
  const was = before.findIndex((c) => c.id === active)
  const next = left[Math.min(Math.max(was - 1, 0), left.length - 1)]
  if (next) select(next.id)
}

/** Asks before closing chats that are still running, since closing stops the agent mid-turn. `ChatTabs` closes idle chats without asking. */
export function ConfirmCloseChats({ workspaceId, chatIds }: { workspaceId: string; chatIds: string[] }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const agent = useStore((s) => (ws ? s.agents[ws.roomId]?.find((a) => a.id === ws.agentId)?.name : undefined)) ?? 'The agent'
  const chats = useStore((s) => s.chats[workspaceId])?.filter((c) => chatIds.includes(c.id)) ?? []
  const working = useStore((s) => chatIds.filter((id) => s.running[id]))
  const queued = useStore((s) => chatIds.reduce((n, id) => n + (s.queue[id]?.length ?? 0), 0))
  const [closing, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  if (!ws) return null

  const close = () => run('close', async () => {
    setError(null)
    try {
      await closeChats(workspaceId, chatIds, getState().ui.workspace.tab, (tab) => actions.ui.setWorkspaceView({ tab }))
      actions.ui.closeModal()
    } catch (e) { setError(clean(e)) }
  })

  const one = chatIds.length === 1
  const where = one ? 'this chat' : working.length === 1 ? chats.find((c) => c.id === working[0])?.title ?? 'one of them' : `${working.length} of them`
  const drops = queued ? ` and drops ${plural(queued, 'queued message')}` : ''
  const body = `${agent} is still working in ${where}. Closing stops ${working.length > 1 ? 'those turns' : 'the turn'}${drops}. Changes already in the worktree stay.`

  return (
    <ConfirmDialog
      title={one ? `Close ${chats[0]?.title ?? 'this chat'}?` : `Close ${plural(chatIds.length, 'tab')}?`} body={body}
      danger busy={!!closing} busyLabel="Closing" confirmLabel="Stop and close" onConfirm={() => void close()} onCancel={actions.ui.closeModal}
    >
      {error && <p role="alert" className="wsc-error">{error}</p>}
    </ConfirmDialog>
  )
}
