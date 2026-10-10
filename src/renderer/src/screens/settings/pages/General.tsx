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
      <Section title="Team">
        <Row label="Default team for new rooms" desc="What an empty room starts with">
          <SegmentedControl label="Default team for new rooms" value={s.team.defaultTemplate} onChange={(v) => void patchSettings({ team: { defaultTemplate: v as AppSettings['team']['defaultTemplate'] } })} options={[{ value: 'starter', label: 'Starter team' }, { value: 'pair', label: 'Pair' }]} />
        </Row>
        <Row label="Show names instead of roles"><Toggle label="Show names instead of roles" checked={s.team.showNames} onChange={(v) => void patchSettings({ team: { showNames: v } })} /></Row>
      </Section>
    </Page>
  )
}
