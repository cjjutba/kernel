import { useState } from 'react'
import type { AppUpdate } from '@shared/types'
import { call } from '../../api'
import { actions, getState } from '../../store'
import { Button, Modal } from '../../ui'
import './update.css'

/** "0.2.0" reads as "0.2", as on Welcome. */
const short = (v: string) => v.replace(/^(\d+\.\d+).*/, '$1')

/**
 * What's new (WhatsNew.png). From the Update ready pill it offers Later and Restart to update. Once after an
 * update installs it opens by itself, titled "What's new in Kernel <version>", with one Done button.
 */
export function WhatsNew({ update: opened }: { update?: AppUpdate }) {
  // What the modal opened with: the install it was given at boot, or the ready update from the pill.
  // A check that starts while it's open replaces the live state and its notes.
  const [update] = useState(() => opened ?? getState().system.update)
  const [busy, setBusy] = useState(false)
  const close = () => actions.ui.closeModal()
  const installed = !!update?.installed
  const version = short(update?.version ?? update?.current ?? '')
  const notes = update?.notes ?? []
  const restart = () => {
    setBusy(true)
    void call('update.install', undefined).catch((e: unknown) => {
      setBusy(false)
      actions.ui.toast({ title: 'Could not restart to update', sub: (e as Error).message })
    })
  }
  const footer = installed
    ? <><span className="grow" /><Button variant="primary" size="lg" onClick={close}>Done</Button></>
    : <>
        <span className="wn-note">{busy ? 'Agents pause, Kernel restarts, agents resume.' : 'Running agents pause for a few seconds.'}</span>
        <Button variant="ghost" size="lg" onClick={close}>Later</Button>
        <Button variant="primary" size="lg" disabled={busy} onClick={restart}>{busy && <span className="spin wn-spin" aria-hidden="true" />}{busy ? 'Restarting' : 'Restart to update'}</Button>
      </>
  return (
    <Modal title={installed ? `What's new in Kernel ${version}` : `Kernel ${version} is ready`} onClose={close} width={520} top={130} footer={footer}>
      {notes.length > 0 && (
        <div className="wn-list">
          {notes.map((n, i) => (
            <div key={i} className="wn-item">
              <span className="wn-title">{n.title}</span>
              <span className="wn-body">{n.body}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
