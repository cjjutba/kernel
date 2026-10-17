import type { PreflightCheck } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { Button, CopyButton, Icon, useBusy } from '../../ui'

/** The port the "use next port" fix will move to, read from the check's own sentence ("Kernel can listen on 7421"). */
const nextPort = (c: PreflightCheck) => /listen on (\d+)/.exec(c.detail)?.[1]

/** A detail with its backticked parts (a variable, a file) as plain text: the line has no room for code styling. */
const plain = (text: string) => text.replaceAll('`', '')

/**
 * The checks' home since they left their own screen (KERNEL-942): one line above New chat's box for the first check that stops
 * agents, with its one fix. It shows only while a blocking check fails, and goes when a recheck passes.
 */
export function ReadinessLine() {
  const check = useStore((s) => s.system.preflight?.find((c) => !c.ok && c.blocking))
  const [busy, run] = useBusy<'check' | 'fix'>()
  if (!check) return null
  const recheck = () => run('check', async () => {
    try { actions.system.setPreflight(await call('preflight.run', undefined)) } catch (e) { actions.ui.toast({ title: 'Could not check again', sub: cleanError(e) }) }
  })
  const fix = () => run('fix', async () => {
    try { actions.system.setPreflight(await call('preflight.fix', { id: check.id })) } catch (e) { actions.ui.toast({ title: 'Could not fix it', sub: cleanError(e) }) }
  })
  const port = nextPort(check)
  return (
    <div className="lead-ready" role="status">
      <Icon name="info" size={16} />
      <span className="lead-ready-text">
        <span className="lead-ready-title">{check.title}</span>
        <span className="lead-ready-detail">{plain(check.detail)}</span>
      </span>
      {check.fix?.command && <CopyButton text={check.fix.command} label="Copy command" failSub={check.fix.command} disabled={busy !== null} />}
      {check.fix?.action === 'use-next-port'
        ? <Button size="sm" variant="primary" busy={busy === 'fix'} busyLabel="Switching" disabled={busy !== null} onClick={() => void fix()}>{port ? `Use ${port}` : 'Use the next port'}</Button>
        : <Button size="sm" variant="primary" busy={busy === 'check'} busyLabel="Checking" busyPattern="rotate" disabled={busy !== null} onClick={() => void recheck()}>Check again</Button>}
    </div>
  )
}
