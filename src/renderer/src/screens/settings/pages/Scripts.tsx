import type { AppSettings } from '@shared/types'
import { Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

/** Settings > Scripts (SettingsScripts.png). The Automation switches apply to every room. Each room keeps its own scripts on its Scripts page. */
export function Scripts({ s }: { s: AppSettings }) {
  const a = s.scripts
  return (
    <Page title="Scripts" intro="Each room keeps its own scripts on its Scripts page. These switches apply to every room.">
      <Section title="Automation">
        <Row label="Run setup when a workspace is created" desc="New workspaces are ready before the first message"><Toggle label="Run setup when a workspace is created" checked={a.setupOnCreate} onChange={(v) => void patchSettings({ scripts: { setupOnCreate: v } })} /></Row>
        <Row label="Start the run script after setup" desc="Each workspace gets its own port"><Toggle label="Start the run script after setup" checked={a.runAfterSetup} onChange={(v) => void patchSettings({ scripts: { runAfterSetup: v } })} /></Row>
        <Row label="Run archive script on archive"><Toggle label="Run archive script on archive" checked={a.archiveOnArchive} onChange={(v) => void patchSettings({ scripts: { archiveOnArchive: v } })} /></Row>
      </Section>
    </Page>
  )
}
