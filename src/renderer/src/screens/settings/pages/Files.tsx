import { Toggle } from '../../../ui'
import { LinesField, NoRoom, Page, Row, Section } from '../kit'
import { patchRoomSettings, useProjectRoom, useRoomSettings } from '../useSettings'

/** Settings > Files to copy (SettingsFiles.png). Saved in the repo's .kernel/settings.toml, so it follows the project room. */
export function Files() {
  const room = useProjectRoom()
  const rs = useRoomSettings(room?.id)
  if (!room) return <NoRoom />
  return (
    <Page title="Files to copy">
      <Section title="Gitignored files">
        <Row label="Copy into every new worktree" full={<LinesField label="Files to copy" value={rs?.files.copy ?? []} onSave={(copy) => void patchRoomSettings(room.id, { files: { copy } }, true)} />} />
        <Row label="Symlink node_modules" desc="Faster setup, but workspaces share dependencies">
          <Toggle label="Symlink node_modules" checked={!!rs?.files.symlinkNodeModules} onChange={(v) => void patchRoomSettings(room.id, { files: { symlinkNodeModules: v } }, true)} />
        </Row>
      </Section>
    </Page>
  )
}
