import { useEffect, useState } from 'react'
import { CLAUDE_PLANS, type ClaudePlan, type Provider } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, Modal, SegmentedControl, Select, useBusy } from '../../../ui'

type Plan = Exclude<ClaudePlan, 'unknown'>
type Kind = 'subscription' | 'apiKey'

const KINDS: { value: Kind; label: string }[] = [{ value: 'subscription', label: 'Subscription' }, { value: 'apiKey', label: 'API key' }]
const KEY_PAGE: Record<Provider, { host: string; url: string; placeholder: string }> = {
  claude: { host: 'console.anthropic.com', url: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-' },
  codex: { host: 'platform.openai.com', url: 'https://platform.openai.com/api-keys', placeholder: 'sk-' }
}

/**
 * Add account, Sign in again for an added Claude account (`signIn`, KERNEL-406), or Replace key for an API key account
 * (`replaceKey`, KERNEL-524). Subscription: Codex signs in with ChatGPT in the browser. Claude runs `claude setup-token`,
 * which opens its sign-in in the browser and may ask for the code the page shows; only then does the sheet show a field for
 * it. A Claude account needs a name and its plan, which its token can't tell. A failed sign-in says why and offers Try
 * again. API key: a name and the key, checked with the provider before it is kept, and a refused key shows the provider's
 * reason in the sheet. No pasted token (D-018).
 */
export function AddAccount({ provider, signIn, replaceKey, onClose }: { provider: Provider; signIn?: { label: string }; replaceKey?: { accountId: string; label: string }; onClose: () => void }) {
  const step = useStore((s) => (s.accountAdd?.provider === provider ? s.accountAdd : null))
  const [kind, setKind] = useState<Kind>('subscription')
  const [label, setLabel] = useState('')
  const [plan, setPlan] = useState<Plan | ''>('')
  const [code, setCode] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [started, setStarted] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, run] = useBusy<'start' | 'code' | 'key'>()
  const claude = provider === 'claude'
  const name = claude ? 'Claude' : 'ChatGPT'
  const keyForm = !!replaceKey || (!signIn && kind === 'apiKey')
  const page = KEY_PAGE[provider]
  const ready = !!signIn || !claude || (!!label.trim() && !!plan)
  const keyReady = !!apiKey.trim() && (!!replaceKey || !!label.trim())
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
  const saveKey = () => run('key', async () => {
    if (!keyReady) return
    setFailed(null)
    try {
      await call('accounts.addKey', replaceKey ? { provider, accountId: replaceKey.accountId, key: apiKey.trim() } : { provider, label: label.trim(), key: apiKey.trim() })
      actions.accounts.set(await call('accounts.list', undefined))
      onClose()
    } catch (e) { setFailed(cleanError(e)) }
  })
  const close = () => {
    if (busy === 'key') return
    if (started) void call('accounts.cancelAdd', { provider }).catch(() => undefined)
    onClose()
  }
  const sendCode = () => run('code', async () => {
    try { await call('accounts.code', { provider, code: code.trim() }); setCode('') } catch (e) { actions.ui.toast({ title: 'Could not send the code', sub: cleanError(e) }) }
  })
  const pickKind = (v: string) => { setKind(v as Kind); setFailed(null) }
  const title = signIn ? `Sign in to ${signIn.label}` : replaceKey ? `Replace ${replaceKey.label}` : `Add ${claude ? 'a Claude' : 'a Codex'} account`
  return (
    <Modal title={title} onClose={close} width={480} top={200} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" size="lg" disabled={busy === 'key'} onClick={close}>Cancel</Button>
        {keyForm && <Button variant="primary" size="lg" busy={busy === 'key'} busyLabel="Checking key" disabled={!keyReady || busy !== null} onClick={() => void saveKey()}>{replaceKey ? 'Replace key' : 'Add key'}</Button>}
        {!keyForm && !started && <Button variant="primary" size="lg" busy={busy === 'start'} busyLabel="Opening" disabled={!ready} onClick={() => void start()}>{failed ? 'Try again' : `Sign in with ${name}`}</Button>}
        {!keyForm && started && step?.step === 'code' && <Button variant="primary" size="lg" busy={busy === 'code'} busyLabel="Sending" disabled={!code.trim()} onClick={() => void sendCode()}>Send code</Button>}
      </>
    }>
      <div className="modal-body set-form">
        {!started && !signIn && !replaceKey && <SegmentedControl label="Account type" value={kind} options={KINDS} onChange={pickKind} />}
        {keyForm && (
          <>
            {!replaceKey && (
              <div className="set-field">
                <label htmlFor="acct-label">Name</label>
                <input id="acct-label" className="input set-text-input" autoComplete="off" spellCheck={false} placeholder="Work key" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void saveKey()} />
              </div>
            )}
            <div className="set-field">
              <div className="set-field-head">
                <label htmlFor="acct-key">API key</label>
                <button type="button" className="set-link" aria-label={`Get a key at ${page.host}`} onClick={() => void call('system.openExternal', { url: page.url }).catch((e) => actions.ui.toast({ title: 'Could not open the page', sub: cleanError(e) }))}>Get key</button>
              </div>
              <input id="acct-key" className="input" type="password" autoComplete="off" spellCheck={false} placeholder={page.placeholder} aria-invalid={failed ? true : undefined} aria-describedby={failed ? 'acct-key-error' : 'acct-key-hint'} value={apiKey} onChange={(e) => { setApiKey(e.target.value); setFailed(null) }} onKeyDown={(e) => e.key === 'Enter' && void saveKey()} />
              {failed
                ? <p id="acct-key-error" className="set-error" role="alert">{failed}</p>
                : <p id="acct-key-hint" className="set-help">Billed per token to this key. Kernel only uses it after you switch to it.</p>}
            </div>
          </>
        )}
        {!keyForm && !started && !signIn && (
          <>
            <p className="set-help">
              {claude ? 'Kernel runs claude setup-token, which opens Claude’s sign-in in your browser.' : 'Kernel opens ChatGPT’s sign-in in your browser.'}
              {' '}The account shares your MCP servers, plugins, skills and chats, and you switch to it in Settings or the account menu.
            </p>
            <div className="set-field">
              <label htmlFor="acct-label">Name</label>
              <input id="acct-label" className="input set-text-input" autoComplete="off" spellCheck={false} placeholder="Work" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void start()} />
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
        {!keyForm && !started && signIn && !failed && <p className="set-help">Kernel runs claude setup-token again, which opens Claude&rsquo;s sign-in in your browser. The new sign-in replaces the old one.</p>}
        {!keyForm && !started && failed && (
          <div className="set-field">
            <p className="set-error" role="alert">The sign-in didn&rsquo;t finish. {failed}</p>
          </div>
        )}
        {!keyForm && started && (
          <p className="set-help" role="status">Finish signing in in your browser.{step?.url && <> <button type="button" className="set-link" onClick={() => void call('system.openExternal', { url: step.url! })}>Open the page again</button></>}</p>
        )}
        {!keyForm && started && step?.step === 'code' && (
          <div className="set-field">
            <label htmlFor="acct-code">Code, if the sign-in page shows one</label>
            <input id="acct-code" className="input" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && void sendCode()} />
          </div>
        )}
      </div>
    </Modal>
  )
}
