import { Button, Skeleton, Spinner, useBusy } from '../../ui'
import { boot, useStore } from '../../store'
import './onboarding.css'

/** Skeleton sidebar rows: indent level and bar width. */
const ROWS: [number, number][] = [[0, 64], [0, 52], [0, 80], [1, 150], [2, 130], [2, 170], [2, 120], [1, 140]]

/** LoadingApp.png: the app shell while the main process boots or reconnects. Shown until the store has booted. */
export function Loading() {
  const sessions = useStore((s) => Object.values(s.running).filter(Boolean).length)
  const error = useStore((s) => s.ui.startError)
  const [busy, run] = useBusy()
  return (
    <>
      <div className="ob-load" aria-hidden="true">
        <div className="ob-load-row"><span className="ob-load-tile" /><Skeleton width={110} height={10} /></div>
        {ROWS.map(([depth, w], i) => (
          <div key={i} className="ob-load-row" style={{ paddingLeft: depth * 22 }}><span className="ob-load-tile" /><Skeleton width={w} height={8} /></div>
        ))}
      </div>
      <div className="ob-load-main">
        {error === undefined ? (
          <div className="ob-load-panel" role="status" aria-live="polite">
            <span className="ob-load-title"><Spinner label={null} pattern="arrow-down" /><span className="ink2">Starting Kernel</span></span>
            <span className="muted ob-reconnect">{`Reconnecting ${sessions ? `${sessions} ${sessions === 1 ? 'session' : 'sessions'}` : 'sessions'} and the hook server`}</span>
          </div>
        ) : (
          <div className="ob-load-panel" role="alert">
            <span className="ink2">Kernel could not start</span>
            <span className="muted ob-load-error">{error}</span>
            <Button variant="primary" busy={busy !== null} busyLabel="Starting" onClick={() => void run('start', boot)}>Try again</Button>
          </div>
        )}
      </div>
    </>
  )
}
