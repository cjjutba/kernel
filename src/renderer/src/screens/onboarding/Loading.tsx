import { Skeleton } from '../../ui'
import { useStore } from '../../store'
import './onboarding.css'

const GROUPS = [[160, 130, 145], [90, 150, 120, 140]]

/** LoadingApp.png: the app shell while the main process boots or reconnects. Shown until the store has booted. */
export function Loading() {
  const sessions = useStore((s) => Object.values(s.running).filter(Boolean).length)
  return (
    <>
      <div className="ob-load" aria-hidden="true">
        <Skeleton width={110} height={20} />
        {GROUPS.map((g, i) => (
          <div key={i} className="ob-load-group">{g.map((w) => <Skeleton key={w} width={w} height={14} />)}</div>
        ))}
      </div>
      <div className="ob-load-main">
        <div className="ob-load-panel" role="status" aria-live="polite">
          <span className="spin ob-spin" aria-hidden="true" />
          <span className="ink2">Starting Kernel</span>
          <span className="muted" style={{ fontSize: 12.5 }}>{`Reconnecting ${sessions ? `${sessions} ${sessions === 1 ? 'session' : 'sessions'}` : 'sessions'} and the hook server`}</span>
        </div>
      </div>
    </>
  )
}
