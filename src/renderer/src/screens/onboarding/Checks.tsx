import { useEffect, useRef, useState } from 'react'
import type { HookStatus, PreflightCheck } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go, isFixture, launchRoute, useStore } from '../../store'
import { Button, CodeBlock, Icon, Spinner } from '../../ui'
import './onboarding.css'

/** How long the preflight call may stay unanswered before the page says so and offers Check again. */
const SLOW_AFTER_MS = 10_000

/** The port the "use next port" fix will move to, read from the check's own sentence ("Kernel can listen on 7421"). */
const nextPort = (c: PreflightCheck) => /listen on (\d+)/.exec(c.detail)?.[1]

/** A detail or note, with the parts in backticks (a variable, a file) in mono (KERNEL-437). */
function Ticks({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 ? <code key={i} className="ob-code">{part}</code> : part))}</>
}

/**
 * What each failing check offers. A command shows a copyable box with Check again; an action shows its own buttons. A
 * warning's button is bordered, so Continue stays the one ink button on the page (KERNEL-437).
 */
function Fix({ check, busy, onFix, onRecheck }: { check: PreflightCheck; busy: string | null; onFix: () => void; onRecheck: () => void }) {
  const [showProcess, setShowProcess] = useState(false)
  const { fix } = check
  if (!fix) return null
  const recheck = <Button variant={check.blocking ? 'primary' : 'secondary'} busy={busy === `recheck:${check.id}`} busyPattern="rotate" busyLabel="Checking" disabled={busy !== null} onClick={onRecheck}>Check again</Button>
  if (fix.command) {
    return (
      <>
        <div className="ob-fix"><CodeBlock>{fix.command}</CodeBlock></div>
        <div className="ob-acts">{recheck}</div>
      </>
    )
  }
  if (fix.action === 'recheck') return <div className="ob-acts">{recheck}</div>
  const port = nextPort(check)
  const lsof = `lsof -nP -iTCP:${/Port (\d+)/.exec(check.title)?.[1] ?? ''} -sTCP:LISTEN`
  return (
    <>
      <div className="ob-acts">
        {fix.action === 'use-next-port' && <Button variant="primary" busy={busy === `fix:${check.id}`} busyLabel="Switching" disabled={busy !== null} onClick={onFix}>{port ? `Use ${port}` : 'Use the next port'}</Button>}
        {fix.action === 'use-next-port' && <Button aria-expanded={showProcess} onClick={() => setShowProcess(!showProcess)}>Show process</Button>}
      </div>
      {showProcess && <div className="ob-fix"><CodeBlock>{lsof}</CodeBlock></div>}
    </>
  )
}

/** Whether Continue opens Check hooks first: hooks aren't installed, and this isn't a workspace run, which never installs them (KERNEL-679). */
export const needsHookCheck = (hooks: HookStatus | null) => !!hooks && !hooks.installed && hooks.problem?.kind !== 'workspace-run'

