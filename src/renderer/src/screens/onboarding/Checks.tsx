import { useEffect, useState } from 'react'
import type { PreflightCheck } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, useBusy } from '../../ui'
import { Card, Command, Rich, StateMark } from './parts'
import type { StepFrame } from './Onboarding'

type Id = PreflightCheck['id']

/** The checks this step shows, in order. Claude's sign-in is on the Accounts step. `optional` ones are tagged and never hold Continue. */
const ROWS: { id: Id; name: string; what: string; optional?: boolean }[] = [
  { id: 'claude', name: 'Claude Code', what: 'Kernel’s own copy runs every agent.' },
  { id: 'git', name: 'Git', what: 'Each agent’s work lives in its own git worktree.' },
  { id: 'hooks', name: 'Hook server', what: 'Agents report what they’re doing to Kernel here.' },
  { id: 'gh', name: 'GitHub CLI', what: 'Opens and merges pull requests.', optional: true },
  { id: 'codex', name: 'Codex', what: 'Runs any role you put on Codex.', optional: true }
]

const nextPort = (c: PreflightCheck) => /listen on (\d+)/.exec(c.detail)?.[1]

/** Check your Mac (KERNEL-1088): the tools Kernel needs, run as the step opens and again on Check again. Required ones hold Continue. */
export function useChecks(): StepFrame {
  const checks = useStore((s) => s.system.preflight)
  const [checking, setChecking] = useState(true)
  const [busy, run] = useBusy<'fix' | 'codex'>()
  const check = async () => {
    setChecking(true)
    try { actions.system.setPreflight(await call('preflight.run', undefined)) } catch (e) { actions.ui.toast({ title: 'Could not check again', sub: cleanError(e) }) } finally { setChecking(false) }
  }
  useEffect(() => { void check() }, [])
  const by = (id: Id) => checks?.find((c) => c.id === id)
  // The login-shell read can time out. It is a warning that needs no row of its own beyond the others, so it only shows when it fails.
  const shell = by('shell')
  const required = [...ROWS.filter((r) => !r.optional).map((r) => by(r.id)), ...(shell?.blocking ? [shell] : [])]
  const held = checking || !checks || required.some((c) => !c || !c.ok)
  const fix = (c: PreflightCheck) => run('fix', async () => {
    try { actions.system.setPreflight(await call('preflight.fix', { id: c.id })) } catch (e) { actions.ui.toast({ title: 'Could not fix it', sub: cleanError(e) }) }
  })
  const setUpCodex = () => run('codex', async () => {
    try {
      await call('providers.signIn', { provider: 'codex' })
      actions.system.setPreflight(await call('preflight.run', undefined))
    } catch (e) { actions.ui.toast({ title: 'Could not set up Codex', sub: cleanError(e) }) }
  })
  const row = (r: (typeof ROWS)[number]) => {
    const c = by(r.id)
    const state = checking ? 'checking' : c?.ok ? 'ok' : r.optional ? 'skip' : 'fail'
    const failed = !checking && !c?.ok
    const port = c && nextPort(c)
    return (
      <div key={r.id} className="ob-row" role="listitem" data-state={state}>
        <StateMark state={state} />
        <span className="ob-body">
          <span className="ob-name">{failed && c ? c.title : r.name}{r.optional && <span className="ob-tag">Optional</span>}</span>
          <span className="ob-detail">{failed && c && !(r.optional && r.id === 'codex') ? <Rich text={c.detail} /> : r.what}</span>
          {failed && c?.fix?.command && <Command text={c.fix.command} />}
        </span>
        {checking ? <span className="ob-meta">Checking</span> : c?.ok && c.meta ? <span className="ob-meta">{c.meta}</span> : null}
        {failed && c?.fix?.action === 'use-next-port' && <Button size="sm" busy={busy === 'fix'} busyLabel="Switching" disabled={busy !== null} onClick={() => void fix(c)}>{port ? `Use ${port}` : 'Use the next port'}</Button>}
        {failed && r.id === 'codex' && <Button size="sm" busy={busy === 'codex'} busyLabel="Setting up" disabled={busy !== null} onClick={() => void setUpCodex()}>Set up</Button>}
      </div>
    )
  }
  return {
    title: 'Check your Mac',
    sub: 'Kernel needs a few tools to run agents. It checks them now, and again at every launch.',
    canContinue: !held,
    onContinue: () => go({ name: 'onboarding', step: 'accounts' }, { history: 'replace' }),
    extra: <Button variant="ghost" busy={checking} busyLabel="Checking" disabled={busy !== null || checking} onClick={() => void check()}>Check again</Button>,
    body: <Card label="Checks">{shell && !shell.ok && (
      <div className="ob-row" role="listitem" data-state="skip">
        <StateMark state="skip" />
        <span className="ob-body"><span className="ob-name">{shell.title}</span><span className="ob-detail"><Rich text={shell.detail} /></span></span>
      </div>
    )}{ROWS.map(row)}</Card>
  }
}
