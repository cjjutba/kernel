import type { AppSettings } from '@shared/types'
import { SegmentedControl, Select, Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

/** Settings > General (Settings.png). */
export function General({ s }: { s: AppSettings }) {
  const g = s.general
  return (
    <Page title="General">
      <Section title="General">
        <Row label="Default home view" desc="What opens when you launch Kernel">
          <Select label="Default home view" value={g.homeView} onChange={(e) => void patchSettings({ general: { homeView: e.target.value as AppSettings['general']['homeView'] } })} options={[{ value: 'home', label: 'Home' }, { value: 'inbox', label: 'Inbox' }, { value: 'lastRoom', label: 'Last room' }]} />
        </Row>
        <Row label="Open at login"><Toggle label="Open at login" checked={g.openAtLogin} onChange={(v) => void patchSettings({ general: { openAtLogin: v } })} /></Row>
        <Row label="Show in menu bar" desc="Approve requests and brief the Lead without opening the window"><Toggle label="Show in menu bar" checked={g.menuBar} onChange={(v) => void patchSettings({ general: { menuBar: v } })} /></Row>
        <Row label="Send messages with">
          <Select label="Send messages with" value={g.sendWith} onChange={(e) => void patchSettings({ general: { sendWith: e.target.value as AppSettings['general']['sendWith'] } })} options={[{ value: 'enter', label: 'Enter' }, { value: 'cmdEnter', label: '⌘ Enter' }]} />
        </Row>
      </Section>
      <Section title="Floor">
        <Row label="Floor style">
          <SegmentedControl label="Floor style" value={s.floor.style} onChange={(v) => void patchSettings({ floor: { style: v as AppSettings['floor']['style'] } })} options={[{ value: 'isometric', label: 'Isometric' }, { value: 'plan', label: 'Plan' }, { value: 'list', label: 'List' }]} />
        </Row>
        <Row label="Show name tags"><Toggle label="Show name tags" checked={s.floor.nameTags} onChange={(v) => void patchSettings({ floor: { nameTags: v } })} /></Row>
        <Row label="Animate agents" desc="Typing, raised hands, walking to the planning room"><Toggle label="Animate agents" checked={s.floor.animate} onChange={(v) => void patchSettings({ floor: { animate: v } })} /></Row>
      </Section>
    </Page>
  )
}
