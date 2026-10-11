import { useEffect, useState } from 'react'
import type { Provider } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, Modal, useBusy } from '../../../ui'

/**
 * Add account (KERNEL-406). Kernel opens the provider's sign-in in the browser and waits. Claude's `setup-token` may ask for
 * the code its page shows, and only then does the sheet show a field for it. Subscription logins only: no API key (D-018).
 */
export function AddAccount({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const step = useStore((s) => (s.accountAdd?.provider === provider ? s.accountAdd : null))
  const [label, setLabel] = useState('')
  const [code, setCode] = useState('')
  const [started, setStarted] = useState(false)
  const [busy, run] = useBusy<'start' | 'code'>()
  const name = provider === 'codex' ? 'ChatGPT' : 'Claude'
  useEffect(() => () => actions.accounts.adding(null), [])
  const start = () => run('start', async () => {
    setStarted(true)
    try {
      await call('accounts.add', { provider, label: label.trim() || undefined })
      actions.accounts.set(await call('accounts.list', undefined))
      onClose()
    } catch (e) {
      setStarted(false)
      if (!/canceled/i.test(String(e))) actions.ui.toast({ title: 'Could not add the account', sub: cleanError(e) })
    }
  })
  const close = () => { if (started) void call('accounts.cancelAdd', { provider }).catch(() => undefined); onClose() }
  const sendCode = () => run('code', async () => {
    try { await call('accounts.code', { provider, code: code.trim() }); setCode('') } catch (e) { actions.ui.toast({ title: 'Could not send the code', sub: cleanError(e) }) }
  })
  return (
    <Modal title={`Add ${provider === 'codex' ? 'a Codex' : 'a Claude'} account`} onClose={close} width={480} top={200} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" size="lg" onClick={close}>Cancel</Button>
        {!started && <Button variant="primary" size="lg" busy={busy === 'start'} busyLabel="Opening" onClick={() => void start()}>Sign in with {name}</Button>}
        {started && step?.step === 'code' && <Button variant="primary" size="lg" busy={busy === 'code'} busyLabel="Sending" disabled={!code.trim()} onClick={() => void sendCode()}>Send code</Button>}
      </>
    }>
      <div className="modal-body set-form">
        {!started && (
          <>
            <p className="set-help">Kernel opens {name}&rsquo;s sign-in in your browser. The account shares your MCP servers, plugins, skills and chats, and you switch to it in Settings or the account menu.</p>
            <div className="set-field">
              <label htmlFor="acct-label">Name</label>
              <input id="acct-label" className="input" autoComplete="off" spellCheck={false} placeholder="Work" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void start()} />
            </div>
          </>
        )}
        {started && step?.step !== 'code' && (
          <p className="set-help" role="status">Finish signing in in your browser.{step?.url && <> <button type="button" className="set-link" onClick={() => void call('system.openExternal', { url: step.url! })}>Open the page again</button></>}</p>
        )}
        {started && step?.step === 'code' && (
          <div className="set-field">
            <label htmlFor="acct-code">Code from the sign-in page</label>
            <input id="acct-code" className="input" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && void sendCode()} />
          </div>
        )}
      </div>
    </Modal>
  )
}
