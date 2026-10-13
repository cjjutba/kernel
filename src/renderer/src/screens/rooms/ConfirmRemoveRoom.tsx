import { useState } from 'react'
import { call, cleanError } from '../../api'
import { actions, getState, useStore } from '../../store'
import { Checkbox, ConfirmDialog, useBusy } from '../../ui'
import { tilde } from './draft'
import { teamOf } from './roomInfo'
import './rooms.css'

/** ConfirmRemoveRoom.png. Archives the room's workspaces, then removes Kernel's record of the room. The folder on disk and .claude/agents stay. */
export function ConfirmRemoveRoom({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => teamOf(s.agents[roomId]).length)
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && !w.lead).length)
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
    } catch (e) { setError(cleanError(e)) }
  })
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

  return (
    <ConfirmDialog
      title={`Remove ${room.name}?`} danger busy={!!busy} busyLabel="Removing" confirmLabel="Remove room" onConfirm={() => void remove()} onCancel={cancel}
      body={`Kernel stops ${n(agents, 'agent')} and archives ${n(workspaces, 'workspace')}. Your repo on disk and .claude/agents are not touched.`}
    >
      <div className="rm-box mono"><span>{tilde(room.path)}</span><span className="muted">{n(workspaces, 'workspace')} · {n(agents, 'agent')}</span></div>
      <Checkbox checked={worktrees} onChange={setWorktrees}>Also delete the worktrees in {root ? tilde(root) : '~/kernel/worktrees'}</Checkbox>
      {error && <p role="alert" className="confirm-error">{error}</p>}
    </ConfirmDialog>
  )
}
