import { useEffect, useState } from 'react'
import type { PreflightCheck } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, CodeBlock, Icon, Spinner } from '../../ui'
import { FirstRoom } from './FirstRoom'
import './onboarding.css'

/** The port the "use next port" fix will move to, read from the check's own sentence ("Kernel can listen on 7421"). */
const nextPort = (c: PreflightCheck) => /listen on (\d+)/.exec(c.detail)?.[1]

/** What each failing check offers. A command shows a copyable box with Check again; an action shows its own buttons. */
function Fix({ check, busy, onFix, onRecheck }: { check: PreflightCheck; busy: boolean; onFix: () => void; onRecheck: () => void }) {
  const [showProcess, setShowProcess] = useState(false)
  const { fix } = check
  if (!fix) return null
  if (fix.command) {
    return (
      <>
        <div className="ob-fix"><CodeBlock>{fix.command}</CodeBlock></div>
        <div className="ob-acts"><Button variant="primary" disabled={busy} onClick={onRecheck}>Check again</Button></div>
      </>
    )
  }
  const port = nextPort(check)
  const lsof = `lsof -nP -iTCP:${/Port (\d+)/.exec(check.title)?.[1] ?? ''} -sTCP:LISTEN`
  return (
    <>
      <div className="ob-acts">
        {fix.action === 'enable-teams' && <Button variant="primary" disabled={busy} onClick={onFix}>Turn on for Kernel</Button>}
        {fix.action === 'use-next-port' && <Button variant="primary" disabled={busy} onClick={onFix}>{port ? `Use ${port}` : 'Use the next port'}</Button>}
        {fix.action === 'use-next-port' && <Button aria-expanded={showProcess} onClick={() => setShowProcess(!showProcess)}>Show process</Button>}
      </div>
      {showProcess && <div className="ob-fix"><CodeBlock>{lsof}</CodeBlock></div>}
    </>
  )
}

/** Setup*.png: the readiness checks, then the first room once everything passes. */
export function Checks() {
  const checks = useStore((s) => s.system.preflight)
  const rooms = useStore((s) => s.rooms)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const run = async (fn: () => Promise<PreflightCheck[]>) => {
    setBusy(true); setError(null)
    try { actions.system.setPreflight(await fn()) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const recheck = () => run(() => call('preflight.run', undefined))
  useEffect(() => { void recheck() }, [])

  if (ready) return <FirstRoom />

  const failing = checks?.filter((c) => !c.ok).length ?? 0
  const next = async () => {
    // A first run with no hooks installed goes through Check hooks before the first room.
    const hooks = await call('hooks.status', undefined).catch(() => null)
    if (hooks && !hooks.installed) { actions.ui.openModal({ name: 'checkHooks' }); return }
    if (rooms.length) go({ name: 'home' }); else setReady(true)
  }

  return (
    <div className="panel" style={{ background: 'transparent', border: 0 }}>
      <div className="ob-page">
        <div className="ob-col">
          <h1 className="ob-h1">Getting Kernel ready</h1>
          <p className="ob-sub">Kernel checks your Mac before it starts any agents.</p>
          <div className="ob-list" aria-busy={busy}>
            {(checks ?? []).map((c) => (
              <div key={c.id} className="ob-check" data-ok={c.ok}>
                <span className="ob-ico"><Icon name={c.ok ? 'check' : 'x'} size={15} stroke={c.ok ? 1.7 : 1.4} /></span>
                <div className="ob-body">
                  <span className="ob-name">{c.title}</span>
                  <span className="ob-detail">{c.detail}</span>
                  {!c.ok && <Fix check={c} busy={busy} onRecheck={() => void recheck()} onFix={() => void run(() => call('preflight.fix', { id: c.id }))} />}
                </div>
                {c.ok && c.meta && <span className="ob-meta">{c.meta}</span>}
              </div>
            ))}
            {!checks && <div className="ob-check"><Spinner label="Checking" /><span className="muted">Checking</span></div>}
          </div>
          <div className="ob-bar">
            <span role="status">{error ?? (!checks ? '' : failing ? `${failing} ${failing === 1 ? 'thing needs' : 'things need'} your attention.` : 'Everything is ready.')}</span>
            <Button variant="primary" size="lg" disabled={!checks || failing > 0} onClick={() => void next()}>Continue</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
