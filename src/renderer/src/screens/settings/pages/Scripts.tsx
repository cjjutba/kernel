import type { AppSettings } from '@shared/types'
import { SegmentedControl, Toggle } from '../../../ui'
import { NoRoom, Page, Row, Section, TextField } from '../kit'
import { patchRoomSettings, patchSettings, useProjectRoom, useRoomSettings } from '../useSettings'

/**
 * Settings > Scripts (SettingsScripts.png). The scripts are the repo's, in .kernel/settings.toml (committed to share),
 * so they follow the project room. The Automation toggles are the app's.
 */
export function Scripts({ s }: { s: AppSettings }) {
  const room = useProjectRoom()
  const rs = useRoomSettings(room?.id)
  if (!room) return <NoRoom />
  const save = (key: 'setup' | 'run' | 'archive') => (text: string) => void patchRoomSettings(room.id, { scripts: { [key]: text.trim() || null } }, true)
  const a = s.scripts
  return (
    <Page title="Scripts" intro="Stored in .kernel/settings.toml. Commit it to share, or keep overrides in settings.local.toml.">
      <Section title="Workspace scripts">
        <Row label="Setup" desc="Runs when a workspace is created" full={<TextField label="Setup script" value={rs?.scripts.setup ?? ''} onSave={save('setup')} placeholder="pnpm install" />} />
        <Row label="Run" desc="Each workspace gets its own port" full={<TextField label="Run script" value={rs?.scripts.run ?? ''} onSave={save('run')} placeholder="pnpm dev --port $KERNEL_PORT" />} />
        <Row label="Archive" desc="Runs before a workspace is archived" full={<TextField label="Archive script" value={rs?.scripts.archive ?? ''} onSave={save('archive')} placeholder="docker compose down" />} />
        <Row label="Run mode">
          <SegmentedControl label="Run mode" value={rs?.scripts.runMode ?? 'concurrent'} onChange={(v) => void patchRoomSettings(room.id, { scripts: { runMode: v as 'concurrent' | 'single' } }, true)} options={[{ value: 'concurrent', label: 'Concurrent' }, { value: 'single', label: 'One at a time' }]} />
        </Row>
      </Section>
      <Section title="Automation">
        <Row label="Run setup when a workspace is created" desc="New workspaces are ready before the first message"><Toggle label="Run setup when a workspace is created" checked={a.setupOnCreate} onChange={(v) => void patchSettings({ scripts: { setupOnCreate: v } })} /></Row>
        <Row label="Start the run script after setup" desc="Each workspace gets its own port"><Toggle label="Start the run script after setup" checked={a.runAfterSetup} onChange={(v) => void patchSettings({ scripts: { runAfterSetup: v } })} /></Row>
        <Row label="Run archive script on archive"><Toggle label="Run archive script on archive" checked={a.archiveOnArchive} onChange={(v) => void patchSettings({ scripts: { archiveOnArchive: v } })} /></Row>
      </Section>
    </Page>
  )
}