/** Setup*.png: the readiness checks, then the first project once everything passes. */
export function Checks() {
  const checks = useStore((s) => s.system.preflight)
  const projects = useStore((s) => s.projects)
  // `recheck:<id>` or `fix:<id>` names the button that spins. The check on open has no button.
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [slow, setSlow] = useState(false)
  const latest = useRef(0)
  const limit = useStore((s) => s.ui.preflightLimitMs)

  // A newer call replaces one that never answered: only the latest call's answer is used. The page turns "slow" when the call
  // itself has been pending past the limit, so it follows the call and not a status.
  const run = async (key: string, fn: () => Promise<PreflightCheck[]>) => {
    const id = ++latest.current
    setBusy(key)
    setError(null)
    setSlow(false)
    try {
      const next = await fn()
      if (id === latest.current) actions.system.setPreflight(next)
    } catch (e) {
      if (id === latest.current) setError(cleanError(e))
    } finally {
      if (id === latest.current) { setBusy(null); setSlow(false) }
    }
  }
  const recheck = (key = 'open') => run(key, () => call('preflight.run', undefined))
  useEffect(() => { void recheck() }, [])
  useEffect(() => {
    if (busy === null) return
    const t = window.setTimeout(() => setSlow(true), (isFixture() ? limit : undefined) ?? SLOW_AFTER_MS)
    return () => window.clearTimeout(t)
  }, [busy, limit])

  // Only a blocking failure keeps Continue off. A non-blocking one is a warning with its fix beside it (KERNEL-213).
  const failing = checks?.filter((c) => !c.ok).length ?? 0
  const blocked = checks?.some((c) => !c.ok && c.blocking) ?? false
  const next = async () => {
    // A first run with no hooks installed goes through Check hooks before the first project.
    if (needsHookCheck(await call('hooks.status', undefined).catch(() => null))) { actions.ui.openModal({ name: 'checkHooks' }); return }
    // The place the app opens at launch, so Continue after a failed check doesn't land on Home over the place you left.
    // A first run, with no project yet, picks its permission mode before the first project (KERNEL-457).
    if (projects.length) go(launchRoute(), { history: 'replace' }); else go({ name: 'onboarding', step: 'permissions' })
  }

  return (
    <div className="panel ob-bare">
      <div className="ob-page">
        <div className="ob-col">
          <h1 className="ob-h1">Getting Kernel ready</h1>
          <p className="ob-sub">Kernel checks your Mac before it starts any agents.</p>
          <div className="ob-list" aria-busy={busy !== null}>
            {(checks ?? []).map((c) => (
              <div key={c.id} className="ob-check" data-ok={c.ok} data-blocking={c.blocking}>
                <span className="ob-ico"><Icon name={c.ok ? 'check' : c.blocking ? 'close' : 'warning'} size={16} /></span>
                <div className="ob-body">
                  <span className="ob-name">{c.title}</span>
                  <span className="ob-detail"><Ticks text={c.detail} /></span>
                  {c.note && <span className="ob-note"><Ticks text={c.note} /></span>}
                  {!c.ok && <Fix check={c} busy={busy} onRecheck={() => void recheck(`recheck:${c.id}`)} onFix={() => void run(`fix:${c.id}`, () => call('preflight.fix', { id: c.id }))} />}
                </div>
                {c.ok && c.meta && <span className="ob-meta">{c.meta}</span>}
              </div>
            ))}
            {!checks && error && (
              <div className="ob-check" data-ok="false" data-blocking="true">
                <span className="ob-ico"><Icon name="close" size={16} /></span>
                <div className="ob-body">
                  <span className="ob-name">The setup checks did not run</span>
                  <span className="ob-detail">{error}</span>
                  <div className="ob-acts"><Button variant="primary" disabled={busy !== null} busy={busy === 'retry'} busyLabel="Checking" busyPattern="rotate" onClick={() => void recheck('retry')}>Check again</Button></div>
                </div>
              </div>
            )}
            {!checks && !error && (
              <div className="ob-check">
                <Spinner label="Checking" pattern="arrow-down" />
                <div className="ob-body">
                  <span className="muted">{slow ? 'Still checking' : 'Checking'}</span>
                  {slow && <span className="ob-detail">This is taking longer than usual. Kernel has not heard back from your Mac yet.</span>}
                  {slow && <div className="ob-acts"><Button onClick={() => void recheck('retry')}>Check again</Button></div>}
                </div>
              </div>
            )}
          </div>
          <div className="ob-bar">
            <span role="status">{error && checks ? error : error ? 'The checks did not run.' : (!checks ? '' : failing ? `${failing} ${failing === 1 ? 'thing needs' : 'things need'} your attention.` : 'Everything checks out.')}</span>
            <Button variant="primary" size="lg" disabled={!checks || blocked} onClick={() => void next()}>Continue</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
