import { useEffect, useState } from 'react'
import { call } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button } from '../../../ui'
import { Page, Row, Section } from '../kit'

const fail = (title: string) => (e: unknown) => actions.ui.toast({ title, sub: (e as Error).message })

/** Settings > About (SettingsAbout.png). */
export function About() {
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const claude = useStore((s) => s.system.preflight?.find((c) => c.id === 'claude'))
  useEffect(() => { void call('app.info', undefined).then(setInfo).catch(() => undefined) }, [])
  return (
    <Page title="About">
      <Section title="Kernel">
        <Row label="Version"><span className="set-value">{info?.version ?? ''}</span></Row>
        {claude?.ok && claude.meta && <Row label="Claude Code"><span className="set-value">{claude.meta}</span></Row>}
        <Row label="Updates">
          <Button onClick={() => void call('update.check', undefined).then((u) => actions.ui.toast({ title: u.status === 'ready' ? `Version ${u.version} is ready` : 'Kernel is up to date' })).catch(fail('Could not check for updates'))}>Check for updates</Button>
        </Row>
        <Row label="Data"><span className="set-value selectable">{info?.dataDir ?? ''}</span></Row>
        <Row label="Logs">
          <Button onClick={() => void call('app.exportLogs', undefined).then((r) => actions.ui.toast({ title: 'Logs exported', sub: r.path })).catch(fail('Could not export logs'))}>Export logs</Button>
        </Row>
        <Row label="Onboarding"><Button onClick={() => go({ name: 'onboarding', step: 'welcome' })}>Show again</Button></Row>
      </Section>
    </Page>
  )
}
