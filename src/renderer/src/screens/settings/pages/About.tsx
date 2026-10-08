import { useEffect, useState } from 'react'
import type { AppUpdate } from '@shared/types'
import { call } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'

/** What Check for updates says. A failed check (offline, or no releases reachable) is not "up to date". */
const checkResult = (u: AppUpdate) =>
  u.status === 'ready' ? `Version ${u.version} is ready` : u.status === 'downloading' ? `Downloading version ${u.version}` : u.error ? 'Could not check for updates' : 'Kernel is up to date'

const fail = (title: string) => (e: unknown) => actions.ui.toast({ title, sub: (e as Error).message })

/** Settings > About (SettingsAbout.png). */
export function About() {
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const claude = useStore((s) => s.system.preflight?.find((c) => c.id === 'claude'))
  const [busy, run] = useBusy<'check' | 'logs'>()
  useEffect(() => { void call('app.info', undefined).then(setInfo).catch(() => undefined) }, [])
  return (
    <Page title="About">
      <Section title="Kernel">
        <Row label="Version"><span className="set-value">{info?.version ?? ''}</span></Row>
        {claude?.ok && claude.meta && <Row label="Claude Code"><span className="set-value">{claude.meta}</span></Row>}
        <Row label="Updates">
          <Button busy={busy === 'check'} busyLabel="Checking" disabled={busy !== null} onClick={() => void run('check', () => call('update.check', undefined).then((u) => actions.ui.toast({ title: checkResult(u) })).catch(fail('Could not check for updates')))}>Check for updates</Button>
        </Row>
        <Row label="Data"><span className="set-value selectable">{info?.dataDir ?? ''}</span></Row>
        <Row label="Logs">
          <Button busy={busy === 'logs'} busyLabel="Exporting" disabled={busy !== null} onClick={() => void run('logs', () => call('app.exportLogs', undefined).then((r) => actions.ui.toast({ title: 'Logs exported', sub: r.path })).catch(fail('Could not export logs')))}>Export logs</Button>
        </Row>
        <Row label="Onboarding"><Button onClick={() => go({ name: 'onboarding', step: 'welcome' })}>Show again</Button></Row>
      </Section>
    </Page>
  )
}
