import { useEffect } from 'react'
import { actions, useStore } from '../../store'
import { openRoom } from '../../lead'
import { Button, Icon, Spinner } from '../../ui'
import { getDraft } from './draft'
import '../onboarding/onboarding.css'
import './rooms.css'

/** RoomSetup.png: clone, folders, install, files, hooks, agents. Progress comes from `room.setup` push events. */
export function RoomSetup({ roomId }: { roomId?: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const steps = useStore((s) => (roomId ? s.roomSetup[roomId] : undefined))
  const finished = !!steps && steps.every((s) => s.state === 'ok' || s.state === 'fail')
  const failed = steps?.filter((s) => s.state === 'fail').length ?? 0
  const open = () => { if (roomId) void openRoom(roomId) }
  // "Brief Rowan right away" in New room: when setup finishes cleanly, land in Rowan's chat (D-104).
  useEffect(() => { if (finished && !failed && getDraft().autostart && roomId) void openRoom(roomId) }, [finished, failed, roomId])

  return (
    <div className="panel" style={{ background: 'transparent', border: 0 }}>
      <div className="ob-page">
        <div className="ob-col">
          <h1 className="ob-h1">Setting up {room?.name ?? 'your room'}</h1>
          <p className="ob-sub">This takes a minute. Your team is ready when it finishes.</p>
          <div className="ob-list" aria-busy={!finished}>
            {(steps ?? []).map((s) => (
              <div key={s.id} className="ob-check" data-state={s.state} data-ok={s.state !== 'fail'}>
                <span className="ob-ico rs-ico" data-state={s.state}>
                  {s.state === 'ok' && <Icon name="check" size={15} stroke={1.7} />}
                  {s.state === 'fail' && <Icon name="x" size={15} />}
                  {s.state === 'run' && <Spinner label={`${s.title} is running`} />}
                  {s.state === 'wait' && <span aria-label="Waiting" className="rs-dash">–</span>}
                </span>
                <div className="ob-body">
                  <span className="ob-name" style={s.state === 'wait' ? { color: 'var(--muted)', fontWeight: 400 } : undefined}>{s.title}</span>
                  <span className="ob-detail">{s.detail}</span>
                  {s.error && <span className="ob-detail rs-error" role="alert">{s.error}</span>}
                </div>
                {s.meta && <span className="ob-meta">{s.meta}</span>}
              </div>
            ))}
            {!steps && <div className="ob-check"><Spinner label="Starting" /><span className="muted">Starting</span></div>}
          </div>
          <div className="ob-bar">
            <span role="status">{finished && failed ? `${failed} ${failed === 1 ? 'step' : 'steps'} did not finish. You can still open the room.` : 'You can leave this screen. Kernel keeps going.'}</span>
            <Button variant={finished ? 'primary' : 'secondary'} size="lg" disabled={!finished} onClick={open}>Open the room</Button>
          </div>
          {finished && failed > 0 && <button type="button" className="ob-link" style={{ alignSelf: 'flex-start', marginTop: 12 }} onClick={() => { actions.ui.go({ name: 'rooms' }) }}>All rooms</button>}
        </div>
      </div>
    </div>
  )
}
