import type { AppSettings } from '@shared/types'
import { Select, Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

/** How long a setup or archive script may run, in minutes. Main takes 1 to 240 (KERNEL-216). */
const TIMEOUTS = [5, 15, 30, 60]
const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`

/** Settings > Scripts (SettingsScripts.png). The Automation switches apply to every room. Each room keeps its own scripts on its Scripts page. */
export function Scripts({ s }: { s: AppSettings }) {
  const a = s.scripts
  return (
    <Page title="Scripts" intro="Each room keeps its own scripts on its Scripts page. These switches apply to every room.">
      <Section title="Automation">
        <Row label="Run setup when a workspace is created" desc="New workspaces are ready before the first message" full={<p className="set-hint">Setup can write NAME=value lines to <code>$KERNEL_ENV</code>. Agents, run scripts and terminals in the workspace get them.</p>}><Toggle label="Run setup when a workspace is created" checked={a.setupOnCreate} onChange={(v) => void patchSettings({ scripts: { setupOnCreate: v } })} /></Row>
        <Row label="Start the run script after setup" desc="Each workspace gets its own port"><Toggle label="Start the run script after setup" checked={a.runAfterSetup} onChange={(v) => void patchSettings({ scripts: { runAfterSetup: v } })} /></Row>
        <Row label="Run archive script on archive"><Toggle label="Run archive script on archive" checked={a.archiveOnArchive} onChange={(v) => void patchSettings({ scripts: { archiveOnArchive: v } })} /></Row>
        <Row label="Stop setup and archive scripts after" desc="A script still running then is stopped. Run scripts have no limit.">
          <Select label="Stop setup and archive scripts after" value={String(a.timeoutMinutes)} options={[...new Set([...TIMEOUTS, a.timeoutMinutes])].sort((x, y) => x - y).map((n) => ({ value: String(n), label: minutes(n) }))} onChange={(e) => void patchSettings({ scripts: { timeoutMinutes: Number(e.target.value) } })} />
        </Row>
      </Section>
    </Page>
  )
}
