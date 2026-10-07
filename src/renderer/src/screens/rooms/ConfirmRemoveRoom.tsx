import { useId, useState } from 'react'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { Button, Modal } from '../../ui'
import { tilde } from './draft'
import './rooms.css'

/** ConfirmRemoveRoom.png. Removes Kernel's record of the room. The folder on disk and .claude/agents stay. */
export function ConfirmRemoveRoom({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const agents = useStore((s) => s.agents[roomId]?.length ?? 0)
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && w.name !== 'lead').length)
  const root = useStore((s) => s.settings?.worktreeRoot)
  const [worktrees, setWorktrees] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const cancel = actions.ui.closeModal
  if (!room) return null

  const remove = async () => {
    setBusy(true); setError(null)
    try {
      await call('rooms.remove', { roomId, deleteWorktrees: worktrees })
      const route = getState().ui.route
      const here = ('roomId' in route && route.roomId === roomId) || (route.name === 'workspace' && getState().workspaces.find((w) => w.id === route.workspaceId)?.roomId === roomId)
      actions.rooms.remove(roomId)
      if (here) actions.ui.go({ name: 'rooms' })
      actions.ui.closeModal()
    } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); setBusy(false) }
  }
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

  return (
    <Modal
      title={`Remove ${room.name}?`} onClose={cancel} width={460} top={222} bare role="alertdialog" labelledBy={`${id}t`} describedBy={`${id}b`}
      footer={<><span className="grow" /><Button variant="ghost" size="lg" onClick={cancel}>Cancel</Button><Button variant="danger" size="lg" disabled={busy} onClick={() => void remove()}>Remove room</Button></>}
    >
      <div className="confirm-body" style={{ paddingBottom: 18 }}>
        <h2 id={`${id}t`}>Remove {room.name}?</h2>
        <p id={`${id}b`}>Kernel stops {n(agents, 'agent')} and removes {n(workspaces, 'workspace')}. Your repo on disk and .claude/agents are not touched.</p>
        <div className="rm-box mono"><span>{tilde(room.path)}</span><span className="muted">{n(workspaces, 'workspace')} · {n(agents, 'agent')}</span></div>
        <label className="rm-check"><input type="checkbox" checked={worktrees} onChange={(e) => setWorktrees(e.target.checked)} />Also delete the worktrees in {root ? tilde(root) : '~/kernel/worktrees'}</label>
        {error && <p role="alert" className="del" style={{ color: 'var(--del)' }}>{error}</p>}
      </div>
    </Modal>
  )
}
