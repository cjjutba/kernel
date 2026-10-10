import { useState } from 'react'
import type { AppUpdate } from '@shared/types'
import { call } from '../../api'
import { actions, getState } from '../../store'
import { Button, Modal } from '../../ui'
import { whatsNewView } from './whatsNewView'
import './update.css'

/**
 * What's new (WhatsNew.png). With an update downloaded it offers Later and Restart to update. Once after an update
 * installs it opens by itself, titled "What's new in Kernel <version>", with one Done button. Opened any other time,
 * it shows the running version's notes the same way (KERNEL-154).
 */
export function WhatsNew({ update: opened }: { update?: AppUpdate }) {
  // What the modal opened with: the install it was given at boot, or the live state from the pill, the sidebar,
  // the account menu or the palette. A check that starts while it's open replaces the live state and its notes.
  const [update] = useState(() => opened ?? getState().system.update)
  const [busy, setBusy] = useState(false)
  const close = () => actions.ui.closeModal()
  const { ready, title, notes } = whatsNewView(update)
  const restart = () => {
    setBusy(true)
    void call('update.install', undefined).catch((e: unknown) => {
      setBusy(false)
      actions.ui.toast({ title: 'Could not restart to update', sub: (e as Error).message })
    })
  }
  const footer = ready
    ? <>
        <span className="wn-note">{busy ? 'Agents pause, Kernel restarts, agents resume.' : 'Running agents pause for a few seconds.'}</span>
        <Button variant="ghost" size="lg" onClick={close}>Later</Button>
        <Button variant="primary" size="lg" busy={busy} busyLabel="Restarting" onClick={restart}>Restart to update</Button>
      </>
    : <><span className="grow" /><Button variant="primary" size="lg" onClick={close}>Done</Button></>
  return (
    <Modal title={title} onClose={close} width={520} top={130} footer={footer}>
      {notes.length > 0 && (
        <div className="wn-list">
          {notes.map((n, i) => (
            <div key={i} className="wn-item">
              <span className="wn-title">{n.title}</span>
              {/* A section's changes come one per line (parseNotes in src/main/updater.ts). */}
              {n.body.split('\n').map((line, j) => <span key={j} className="wn-body">{line}</span>)}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
