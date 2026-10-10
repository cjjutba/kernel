import type { AppSettings } from '@shared/types'
import { Select, Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

/** Settings > General (Settings.png). */
export function General({ s }: { s: AppSettings }) {
  const g = s.general
  return (
    <Page title="General">
      <Section title="General">
        <Row label="Default home view" desc="What opens when you launch Kernel">
          <Select label="Default home view" value={g.openTo} onChange={(e) => void patchSettings({ general: { openTo: e.target.value as AppSettings['general']['openTo'] } })} options={[{ value: 'lastPlace', label: 'Where I left off' }, { value: 'home', label: 'Home' }, { value: 'inbox', label: 'Inbox' }]} />
        </Row>
        <Row label="Open at login"><Toggle label="Open at login" checked={g.openAtLogin} onChange={(v) => void patchSettings({ general: { openAtLogin: v } })} /></Row>
        <Row label="Show in menu bar" desc="Approve requests and brief the Lead without opening the window"><Toggle label="Show in menu bar" checked={g.menuBar} onChange={(v) => void patchSettings({ general: { menuBar: v } })} /></Row>
        <Row label="Send messages with">
          <Select label="Send messages with" value={g.sendWith} onChange={(e) => void patchSettings({ general: { sendWith: e.target.value as AppSettings['general']['sendWith'] } })} options={[{ value: 'enter', label: 'Enter' }, { value: 'cmdEnter', label: '⌘ Enter' }]} />
        </Row>
      </Section>
    </Page>
  )
}
