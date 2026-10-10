import { useState } from 'react'
import { call } from '../api'
import { actions, useStore } from '../store'
import { Button, Icon } from '../ui'

/**
 * The card a downloaded update shows in the bottom right, like Conductor's (KERNEL-164, D-138). The footer's Update ready
 * pill (UpdateReady.png) stays as the way back once the card is closed. It sits last in the toast stack, so toasts
 * stack above it instead of covering it, and it steps aside while a modal or onboarding is up.
 */
export function UpdateCard() {
  const version = useStore((s) => (s.system.update?.status === 'ready' ? s.system.update.version : undefined))
  const hidden = useStore((s) => !!s.ui.modal || s.ui.route.name === 'onboarding')
  // Closing it hides it for that version until Kernel restarts. A newer download brings it back.
  const [closedFor, setClosedFor] = useState<string>()
  const [busy, setBusy] = useState(false)
  if (!version || version === closedFor || hidden) return null
  const seeChanges = () => {
    // What's new has its own Later, so the card doesn't come back when it closes.
    setClosedFor(version)
    actions.ui.openModal({ name: 'whatsNew' })
  }
  // Kernel quits on success, so the button stays busy until it does.
  const restart = () => {
    setBusy(true)
    void call('update.install', undefined).catch((e: unknown) => {
      setBusy(false)
      actions.ui.toast({ title: 'Could not restart to update', sub: (e as Error).message })
    })
  }
  return (
    <div className="update-card">
      <button type="button" className="update-card-x" aria-label="Close" disabled={busy} onClick={() => setClosedFor(version)}>
        <Icon name="close" size={10} stroke={2} />
      </button>
      <span className="update-card-title">New update available</span>
      <div className="update-card-actions">
        <Button disabled={busy} onClick={seeChanges}>See changes</Button>
        <Button variant="primary" busy={busy} busyLabel="Restarting" onClick={restart}>Restart</Button>
      </div>
    </div>
  )
}
