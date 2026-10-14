import type { AppSettings } from '@shared/types'
import { SegmentedControl, Select, Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

type General = AppSettings['general']

/** Settings > General (SettingsPage.png, page general): Startup and Composer (KERNEL-680). */
export function General({ s }: { s: AppSettings }) {
  const g = s.general
  return (
    <Page title="General">
      <Section title="Startup">
        <Row label="Open at login"><Toggle label="Open at login" checked={g.openAtLogin} onChange={(v) => void patchSettings({ general: { openAtLogin: v } })} /></Row>
        <Row label="Open to">
          <Select label="Open to" value={g.openTo} onChange={(v) => void patchSettings({ general: { openTo: v as General['openTo'] } })} options={[{ value: 'lastPlace', label: 'Where I left off' }, { value: 'home', label: 'Home' }, { value: 'inbox', label: 'Inbox' }]} />
        </Row>
      </Section>
      <Section title="Composer">
        <Row label="Send with" desc="The other one adds a new line.">
          <SegmentedControl label="Send with" value={g.sendWith} onChange={(v) => void patchSettings({ general: { sendWith: v as General['sendWith'] } })} options={[{ value: 'enter', label: '↵  Enter' }, { value: 'cmdEnter', label: '⌘  ↵' }]} />
        </Row>
      </Section>
    </Page>
  )
}
