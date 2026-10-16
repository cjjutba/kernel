import { useRef } from 'react'
import { call } from '../../api'
import { saveAppMode } from '../../permissionModes'
import { actions, getState, go } from '../../store'
import { needsHookCheck } from './hookCheck'
import './onboarding.css'

/** The Block K, icon cut (design/brand/k-icon.svg), split into its stem and chevron so each gets its own shade. */
const STEM = 'M0 2.5A2.5 2.5 0 0 1 2.5 0L29.5 0A2.5 2.5 0 0 1 32 2.5L32 93.5A2.5 2.5 0 0 1 29.5 96L2.5 96A2.5 2.5 0 0 1 0 93.5Z'
const CHEVRON = 'M46 40.59A2.5 2.5 0 0 1 46.26 39.47L65.31 1.38A2.5 2.5 0 0 1 67.55 0L95.95 0A2.5 2.5 0 0 1 98.19 3.62L76 48L98.19 92.38A2.5 2.5 0 0 1 95.95 96L67.55 96A2.5 2.5 0 0 1 65.31 94.62L46.26 56.53A2.5 2.5 0 0 1 46 55.41Z'

/**
 * What a fresh install sees first (KERNEL-942): the wordmark settles in, then the app opens on New chat. It moves on when the
 * wordmark's own animation ends, not on a timer. The checks run behind it and show inside the app when one fails.
 */
export function Splash() {
  const done = useRef(false)
  const finish = async () => {
    if (done.current) return
    done.current = true
    // A new install reads Auto from the defaults but has no settings file yet. Saving the mode it shows writes it, so the first
    // unrelated save can't pin it to Accept edits (KERNEL-432, KERNEL-457). The permissions step used to do this.
    await saveAppMode(getState().settings?.permissions.mode ?? 'auto').catch(() => undefined)
    go({ name: 'leadNew', projectId: '' }, { history: 'replace' })
    // Hooks that aren't installed yet still get Check hooks, now over New chat.
    if (needsHookCheck(await call('hooks.status', undefined).catch(() => null))) actions.ui.openModal({ name: 'checkHooks' })
  }
  return (
    <div className="panel ob-bare ob-splash">
      <span className="ob-wordmark" role="img" aria-label="Kernel">
        <svg className="ob-wordmark-k" width="31" height="30" viewBox="0 0 100 96" aria-hidden="true">
          <path className="ob-k-stem" d={STEM} />
          <path className="ob-k-chevron" d={CHEVRON} />
        </svg>
        <span className="ob-wordmark-rest" aria-hidden="true" onAnimationEnd={() => void finish()}>
          <span className="ob-wordmark-text">ernel</span>
        </span>
      </span>
    </div>
  )
}
