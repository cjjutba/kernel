import { useEffect, useState } from 'react'
import { CLAUDE_PLANS, type ClaudePlan, type Provider } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, Modal, Select, useBusy } from '../../../ui'

type Plan = Exclude<ClaudePlan, 'unknown'>

/**
 * Add account, or Sign in again for an added Claude account (`signIn`, KERNEL-406). Codex signs in with ChatGPT in the
 * browser. Claude runs `claude setup-token`, which opens its sign-in in the browser and may ask for the code the page
 * shows; only then does the sheet show a field for it. A Claude account needs a name and its plan, which its token can't
 * tell. A failed sign-in says why and offers Try again. Subscription logins only: no API key and no pasted token (D-018).
 */
export function AddAccount({ provider, signIn, onClose }: { provider: Provider; signIn?: { label: string }; onClose: () => void }) {
  const step = useStore((s) => (s.accountAdd?.provider === provider ? s.accountAdd : null))
  const [label, setLabel] = useState('')
  const [plan, setPlan] = useState<Plan | ''>('')
  const [code, setCode] = useState('')
  const [started, setStarted] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, run] = useBusy<'start' | 'code'>()
  const claude = provider === 'claude'
  const name = claude ? 'Claude' : 'ChatGPT'
  const ready = !!signIn || !claude || (!!label.trim() && !!plan)
  useEffect(() => () => actions.accounts.adding(null), [])
  const start = () => run('start', async () => {
    if (!ready) return
    actions.accounts.adding(null)
    setFailed(null)
    setStarted(true)
    try {
      if (signIn) await call('providers.signIn', { provider })
      else await call('accounts.add', { provider, label: label.trim() || undefined, ...(claude && plan ? { plan } : {}) })
      actions.accounts.set(await call('accounts.list', undefined))
      onClose()
    } catch (e) {
      setStarted(false)
      if (!/canceled/i.test(String(e))) setFailed(cleanError(e))
    }
  })
  const close = () => { if (started) void call('accounts.cancelAdd', { provider }).catch(() => undefined); onClose() }
  const sendCode = () => run('code', async () => {
    try { await call('accounts.code', { provider, code: code.trim() }); setCode('') } catch (e) { actions.ui.toast({ title: 'Could not send the code', sub: cleanError(e) }) }
  })
  const title = signIn ? `Sign in to ${signIn.label}` : `Add ${claude ? 'a Claude' : 'a Codex'} account`
  return (
    <Modal title={title} onClose={close} width={480} top={200} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" size="lg" onClick={close}>Cancel</Button>
        {!started && <Button variant="primary" size="lg" busy={busy === 'start'} busyLabel="Opening" disabled={!ready} onClick={() => void start()}>{failed ? 'Try again' : `Sign in with ${name}`}</Button>}
        {started && step?.step === 'code' && <Button variant="primary" size="lg" busy={busy === 'code'} busyLabel="Sending" disabled={!code.trim()} onClick={() => void sendCode()}>Send code</Button>}
      </>
    }>
      <div className="modal-body set-form">
        {!started && !signIn && (
          <>
            <p className="set-help">
              {claude ? 'Kernel runs claude setup-token, which opens Claude’s sign-in in your browser.' : 'Kernel opens ChatGPT’s sign-in in your browser.'}
              {' '}The account shares your MCP servers, plugins, skills and chats, and you switch to it in Settings or the account menu.
            </p>
            <div className="set-field">
              <label htmlFor="acct-label">Name</label>
              <input id="acct-label" className="input" autoComplete="off" spellCheck={false} placeholder="Work" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void start()} />
            </div>
            {claude && (
              <div className="set-field">
                <label htmlFor="acct-plan">Plan</label>
                <Select id="acct-plan" label="Plan" value={plan} onChange={(e) => setPlan(e.target.value as Plan | '')} options={[{ value: '', label: 'Choose a plan' }, ...CLAUDE_PLANS.map((p) => ({ value: p.id, label: p.label }))]} />
                <p className="set-help">Kernel can&rsquo;t read the plan from this kind of sign-in, so the defaults that depend on it use this one.</p>
              </div>
            )}
          </>
        )}
        {!started && signIn && !failed && <p className="set-help">Kernel runs claude setup-token again, which opens Claude&rsquo;s sign-in in your browser. The new sign-in replaces the old one.</p>}
        {!started && failed && (
          <div className="set-field">
            <p className="set-error" role="alert">The sign-in didn&rsquo;t finish. {failed}</p>
          </div>
        )}
        {started && (
          <p className="set-help" role="status">Finish signing in in your browser.{step?.url && <> <button type="button" className="set-link" onClick={() => void call('system.openExternal', { url: step.url! })}>Open the page again</button></>}</p>
        )}
        {started && step?.step === 'code' && (
          <div className="set-field">
            <label htmlFor="acct-code">Code, if the sign-in page shows one</label>
            <input id="acct-code" className="input" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && void sendCode()} />
          </div>
        )}
      </div>
    </Modal>
  )
}
