import { isOverride, NoRoom, Row, RoomPage, Section, sourceLine, TextField, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'
import { PreviewUrls } from './PreviewUrls'
import { RunScripts } from './RunScripts'

type Key = 'setup' | 'archive'

/** Settings > a room > Scripts (SettingsRoomScripts.png). Saved in the room's settings.local.toml, so a script stays on this Mac until it is moved to settings.toml. */
export function RoomScripts({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  if (!room || !roomId) return <NoRoom />
  const save = (key: Key) => (text: string) => void patchRoomSettings(roomId, { scripts: { [key]: text.trim() || null } })
  const field = (key: Key) => ({ source: sourceLine(rs, `scripts.${key}`), onReset: isOverride(rs, `scripts.${key}`) ? () => void patchRoomSettings(roomId, { scripts: { [key]: null } }) : undefined })
  return (
    <RoomPage room={room} rs={rs} title="Scripts" intro={`Scripts for ${room.name}. A change here is saved in settings.local.toml, so it stays on your Mac.`}>
      <RunScripts roomId={roomId} rs={rs} />
      <PreviewUrls roomId={roomId} rs={rs} />
      <Section title="Workspace scripts">
        <Row label="Setup" {...field('setup')} desc="Runs when a workspace is created" full={<TextField label="Setup script" value={rs?.scripts.setup ?? ''} onSave={save('setup')} placeholder="pnpm install" />} />
        <Row label="Archive" {...field('archive')} desc="Runs before a workspace is archived" full={<TextField label="Archive script" value={rs?.scripts.archive ?? ''} onSave={save('archive')} placeholder="docker compose down" />} />
      </Section>
    </RoomPage>
  )
}
