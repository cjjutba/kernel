import type { RoomSettings } from '@shared/types'
import { SegmentedControl } from '../../../ui'
import { isOverride, NoRoom, Row, RoomPage, Section, sourceLine, TextField, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

type Key = 'setup' | 'run' | 'archive' | 'runMode'

/** Settings > a room > Scripts (SettingsRoomScripts.png). Saved in the room's settings.local.toml, so a script stays on this Mac until it is moved to settings.toml. */
export function RoomScripts({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  if (!room || !roomId) return <NoRoom />
  const save = (key: Key) => (text: string) => void patchRoomSettings(roomId, { scripts: { [key]: text.trim() || null } })
  const field = (key: 'setup' | 'run' | 'archive') => ({ source: sourceLine(rs, `scripts.${key}`), onReset: isOverride(rs, `scripts.${key}`) ? () => void patchRoomSettings(roomId, { scripts: { [key]: null } }) : undefined })
  return (
    <RoomPage room={room} rs={rs} title="Scripts" intro={`Scripts for ${room.name}. A change here is saved in settings.local.toml, so it stays on your Mac.`}>
      <Section title="Workspace scripts">
        <Row label="Setup" {...field('setup')} desc="Runs when a workspace is created" full={<TextField label="Setup script" value={rs?.scripts.setup ?? ''} onSave={save('setup')} placeholder="pnpm install" />} />
        <Row label="Run" {...field('run')} desc="Each workspace gets its own port" full={<TextField label="Run script" value={rs?.scripts.run ?? ''} onSave={save('run')} placeholder="pnpm dev --port $KERNEL_PORT" />} />
        <Row label="Archive" {...field('archive')} desc="Runs before a workspace is archived" full={<TextField label="Archive script" value={rs?.scripts.archive ?? ''} onSave={save('archive')} placeholder="docker compose down" />} />
        <Row label="Run mode" source={sourceLine(rs, 'scripts.runMode')} onReset={isOverride(rs, 'scripts.runMode') ? () => void patchRoomSettings(roomId, { scripts: { runMode: null } }) : undefined}>
          <SegmentedControl label="Run mode" value={rs?.scripts.runMode ?? 'concurrent'} onChange={(v) => void patchRoomSettings(roomId, { scripts: { runMode: v as NonNullable<RoomSettings['scripts']['runMode']> } })} options={[{ value: 'concurrent', label: 'Concurrent' }, { value: 'single', label: 'One at a time' }]} />
        </Row>
      </Section>
    </RoomPage>
  )
}
