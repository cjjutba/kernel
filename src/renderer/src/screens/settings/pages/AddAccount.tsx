import { useEffect, useRef, useState } from 'react'
import type { Provider } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, LinkButton, Icon, Modal, ProviderMark, Spinner, useBusy } from '../../../ui'
import './accounts.css'

/** What the first step offers: a Claude Code login, a ChatGPT login for Codex, or an API key for either. */
type Pick = 'claude' | 'codex' | 'key'

const PICKS: { value: Pick; title: string; desc: string }[] = [
  { value: 'claude', title: 'Claude account', desc: 'Sign in with your browser. Pro, Max, Team and Enterprise plans work.' },
  { value: 'codex', title: 'ChatGPT, for Codex', desc: 'Sign in with your browser, for roles that run on Codex.' },
  { value: 'key', title: 'API key', desc: 'Paste an Anthropic or OpenAI key. Billed per token.' }
]
const KEY_PAGE: Record<Provider, { console: string; host: string; url: string; placeholder: string }> = {
  claude: { console: 'the Anthropic Console', host: 'console.anthropic.com', url: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-' },
  codex: { console: 'the OpenAI platform', host: 'platform.openai.com', url: 'https://platform.openai.com/api-keys', placeholder: 'sk-' }
}
const SIGN_IN_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'ChatGPT' }

/** The engine refuses a login Kernel already has with "That account is already in Kernel." (KERNEL-616). Trying again can't help, so the dialog says so and offers another account. */
const DUPLICATE = /already in Kernel/i

/** An Anthropic key starts `sk-ant-`, an OpenAI one only `sk-`, so a pasted key says which provider it is for. Nothing pasted yet follows the pick. */
const providerOfKey = (key: string, fallback: Provider): Provider => (key.trim().startsWith('sk-ant-') ? 'claude' : key.trim().startsWith('sk-') ? 'codex' : fallback)

/**
 * Add account, Sign in again for an added account (`signIn`, KERNEL-406, with its `accountId` since KERNEL-567), or Replace key
 * for an API key account (`replaceKey`, KERNEL-524). Adding starts on three cards (Claude account, ChatGPT for Codex, API key), and
 * Continue opens what the pick needs (Redesign 15, Pen 15.5). A sign-in opens the provider's page in the browser and waits there: the dialog
 * names the account after its email once it finishes, and Done leaves it running. Claude's login asks for a code at once, though the browser
 * usually hands the sign-in back by itself, so the dialog offers "The page shows a code?" and shows the field only after it is clicked
 * (KERNEL-615). A failed sign-in says why and offers Try again. An API key is checked with the provider before it is kept, and a refused key
 * shows the provider's reason in the dialog. No pasted token (D-018).
 */
