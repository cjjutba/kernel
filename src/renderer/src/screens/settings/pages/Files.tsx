import { Toggle } from '../../../ui'
import { isOverride, LinesField, NoRoom, Row, RoomPage, Section, sourceLine, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

/** Settings > a room > Files to copy (SettingsFiles.png). What a new worktree of this room gets from the checkout. */
export function Files({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  if (!room || !roomId) return <NoRoom />
  const reset = (key: 'copy' | 'symlinkNodeModules') => (isOverride(rs, `files.${key}`) ? () => void patchRoomSettings(roomId, { files: { [key]: null } }) : undefined)
  return (
    <RoomPage room={room} rs={rs} title="Files to copy" intro={`Gitignored files that ${room.name} copies into every new worktree.`}>
      <Section title="Gitignored files">
        <Row label="Copy into every new worktree" source={sourceLine(rs, 'files.copy')} onReset={reset('copy')} full={<LinesField label="Files to copy" value={rs?.files.copy ?? []} onSave={(copy) => void patchRoomSettings(roomId, { files: { copy } })} />} />
        <Row label="Symlink node_modules" source={sourceLine(rs, 'files.symlinkNodeModules')} desc="Faster setup, but workspaces share dependencies" onReset={reset('symlinkNodeModules')}>
          <Toggle label="Symlink node_modules" checked={!!rs?.files.symlinkNodeModules} onChange={(v) => void patchRoomSettings(roomId, { files: { symlinkNodeModules: v } })} />
        </Row>
      </Section>
    </RoomPage>
  )
}
