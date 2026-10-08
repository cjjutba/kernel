import { useState } from 'react'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import { tilde } from './draft'
import './rooms.css'

/** ConfirmRemoveRoom.png. Archives the room's workspaces, then removes Kernel's record of the room. The folder on disk and .claude/agents stay. */
export function ConfirmRemoveRoom({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId]?.length ?? 0)
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && w.name !== 'lead').length)
  const root = useStore((s) => s.settings?.worktreeRoot)
  const [worktrees, setWorktrees] = useState(false)
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const cancel = actions.ui.closeModal
  if (!room) return null

  const remove = () => run('remove', async () => {
    setError(null)
    try {
      await call('rooms.remove', { roomId, deleteWorktrees: worktrees })
      const route = getState().ui.route
      const here = ('roomId' in route && route.roomId === roomId) || (route.name === 'workspace' && getState().workspaces.find((w) => w.id === route.workspaceId)?.roomId === roomId)
      actions.rooms.remove(roomId)
      if (here) actions.ui.go({ name: 'rooms' })
      actions.ui.closeModal()
    } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  })
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

  return (
    <ConfirmDialog
      title={`Remove ${room.name}?`} danger busy={!!busy} busyLabel="Removing" confirmLabel="Remove room" onConfirm={() => void remove()} onCancel={cancel}
      body={`Kernel stops ${n(agents, 'agent')} and archives ${n(workspaces, 'workspace')}. Your repo on disk and .claude/agents are not touched.`}
    >
      <div className="rm-box mono"><span>{tilde(room.path)}</span><span className="muted">{n(workspaces, 'workspace')} · {n(agents, 'agent')}</span></div>
      <label className="rm-check"><input type="checkbox" checked={worktrees} onChange={(e) => setWorktrees(e.target.checked)} />Also delete the worktrees in {root ? tilde(root) : '~/kernel/worktrees'}</label>
      {error && <p role="alert" style={{ color: 'var(--del)' }}>{error}</p>}
    </ConfirmDialog>
  )
}