export function AddAccount({ provider, signIn, replaceKey, onClose }: { provider: Provider; signIn?: { label: string; accountId?: string }; replaceKey?: { accountId: string; label: string }; onClose: () => void }) {
  const [pick, setPick] = useState<Pick>(provider === 'codex' ? 'codex' : 'claude')
  // The step the dialog is on: the picks, the key form, or a sign-in that has started.
  const [view, setView] = useState<'pick' | 'key' | 'wait'>(replaceKey ? 'key' : signIn ? 'wait' : 'pick')
  const [target, setTarget] = useState<Provider>(provider)
  const step = useStore((s) => (s.accountAdd?.provider === target ? s.accountAdd : null))
  const existing = useStore((s) => s.accounts)
  const [code, setCode] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [started, setStarted] = useState(!!signIn)
  const [codeShown, setCodeShown] = useState(false)
  const codeInput = useRef<HTMLInputElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, run] = useBusy<'start' | 'code' | 'key'>()
  const keyTarget = providerOfKey(apiKey, pick === 'codex' ? 'codex' : provider)
  const page = KEY_PAGE[replaceKey ? provider : keyTarget]
  const name = SIGN_IN_NAME[target]
  const duplicate = !!failed && DUPLICATE.test(failed)
  const keyReady = !!apiKey.trim()
  useEffect(() => () => actions.accounts.adding(null), [])
  useEffect(() => { if (codeShown) codeInput.current?.focus() }, [codeShown])
  // Signing in again has nothing to pick, so the browser opens at once.
  const startedAgain = useRef(false)
  useEffect(() => { if (signIn && !startedAgain.current) { startedAgain.current = true; void start(provider) } }, [])
  const start = (p: Provider) => run('start', async () => {
    actions.accounts.adding(null)
    setFailed(null)
    setCodeShown(false)
    setTarget(p)
    setView('wait')
    setStarted(true)
    try {
      if (signIn) await call('providers.signIn', { provider: p, ...(signIn.accountId ? { accountId: signIn.accountId } : {}) })
      else await call('accounts.add', { provider: p })
      actions.accounts.set(await call('accounts.list', undefined))
      onClose()
    } catch (e) {
      setStarted(false)
      if (!/canceled/i.test(String(e))) setFailed(cleanError(e))
    }
  })
  /** The name a new key takes: "API key", then "API key 2", since the engine wants one and Rename is in the account's menu. */
  const keyName = (p: Provider) => {
    const taken = new Set(existing.filter((a) => a.provider === p).map((a) => a.label.toLowerCase()))
    let n = 1
    while (taken.has(n === 1 ? 'api key' : `api key ${n}`)) n++
    return n === 1 ? 'API key' : `API key ${n}`
  }
  const saveKey = () => run('key', async () => {
    if (!keyReady) return
    setFailed(null)
    try {
      await call('accounts.addKey', replaceKey ? { provider, accountId: replaceKey.accountId, key: apiKey.trim() } : { provider: keyTarget, label: keyName(keyTarget), key: apiKey.trim() })
      actions.accounts.set(await call('accounts.list', undefined))
      onClose()
    } catch (e) { setFailed(cleanError(e)) }
  })
  const close = () => {
    if (busy === 'key') return
    if (started) void call('accounts.cancelAdd', { provider: target }).catch(() => undefined)
    onClose()
  }
  /** Done: the sign-in goes on in the browser and the account shows up in the list when it lands. */
  const leave = () => { setStarted(false); onClose() }
  const sendCode = () => run('code', async () => {
    try { await call('accounts.code', { provider: target, code: code.trim() }); setCode('') } catch (e) { actions.ui.toast({ title: 'Could not send the code', sub: cleanError(e) }) }
  })
  const next = () => { if (pick === 'key') { setFailed(null); setView('key') } else void start(pick) }
  const title = signIn ? `Sign in to ${signIn.label}` : replaceKey ? `Replace ${replaceKey.label}` : view === 'key' ? 'Add an API key' : view === 'wait' ? `Sign in to ${name}` : 'Add an account'
  const waiting = view === 'wait' && started
  const stopped = view === 'wait' && !started
  return (
    <Modal title={title} onClose={close} width={480} top={200} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" size="lg" disabled={busy === 'key'} onClick={close}>Cancel</Button>
        {view === 'pick' && <Button variant="primary" size="lg" disabled={busy !== null} onClick={next}>Continue</Button>}
        {view === 'key' && <Button variant="primary" size="lg" busy={busy === 'key'} busyLabel="Checking key" disabled={!keyReady || busy !== null} onClick={() => void saveKey()}>{replaceKey ? 'Replace key' : 'Add key'}</Button>}
        {waiting && !codeShown && <Button variant="primary" size="lg" onClick={leave}>Done</Button>}
        {waiting && step?.step === 'code' && codeShown && <Button variant="primary" size="lg" busy={busy === 'code'} busyLabel="Sending" disabled={!code.trim()} onClick={() => void sendCode()}>Send code</Button>}
        {stopped && <Button variant="primary" size="lg" busy={busy === 'start'} busyLabel="Opening" disabled={busy !== null} onClick={() => void start(target)}>{duplicate ? 'Try another account' : 'Try again'}</Button>}
      </>
    }>
      <div className="modal-body set-form">
        {view === 'pick' && (
          <>
            <p className="ac-lead">Agents run on the account you pick. Kernel keeps each sign-in in your keychain.</p>
            <div className="ac-picks" role="radiogroup" aria-label="Account type">
              {PICKS.map((p) => (
                <button key={p.value} type="button" role="radio" aria-checked={pick === p.value} className="ac-pick" onClick={() => setPick(p.value)}>
                  <span className="ac-mark" aria-hidden="true">{p.value === 'key' ? <Icon name="key" size={14} /> : <ProviderMark provider={p.value} size={14} />}</span>
                  <span className="set-text"><span className="set-label">{p.title}</span><span className="set-desc">{p.desc}</span></span>
                  <span className="ac-radio" aria-hidden="true" />
                </button>
              ))}
            </div>
          </>
        )}
        {view === 'key' && (
          <>
            <p className="ac-lead">{replaceKey ? `Paste a new key for ${replaceKey.label}.` : `Paste a key from ${page.console}.`}</p>
            <div className="set-field">
              <div className="set-field-head">
                <label htmlFor="acct-key">API key</label>
                <LinkButton size="meta" aria-label={`Get a key at ${page.host}`} onClick={() => void call('system.openExternal', { url: page.url }).catch((e) => actions.ui.toast({ title: 'Could not open the page', sub: cleanError(e) }))}>Get key</LinkButton>
              </div>
              <input id="acct-key" className="input" type="password" autoComplete="off" spellCheck={false} autoFocus placeholder={page.placeholder} aria-invalid={failed ? true : undefined} aria-describedby={failed ? 'acct-key-error' : 'acct-key-hint'} value={apiKey} onChange={(e) => { setApiKey(e.target.value); setFailed(null) }} onKeyDown={(e) => e.key === 'Enter' && void saveKey()} />
              {failed
                ? <p id="acct-key-error" className="set-error" role="alert">{failed}</p>
                : <p id="acct-key-hint" className="set-help">Kept in your keychain. Billed per token.</p>}
            </div>
          </>
        )}
        {waiting && (
          <>
            <p className="ac-lead">Your browser opened {name}’s sign-in.</p>
            <div className="ac-wait" role="status">
              <Spinner label={null} pattern="arrow-down" />
              <span className="ac-wait-title">Finish signing in to {name} in your browser</span>
              <p className="set-help">This window updates on its own.</p>
              {step?.url && <LinkButton onClick={() => void call('system.openExternal', { url: step.url! })}>Open the page again</LinkButton>}
              {step?.step === 'code' && !codeShown && <LinkButton onClick={() => setCodeShown(true)}>The page shows a code?</LinkButton>}
            </div>
            {step?.step === 'code' && codeShown && (
              <div className="set-field">
                <label htmlFor="acct-code">Code, if the sign-in page shows one</label>
                <input id="acct-code" ref={codeInput} className="input" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && void sendCode()} />
              </div>
            )}
          </>
        )}
        {stopped && failed && duplicate && (
          <>
            <p className="ac-lead">{failed}</p>
            <p className="ac-wait-note"><Icon name="info" size={14} />Pick another account in the browser, or cancel.</p>
          </>
        )}
        {stopped && failed && !duplicate && (
          <>
            <p className="ac-lead">The sign-in didn’t finish.</p>
            <p className="set-error" role="alert">{failed}</p>
          </>
        )}
      </div>
    </Modal>
  )
}
