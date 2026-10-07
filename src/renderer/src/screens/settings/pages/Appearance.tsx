import type { AppSettings } from '@shared/types'
import { SegmentedControl, Select, Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

/** Settings > Appearance (SettingsAppearance.png). The theme and the rest apply at once through appearance.ts. */
export function Appearance({ s }: { s: AppSettings }) {
  const a = s.appearance
  return (
    <Page title="Appearance">
      <Section title="Interface">
        <Row label="Theme">
          <SegmentedControl label="Theme" value={a.theme} onChange={(v) => void patchSettings({ appearance: { theme: v as AppSettings['appearance']['theme'] } })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
        </Row>
        <Row label="Font size">
          <Select label="Font size" value={a.fontSize} onChange={(e) => void patchSettings({ appearance: { fontSize: e.target.value as AppSettings['appearance']['fontSize'] } })} options={[{ value: 'default', label: 'Default' }, { value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }]} />
        </Row>
        <Row label="Density">
          <SegmentedControl label="Density" value={a.density} onChange={(v) => void patchSettings({ appearance: { density: v as AppSettings['appearance']['density'] } })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
        </Row>
        <Row label="Use pointer cursors"><Toggle label="Use pointer cursors" checked={a.pointerCursors} onChange={(v) => void patchSettings({ appearance: { pointerCursors: v } })} /></Row>
        <Row label="Reduce motion"><Toggle label="Reduce motion" checked={a.reduceMotion} onChange={(v) => void patchSettings({ appearance: { reduceMotion: v } })} /></Row>
      </Section>
    </Page>
  )
}
