import { useId, useState } from 'react'
import { Button, Modal } from '../ui'
import { cleanError } from '../api'
import { deviceName, pair } from './pairing'

/**
 * What a browser shows before it has a token (remote-web-client), in the one modal shell. With a pairing link's code it asks for a
 * device name and pairs; without one it says where to find the link. `notice` is why a page that was paired is back here.
 */
export function Gate({ code, notice, onPaired }: { code?: string; notice?: string; onPaired: (token: string) => void }) {
  const id = useId()
  const [name, setName] = useState(() => deviceName())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const noop = () => undefined

  if (!code) {
    return (
      <Modal title="Kernel" onClose={noop} width={420}>
        <div className="remote-gate-body">
          {notice && <p role="alert" className="remote-gate-notice">{notice}</p>}
          <p>Open the pairing link from Settings, Remote access on your Mac.</p>
        </div>
      </Modal>
    )
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try { onPaired(await pair(code, name)) } catch (e) { setError(cleanError(e)); setBusy(false) }
  }

  return (
    <Modal
      title="Pair this device"
      onClose={noop}
      width={420}
      footer={<><span className="grow" /><Button variant="primary" busy={busy} busyLabel="Pairing" onClick={() => void submit()}>Pair</Button></>}
    >
      <form className="remote-gate-body" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <p>This browser will be able to follow and steer your chats on this Mac. Remove it any time in Settings, Remote access.</p>
        <div className="remote-gate-field">
          <label className="rn-label" htmlFor={id}>Device name</label>
          <input id={id} className="rn-input" autoComplete="off" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </div>
        {error && <p role="alert" className="remote-gate-error">{error}</p>}
      </form>
    </Modal>
  )
}
