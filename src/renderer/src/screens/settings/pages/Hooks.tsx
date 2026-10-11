import { useState } from 'react'
import { kernelHookMatcher } from '@shared/hookEntry'
import type { AppSettings, HookStatus } from '@shared/types'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, Select, Toggle, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

const TIMEOUTS = [{ value: '120', label: '2 min' }, { value: '300', label: '5 min' }, { value: '600', label: '10 min' }, { value: '1800', label: '30 min' }]

/** What Kernel writes under "hooks" in Claude Code's user settings, for pasting by hand. The installer writes the same matchers. */
export function hooksSnippet(status: HookStatus, approvalTimeoutSec: number): string {
  const hooks: Record<string, unknown[]> = {}
  for (const e of status.events) hooks[e.name] = [kernelHookMatcher(e.name, status.port, approvalTimeoutSec, status.token ?? '')]
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

/** Settings > Hooks (SettingsHooks.png). Events, port, the snippet and Remove sit below what the canvas draws. */
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
    } catch (e) { actions.ui.toast({ title: 'Hooks did not change', sub: (e as Error).message }) }
  })
  const installed = !!status?.installed
  const seen = Math.max(0, ...(status?.events.map((e) => e.lastSeen ?? 0) ?? []))
  const copy = async () => {
    if (!status) return
    try { await navigator.clipboard.writeText(hooksSnippet(status, timeout)); actions.ui.toast({ title: 'Copied the hooks snippet' }) } catch { actions.ui.toast({ title: 'Could not copy', sub: 'Select the snippet and copy it by hand.' }) }
  }
  const openFile = () => track('open', async () => {
    try { await call('app.openTerminal', { cwd: (await call('app.info', undefined)).dataDir, command: 'open ~/.claude/settings.json' }) } catch (e) { actions.ui.toast({ title: 'Could not open the file', sub: (e as Error).message }) }
  })
  const newPort = Number(port)
  return (
    <Page title="Hooks">
      <Section title="Status">
        <Row label="Hook server"><span className="set-value">{status ? (status.listening ? `Live on localhost:${status.port}` : `Not listening on localhost:${status.port}`) : 'Checking'}</span></Row>
        <Row label="Test"><Button busy={busy === 'test'} busyLabel="Sending" disabled={busy !== null} onClick={() => void run('test', () => call('hooks.test', undefined), 'The hook server answered')}>Send test event</Button></Row>
      </Section>
      <Section title="Gates">
        <Row label="Block TaskCompleted without test output"><Toggle label="Block TaskCompleted without test output" checked={s.hooks.requireTestOutput} onChange={(v) => void patchSettings({ hooks: { requireTestOutput: v } })} /></Row>
        <Row label="Keep idle teammates working"><Toggle label="Keep idle teammates working" checked={s.hooks.keepTeammatesWorking} onChange={(v) => void patchSettings({ hooks: { keepTeammatesWorking: v } })} /></Row>
        <Row label="Approval timeout" desc="After this, the request falls back to the normal prompt in Claude Code">
          <Select label="Approval timeout" value={String(timeout)} options={TIMEOUTS.some((t) => t.value === String(timeout)) ? TIMEOUTS : [...TIMEOUTS, { value: String(timeout), label: `${timeout} sec` }]} onChange={(e) => void patchSettings({ permissions: { approvalTimeoutSec: Number(e.target.value) } })} />
        </Row>
      </Section>
      <Section title="Maintenance">
        <Row label={installed ? 'Reinstall hooks' : 'Install hooks'} desc="Rewrites Kernel's entries in ~/.claude/settings.json">
          <span className="set-actions">
            {status && installed && <Button busy={busy === 'remove'} busyLabel="Removing" disabled={busy !== null} onClick={() => void run('remove', () => call('hooks.uninstall', undefined), 'Removed the hooks')}>Remove</Button>}
            <Button busy={busy === 'install'} busyLabel={installed ? 'Reinstalling' : 'Installing'} disabled={!status || busy !== null} onClick={() => status && void run('install', async () => { await call('hooks.install', { port: status.port }); return call('hooks.status', undefined) }, installed ? 'Reinstalled the hooks' : 'Installed the hooks')}>{installed ? 'Reinstall' : 'Install'}</Button>
          </span>
        </Row>
        <Row label="Settings file"><Button busy={busy === 'open'} busyLabel="Opening" disabled={busy !== null} onClick={() => void openFile()}>Open settings.json</Button></Row>
      </Section>
      {status && (
        <>
          <Section title="Events">
            <Row label="Last event received"><span className="set-value">{seenAgo(seen || undefined)}</span></Row>
            {status.events.map((e) => (
              <Row key={e.name} label={e.name}><span className="set-value">{e.installed ? `Installed · ${seenAgo(e.lastSeen)}` : 'Not installed'}</span></Row>
            ))}
          </Section>
          <Section title="Port">
            <Row label="Hook server port" desc="Moving it restarts the server and rewrites the hooks that are installed">
              <span className="set-actions">
                <input className="set-token" style={{ width: 90 }} aria-label="Hook server port" inputMode="numeric" placeholder={String(status.port)} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
                <Button busy={busy === 'port'} busyLabel="Moving" disabled={!newPort || newPort === status.port || busy !== null} onClick={() => void run('port', () => call('hooks.restart', { port: newPort }), `Hook server moved to ${newPort}`).then(() => setPort(''))}>Move</Button>
              </span>
            </Row>
          </Section>
          <Section title="Snippet">
            <Row label="settings.json" desc="What Kernel adds, if you would rather paste it yourself" full={<pre className="set-snippet" tabIndex={0} aria-label="Hooks snippet">{hooksSnippet(status, timeout)}</pre>}>
              <Button onClick={() => void copy()}>Copy</Button>
            </Row>
          </Section>
        </>
      )}
    </Page>
  )
}
