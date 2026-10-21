import { useRef } from 'react'
import { call } from '../../api'
import { saveAppMode } from '../../permissionModes'
import { actions, getState, go } from '../../store'
import { needsHookCheck } from './hookCheck'
import './onboarding.css'

/** The Block K, icon cut (design/brand/k-icon.svg), one path so it takes one solid color. */
const K = 'M0 2.5A2.5 2.5 0 0 1 2.5 0L29.5 0A2.5 2.5 0 0 1 32 2.5L32 93.5A2.5 2.5 0 0 1 29.5 96L2.5 96A2.5 2.5 0 0 1 0 93.5ZM46 40.59A2.5 2.5 0 0 1 46.26 39.47L65.31 1.38A2.5 2.5 0 0 1 67.55 0L95.95 0A2.5 2.5 0 0 1 98.19 3.62L76 48L98.19 92.38A2.5 2.5 0 0 1 95.95 96L67.55 96A2.5 2.5 0 0 1 65.31 94.62L46.26 56.53A2.5 2.5 0 0 1 46 55.41Z'

/**
 * The welcome (KERNEL-1088): the K mark alone, one solid color, centered. It moves on when the mark's own animation ends, not on a
 * timer: a first install goes to the four setup steps, and every later launch opens New chat. The checks run behind it.
 */
export function Splash() {
  const done = useRef(false)
  const finish = async () => {
    if (done.current) return
    done.current = true
    if (!getState().settings?.onboarding.done) return go({ name: 'onboarding', step: 'checks' }, { history: 'replace' })
    // Settings from before onboarding existed have no mode saved yet. Saving the one shown writes it, so the first unrelated save can't pin it to Accept edits (KERNEL-432, KERNEL-457).
    await saveAppMode(getState().settings?.permissions.mode ?? 'auto').catch(() => undefined)
    go({ name: 'leadNew', projectId: '' }, { history: 'replace' })
    // Hooks that aren't installed yet still get Check hooks, now over New chat.
    if (needsHookCheck(await call('hooks.status', undefined).catch(() => null))) actions.ui.openModal({ name: 'checkHooks' })
  }
  return (
    <div className="panel ob-bare ob-splash">
      <svg className="ob-k" width="48" height="46" viewBox="0 0 100 96" role="img" aria-label="Kernel" onAnimationEnd={() => void finish()}>
        <path d={K} />
      </svg>
    </div>
  )
}
