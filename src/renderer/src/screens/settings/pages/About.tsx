import './system.css'
import { useEffect, useState } from 'react'
import type { AppUpdate } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { downloadPercent, updateReason } from '../../../components/footer/updateModel'
import { Page, Row, Section } from '../kit'

/**
 * What Check for updates says. A failed check (offline, or no releases reachable) is not "up to date", and a copy outside
 * Applications says why it never checks (KERNEL-443).
 */
const checkResult = (u: AppUpdate): { title: string; sub?: string } =>
  u.blocked ? { title: "Kernel can't update itself", sub: u.blocked }
    : { title: u.status === 'ready' ? `Version ${u.version} is ready` : u.status === 'downloading' ? `Downloading version ${u.version}` : u.error ? updateReason(u.error) : 'Kernel is up to date' }

/** The words after the version on the header card, from the last update state. */
export const state = (u: AppUpdate | null): string =>
  !u ? '' : u.blocked ? 'Can’t update itself' : u.status === 'ready' ? `Version ${u.version} is ready` : u.status === 'downloading' ? `Downloading version ${u.version}, ${downloadPercent(u)}%` : u.status === 'checking' ? 'Checking' : u.status === 'error' || u.error ? updateReason(u.error) : 'Up to date'

const fail = (title: string) => (e: unknown) => actions.ui.toast({ title, sub: cleanError(e) })
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** Settings > About (MorePage about, KERNEL-680): the app card with its version, then the data folder, logs and onboarding. */
export function About() {
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const update = useStore((s) => s.system.update)
  const [busy, run] = useBusy<'check' | 'logs' | 'reveal'>()
  useEffect(() => {
    void call('app.info', undefined).then(setInfo).catch(() => undefined)
  }, [])
  const sub = state(update)
  const downloading = update?.status === 'downloading'
  return (
    <Page title="About">
      <section className="sys-about" aria-label="Version">
        <span className="sys-about-mark" aria-hidden="true">K</span>
        <span className="sys-about-text">
          <span className="sys-about-name">Kernel</span>
          <span className="sys-about-sub">Version <span className="mono">{info?.version ?? ''}</span>{sub && ` · ${sub}`}</span>
        </span>
        <Button busy={busy === 'check' || downloading} busyPattern={downloading ? 'arrow-down' : 'rotate'} busyLabel={downloading ? 'Downloading' : 'Checking'} disabled={busy !== null} onClick={() => void run('check', () => call('update.check', undefined).then((u) => { actions.system.setUpdate(u); actions.ui.toast(checkResult(u)) }).catch(fail('Could not check for updates')))}>Check for updates</Button>
      </section>
      <Section label="Data and support">
        <Row id="data-folder" label="Data folder">
          <span className="set-actions">
            <span className="set-value selectable">{home(info?.dataDir ?? '')}</span>
            <Button busy={busy === 'reveal'} busyLabel="Opening" disabled={!info || busy !== null} onClick={() => info && void run('reveal', () => call('system.openInEditor', { path: info.dataDir }).then(() => undefined).catch(fail('Could not open the folder')))}>Reveal</Button>
          </span>
        </Row>
        <Row id="logs" label="Logs" desc="For a bug report.">
          <Button busy={busy === 'logs'} busyLabel="Exporting" disabled={busy !== null} onClick={() => void run('logs', () => call('app.exportLogs', undefined).then((r) => actions.ui.toast({ title: 'Logs exported', sub: r.path })).catch(fail('Could not export logs')))}>Export logs</Button>
        </Row>
        <Row id="onboarding" label="Onboarding" desc="Walk through setup again."><Button onClick={() => go({ name: 'onboarding', step: 'welcome' })}>Show again</Button></Row>
      </Section>
    </Page>
  )
}
