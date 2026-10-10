import type { AppSettings } from '@shared/types'
import { Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

/** Settings > Experimental (SettingsExperimental.png). */
export function Experimental({ s }: { s: AppSettings }) {
  const e = s.experimental
  const set = (patch: Partial<AppSettings['experimental']>) => void patchSettings({ experimental: patch })
  return (
    <Page title="Experimental" intro="Early features. They may change or go away.">
      <Section title="Voice">
        <Row label="Voice briefs" desc="Hold Fn and talk to Rowan"><Toggle label="Voice briefs" checked={e.voice} onChange={(v) => set({ voice: v })} /></Row>
      </Section>
    </Page>
  )
}
