import { useEffect, useRef, useState } from 'react'
import { actions, useStore } from '../store'
import { useRetryKey, failToast } from '../retry'
import { Toast } from '../ui'
import { UPDATE_CHECK_RETRY, UPDATE_INSTALL_RETRY, checkAgain, checkFailedReason, restartToUpdate } from './footer/updateActions'

/**
 * An update that has downloaded, as a toast in the bottom right with See changes and Restart (Pen 17.1, KERNEL-1104). It stays until closed or
 * answered, since it waits on the person, and the footer's Update pill (the title bar's, with the sidebar hidden) stays as the way back. It sits
 * last in the toast stack, so toasts stack above it instead of covering it, and it steps aside while a modal or onboarding is up.
 * It also owns the update's own Try again buttons: the toast for a download that failed and the ones that retry a check or a restart.
 */
export function UpdateCard() {
  const update = useStore((s) => s.system.update)
  const online = useStore((s) => s.system.online)
  const version = update?.status === 'ready' ? update.version : undefined
  const hidden = useStore((s) => !!s.ui.modal || s.ui.route.name === 'onboarding')
  // Closing it hides it for that version until Kernel restarts. A newer download brings it back.
  const [closedFor, setClosedFor] = useState<string>()

  useRetryKey(UPDATE_CHECK_RETRY, () => checkAgain(online))
  useRetryKey(UPDATE_INSTALL_RETRY, restartToUpdate)

  // A download that stops says why in a toast, once, and the footer goes back to its quiet button. A failed check raises its own toast where it was asked for.
  const before = useRef(update?.status)
  useEffect(() => {
    const was = before.current
    before.current = update?.status
    if (was === 'downloading' && update?.status === 'error') {
      failToast(update.version ? `Couldn't download Kernel ${update.version}` : "Couldn't download the update", checkFailedReason(update.error, online), UPDATE_CHECK_RETRY)
    }
  }, [update, online])

  if (!version || version === closedFor || hidden) return null
  const close = () => setClosedFor(version)
  return (
    <Toast
      title={`Kernel ${version} is ready`} sub="Restart to update. Running agents pause for a few seconds." glyph="download" stay onDismiss={close}
      actions={[
        // What's new has its own Later, so the toast doesn't come back when it closes.
        { label: 'See changes', onClick: () => actions.ui.openModal({ name: 'whatsNew' }) },
        { label: 'Restart', primary: true, onClick: () => void restartToUpdate() }
      ]}
    />
  )
}
