import './system.css'
import { useState } from 'react'
import { kernelHookMatcher } from '@shared/hookEntry'
import type { AppSettings, HookStatus } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, CopyButton, useBusy } from '../../../ui'
import { DataTable, Page, Row, Section, StatusLine } from '../kit'

const SETTINGS_FILE = '~/.claude/settings.json'

/** What Kernel writes under "hooks" in Claude Code's user settings, for pasting by hand. The installer writes the same matchers. */
export function hooksSnippet(status: HookStatus, approvalTimeoutSec: number): string {
  const hooks: Record<string, unknown[]> = {}
  for (const e of status.events) hooks[e.name] = [kernelHookMatcher(e.name, status.port, approvalTimeoutSec, status.token ?? '', status.build)]
  return JSON.stringify({ hooks }, null, 2)
}

/** "2 min ago", "just now". */
export function seenAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return 'Not yet'
  const m = Math.floor((now - ts) / 60_000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

/**
 * Settings > Hooks (MorePage hooks, KERNEL-680): the server's status with a test, Maintenance, the events (folded) and the port
 * (folded). The approval timeout lives on Permissions and the agent-team gates on Models and effort.
 */
export function Hooks({ s }: { s: AppSettings }) {
  const status = useStore((x) => x.system.hooks)
  const [busy, track] = useBusy<'test' | 'remove' | 'install' | 'open' | 'port'>()
  const [port, setPort] = useState('')
  const timeout = s.permissions.approvalTimeoutSec
  const run = (id: 'test' | 'remove' | 'install' | 'port', fn: () => Promise<HookStatus | unknown>, done: string) => track(id, async () => {
    try {
      const r = await fn()
      if (r && typeof r === 'object' && 'events' in r && 'port' in r) actions.system.setHooks(r as HookStatus)
      else actions.system.setHooks(await call('hooks.status', undefined))
      actions.ui.toast({ title: done })
    } catch (e) { actions.ui.toast({ title: 'Hooks did not change', sub: cleanError(e) }) }
  })
  const installed = !!status?.installed
  // A workspace run never writes Claude's settings, so it says so in place of Reinstall and has no snippet to copy (KERNEL-679).
  const workspaceRun = status?.problem?.kind === 'workspace-run'
  const seen = Math.max(0, ...(status?.events.map((e) => e.lastSeen ?? 0) ?? []))
  const count = status?.events.filter((e) => e.installed).length ?? 0
  const openFile = () => track('open', async () => {
    try { await call('system.openInEditor', { path: SETTINGS_FILE }) } catch (e) { actions.ui.toast({ title: 'Could not open the file', sub: cleanError(e) }) }
  })
  const newPort = Number(port)
  return (
    <Page title="Hooks">
      <Section label="Status" plain>
        <StatusLine
          icon={status && !status.listening ? 'xCircle' : 'checkCircle'} tone={status && !status.listening ? 'warn' : undefined}
          title={status ? (status.listening ? `Live on localhost:${status.port}` : `Not listening on localhost:${status.port}`) : 'Checking'}
          sub={status && `${seen ? `Last event ${seenAgo(seen).toLowerCase()}` : 'No event yet'} · ${count} hook${count === 1 ? '' : 's'} installed`}
          action={<Button busy={busy === 'test'} busyPattern="ripple" busyLabel="Sending" disabled={!status || busy !== null} onClick={() => void run('test', () => call('hooks.test', undefined), 'The hook server answered')}>Send test event</Button>}
        />
      </Section>
      <Section title="Maintenance">
        {workspaceRun
          ? <Row label="Hooks are off in a workspace run" desc={`This copy of Kernel never changes ${SETTINGS_FILE}.`} />
          : (
            <Row id="kernel-hooks" label="Kernel’s hooks" desc={`Its entries in ${SETTINGS_FILE}, nothing else.`}>
              {status && installed && <Button variant="ghost" busy={busy === 'remove'} busyPattern="ripple" busyLabel="Removing" disabled={busy !== null} onClick={() => void run('remove', () => call('hooks.uninstall', undefined), 'Removed the hooks')}>Remove</Button>}
              <Button busy={busy === 'install'} busyLabel={installed ? 'Reinstalling' : 'Installing'} disabled={!status || busy !== null} onClick={() => status && void run('install', async () => { await call('hooks.install', { port: status.port }); return call('hooks.status', undefined) }, installed ? 'Reinstalled the hooks' : 'Installed the hooks')}>{installed ? 'Reinstall' : 'Install'}</Button>
            </Row>
          )}
        <Row id="settings-file" label="Settings file">
          <span className="set-actions">
            <span className="set-value">{SETTINGS_FILE}</span>
            {!workspaceRun && <CopyButton disabled={!status} text={() => (status ? hooksSnippet(status, timeout) : '')} label="Copy snippet" failSub="Try again." />}
            <Button busy={busy === 'open'} busyLabel="Opening" disabled={busy !== null} onClick={() => void openFile()}>Open</Button>
          </span>
        </Row>
      </Section>
      {status && (
        <Section title="Events" count={`${count} installed`} collapsible plain>
          <DataTable label="Events" columns={['Event', 'Last fired']} grid="minmax(0, 1fr) 160px" rows={status.events.map((e) => ({ key: e.name, cells: [<span key="n" className="mono">{e.name}</span>, e.installed ? seenAgo(e.lastSeen) : 'Not installed'] }))} />
        </Section>
      )}
      {status && (
        <Section title="Advanced" collapsible holds={['hook-port']}>
          <Row id="hook-port" label="Hook server port" desc="Moving it restarts the server and rewrites the hooks.">
            <span className="set-actions">
              <input className="set-token sys-port" aria-label="Hook server port" inputMode="numeric" placeholder={String(status.port)} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
              <Button busy={busy === 'port'} busyLabel="Moving" disabled={!newPort || newPort === status.port || busy !== null} onClick={() => void run('port', () => call('hooks.restart', { port: newPort }), `Hook server moved to ${newPort}`).then(() => setPort(''))}>Move</Button>
            </span>
          </Row>
        </Section>
      )}
    </Page>
  )
}
