import './system.css'
import { useEffect, useRef, useState } from 'react'
import { kernelHookMatcher } from '@shared/hookEntry'
import type { AppSettings, HookStatus } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, Icon, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { NumberField } from './fields'

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
 * Settings > Hooks (MorePage hooks, KERNEL-680, Redesign 15): the server's status with a test, Maintenance, the events and the port. The approval
 * timeout lives on Permissions and the agent-team gates on Models and effort.
 */
export function Hooks({ s }: { s: AppSettings }) {
  const status = useStore((x) => x.system.hooks)
  const [busy, track] = useBusy<'test' | 'remove' | 'install' | 'open'>()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const timeout = s.permissions.approvalTimeoutSec
  const run = (id: 'test' | 'remove' | 'install', fn: () => Promise<HookStatus | unknown>, done: string) => track(id, async () => {
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
  const copySnippet = () => {
    if (!status) return
    void navigator.clipboard.writeText(hooksSnippet(status, timeout)).then(
      () => { setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500) },
      () => actions.ui.toast({ title: 'Could not copy', sub: 'Try again.' })
    )
  }
  // Moving the port restarts the server and rewrites the hooks. A refused port puts the saved one back and says why in a toast.
  const movePort = (port: number) => call('hooks.restart', { port }).then((st): number | undefined => { actions.system.setHooks(st); return st.port }).catch((e: unknown): undefined => { actions.ui.toast({ title: 'Hooks did not change', sub: cleanError(e) }); return undefined })
  const listening = !status || status.listening
  return (
    <Page title="Hooks" desc="How Kernel hears what Claude Code does. Hooks report each step to Kernel's hook server on this Mac.">
      <Section title="Status">
        <Row
          id="hook-status" lead={<span className="sys-tile" data-state={status ? (listening && installed ? 'ok' : 'warn') : undefined}><Icon name={status && !listening ? 'xCircle' : installed || !status ? 'checkCircle' : 'warning'} size={16} /></span>}
          label={<span className="sys-strong">{!status ? 'Checking' : !listening ? 'The hook server isn’t listening' : installed ? 'Hooks are installed' : 'Hooks are not installed'}</span>}
          desc={status && (!listening ? `Nothing answers on port ${status.port}.` : seen ? `The hook server answered ${seenAgo(seen).toLowerCase()} on port ${status.port}.` : `The hook server is listening on port ${status.port}. No event yet.`)}
        >
          <Button busy={busy === 'test'} busyPattern="ripple" busyLabel="Sending" disabled={!status || busy !== null} onClick={() => void run('test', () => call('hooks.test', undefined), 'The hook server answered')}>Send test event</Button>
        </Row>
      </Section>
      <Section title="Maintenance">
        {workspaceRun
          ? <Row label="Hooks are off in a workspace run" desc={`This copy of Kernel never changes ${SETTINGS_FILE}.`} />
          : (
            <Row id="kernel-hooks" label="Kernel’s hooks" desc={`Its entries in ${SETTINGS_FILE}, nothing else.`}>
              <Button busy={busy === 'install'} busyLabel={installed ? 'Reinstalling' : 'Installing'} disabled={!status || busy !== null} onClick={() => status && void run('install', async () => { await call('hooks.install', { port: status.port }); return call('hooks.status', undefined) }, installed ? 'Reinstalled the hooks' : 'Installed the hooks')}>{installed ? 'Reinstall' : 'Install'}</Button>
              {status && installed && <Button busy={busy === 'remove'} busyPattern="ripple" busyLabel="Removing" disabled={busy !== null} onClick={() => void run('remove', () => call('hooks.uninstall', undefined), 'Removed the hooks')}>Remove</Button>}
            </Row>
          )}
        <Row id="settings-file" label="Settings file" desc={SETTINGS_FILE}>
          <span className="set-actions">
            {!workspaceRun && <Button icon={copied ? 'check' : 'copy'} disabled={!status} onClick={copySnippet}>{copied ? 'Copied' : 'Copy snippet'}</Button>}
            <Button icon="ext" busy={busy === 'open'} busyLabel="Opening" disabled={busy !== null} onClick={() => void openFile()}>Open</Button>
          </span>
        </Row>
      </Section>
      {status && (
        <Section title="Events" count={`${count} installed`}>
          {status.events.map((e) => (
            <div key={e.name} className="sys-event">
              <span className="sys-event-name">{e.name}</span>
              <span className="sys-event-state">{e.installed ? (e.lastSeen ? `Last fired ${seenAgo(e.lastSeen).toLowerCase()}` : 'Not fired yet') : 'Not installed'}</span>
            </div>
          ))}
        </Section>
      )}
      {status && (
        <Section title="Advanced">
          <Row id="hook-port" label="Hook server port" desc="Moving it restarts the server and rewrites the hooks.">
            <NumberField label="Hook server port" value={status.port} unit="" min={1024} onSave={movePort} />
          </Row>
        </Section>
      )}
    </Page>
  )
}
