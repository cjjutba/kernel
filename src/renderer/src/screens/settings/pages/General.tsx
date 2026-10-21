import type { AppSettings } from '@shared/types'
import { go } from '../../../store'
import { Button, SegmentedControl, Select, Toggle, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

type General = AppSettings['general']

/** Settings > General (SettingsPage.png, page general): Startup and Composer (KERNEL-680). */
export function General({ s }: { s: AppSettings }) {
  const g = s.general
  const [busy, run] = useBusy()
  // Onboarding runs again from its first step. Nothing already set up is undone: the checks, accounts and team choices start from what is there.
  const again = () => run('again', async () => { if (await patchSettings({ onboarding: { done: false } })) go({ name: 'onboarding', step: 'checks' }) })
  return (
    <Page title="General" desc="How Kernel starts and how the composer sends.">
      <Section title="Startup">
        <Row id="open-at-login" label="Open at login"><Toggle label="Open at login" checked={g.openAtLogin} onChange={(v) => void patchSettings({ general: { openAtLogin: v } })} /></Row>
        <Row id="open-to" setting="general.openTo" label="Open to">
          <Select label="Open to" value={g.openTo} onChange={(v) => void patchSettings({ general: { openTo: v as General['openTo'] } })} options={[{ value: 'lastPlace', label: 'Where I left off' }, { value: 'inbox', label: 'Inbox' }]} />
        </Row>
      </Section>
      <Section title="Setup">
        <Row id="run-onboarding" label="Onboarding" desc="Walk through the checks, accounts, team and notifications again."><Button busy={busy === 'again'} busyLabel="Opening" onClick={() => void again()}>Run again</Button></Row>
      </Section>
      <Section title="Composer">
        <Row id="send-with" label="Send with" desc="The other one adds a new line.">
          <SegmentedControl label="Send with" value={g.sendWith} onChange={(v) => void patchSettings({ general: { sendWith: v as General['sendWith'] } })} options={[{ value: 'enter', label: '↵  Enter' }, { value: 'cmdEnter', label: '⌘  ↵' }]} />
        </Row>
      </Section>
    </Page>
  )
}
