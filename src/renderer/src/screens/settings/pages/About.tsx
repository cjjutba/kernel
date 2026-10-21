import './system.css'
import { useEffect, useState } from 'react'
import type { AppUpdate } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { failToast, useRetryKey } from '../../../retry'
import { Button, Icon, Meter, Spinner, useBusy } from '../../../ui'
import { RELEASES_URL, downloadPercent, installFailedTitle, installFailure, updateReason } from '../../../components/footer/updateModel'
import { Page, Row, Section } from '../kit'
import appIcon from '../../../assets/icon.png'

/** What the Version card says, and its one action, from the last update state the updater pushed. */
export interface AboutView {
  /** The line under the version. */
  line: string
  /** `ok` draws a check before it, `checking` the loader. */
  tone?: 'ok' | 'checking'
  /** The download's percentage, drawn as a bar in place of the buttons. */
  progress?: number
  /** `check` is Check for updates, `again` Check now after a failed check, `restart` a downloaded update, `download` and `install` the answers to a failed install, and `none` has no check at all. */
  action: 'check' | 'again' | 'restart' | 'download' | 'install' | 'none'
}

/**
 * The Version card for an update state. A failed check (offline, or no releases reachable) is not "up to date", a copy outside Applications says why
 * it never checks (KERNEL-443), and an install that failed names the version that is waiting (KERNEL-1021).
 */
export function aboutView(u: AppUpdate | null): AboutView {
  if (!u) return { line: '', action: 'check' }
  if (u.blocked) return { line: u.blocked, action: 'none' }
  if (u.status === 'downloading') return { line: `Downloading Kernel ${u.version}`, progress: downloadPercent(u), action: 'none' }
  if (u.status === 'checking') return { line: 'Checking for updates', tone: 'checking', action: 'check' }
  if (u.status === 'ready') return { line: `Kernel ${u.version} is ready`, action: 'restart' }
  const failed = installFailure(u)
  if (failed && !u.error) return { line: `Kernel ${failed.version} is available`, action: failed.reason === 'signature' ? 'download' : 'install' }
  if (u.status === 'error' || u.error) return { line: updateReason(u.error), action: 'again' }
  return { line: 'Kernel is up to date', tone: 'ok', action: 'check' }
}

/** What Check for updates says in a toast, after it ran. A failed check raises its Try again toast, and the rest are results with nothing to fix. */
function announce(u: AppUpdate) {
  const failed = installFailure(u)
  if (u.blocked) return actions.ui.toast({ title: "Kernel can't update itself", sub: u.blocked, glyph: 'error' })
  if (failed && !u.error) return actions.ui.toast({ title: installFailedTitle(failed), sub: updateReason(undefined, true, failed), glyph: 'error' })
  if (u.error) return failToast("Couldn't check for updates", updateReason(u.error), 'update')
  actions.ui.toast({ title: u.status === 'ready' ? `Kernel ${u.version} is ready` : u.status === 'downloading' ? `Downloading Kernel ${u.version}` : 'Kernel is up to date' })
}

const fail = (title: string) => (e: unknown) => actions.ui.toast({ title, sub: cleanError(e) })
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** Settings > About (MorePage about, KERNEL-680, Redesign 15): the Version card with the one thing the updater is doing, then the data folder, logs and the splash. */
export function About() {
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const update = useStore((s) => s.system.update)
  const [busy, run] = useBusy<'check' | 'logs' | 'reveal' | 'restart'>()
  useEffect(() => {
    void call('app.info', undefined).then(setInfo).catch(() => undefined)
  }, [])
  const check = () => run('check', () => call('update.check', undefined).then((u) => { actions.system.setUpdate(u); announce(u) }).catch(fail("Couldn't check for updates")))
  useRetryKey('update', check)
  // Kernel quits on success, so the button stays busy until it does. With agents working Kernel asks first, and Cancel keeps it running.
  const restart = () => run('restart', () => call('update.install', undefined).then(() => undefined).catch(fail('Could not restart to update')))
  const view = aboutView(update)
  const checking = busy === 'check' || update?.status === 'checking'
  return (
    <Page title="About">
      <Section title="Version">
        <section className="sys-about" aria-label="Version">
          <img className="sys-about-mark" src={appIcon} alt="" />
          <span className="sys-about-text">
            <span className="sys-about-name">Kernel</span>
            <span className="sys-about-sub">Version <span className="mono">{update?.current ?? info?.version ?? ''}</span></span>
            {view.line && (
              <span className="sys-about-line" data-tone={view.tone}>
                {view.tone === 'ok' && <Icon name="check" size={12} />}
                {view.tone === 'checking' && <Spinner label={null} pattern="arrow-down" />}
                {view.line}
              </span>
            )}
          </span>
          {view.progress !== undefined
            ? <span className="sys-about-progress"><Meter value={view.progress / 100} label="Download progress" /><span className="sys-about-percent">{view.progress}%</span></span>
            : (
              <span className="set-actions">
                <Button onClick={() => actions.ui.openModal({ name: 'whatsNew' })}>What's new</Button>
                {(view.action === 'check' || view.action === 'again') && <Button busy={checking} busyLabel="Checking" disabled={busy !== null} onClick={() => void check()}>{view.action === 'again' ? 'Check now' : 'Check for updates'}</Button>}
                {view.action === 'restart' && <Button variant="primary" busy={busy === 'restart'} busyPattern="ripple" busyLabel="Restarting" disabled={busy !== null} onClick={() => void restart()}>Restart to update</Button>}
                {view.action === 'download' && <Button variant="primary" onClick={() => void call('system.openExternal', { url: RELEASES_URL }).catch(fail('Could not open the browser'))}>Download again</Button>}
                {view.action === 'install' && <Button variant="primary" busy={checking} busyLabel="Installing" disabled={busy !== null} onClick={() => void check()}>Install</Button>}
              </span>
            )}
        </section>
      </Section>
      <Section title="Data and support">
        <Row id="data-folder" label="Data folder" desc={<span className="selectable">{home(info?.dataDir ?? '')}</span>}>
          <Button icon="ext" busy={busy === 'reveal'} busyLabel="Opening" disabled={!info || busy !== null} onClick={() => info && void run('reveal', () => call('system.openInEditor', { path: info.dataDir }).then(() => undefined).catch(fail('Could not open the folder')))}>Open</Button>
        </Row>
        <Row id="logs" label="Logs" desc="For a bug report.">
          <Button busy={busy === 'logs'} busyLabel="Exporting" disabled={busy !== null} onClick={() => void run('logs', () => call('app.exportLogs', undefined).then((r) => actions.ui.toast({ title: 'Logs exported', sub: r.path })).catch(fail('Could not export logs')))}>Export logs</Button>
        </Row>
        <Row id="onboarding" label="Onboarding" desc="Play the opening splash again."><Button onClick={() => go({ name: 'onboarding', step: 'splash' })}>Play again</Button></Row>
      </Section>
    </Page>
  )
}
