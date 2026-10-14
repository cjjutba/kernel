import { PERMISSION_MODES, type PermissionMode } from '@shared/types'
import { call, cleanError } from '../../../api'
import { MODE_INFO, pickMode, unavailable, useModeAvailability } from '../../../permissionModes'
import { actions, useStore } from '../../../store'
import { Select } from '../../../ui'
import { NoRoom, RoomPage, Row, Section, SettingsLink, TagList, useRoomPage } from '../kit'
import { useMenuOpen } from './roomMenu'

const USE_DEFAULT = ''

/**
 * Settings > a room > Permissions (MorePage roomPerms, KERNEL-680): the room's mode, with "Default (the app's mode)" first, and the commands and
 * tools approvals saved with Always allow in this room, as tags you can remove. Never allow and protected branches stay on the app's page.
 */
export function RoomPermissions({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const menu = useMenuOpen('roomMode')
  const appMode = useStore((s) => s.settings?.permissions.mode)
  const availability = useModeAvailability()
  if (!room || !roomId) return <NoRoom />
  const current = room.permissionMode
  const save = async (patch: { allow: string[] } | { allowTools: string[] }) => {
    try { actions.rooms.upsert(await call('rooms.update', { roomId, patch })); return true } catch (e) { actions.ui.toast({ title: 'Could not save the rule', sub: cleanError(e) }); return undefined }
  }
  const modes = PERMISSION_MODES.map((mode) => ({ value: mode, label: MODE_INFO[mode].label, disabled: unavailable(mode, availability).dim && mode !== current }))
  return (
    <RoomPage room={room} rs={rs} title="Permissions">
      <Section label="Mode" scope="mac">
        <Row label="Mode" labelId="rp-mode" desc="Chats in this room start in this mode." onReset={current ? () => void pickMode(undefined, roomId) : undefined}>
          <Select label="Mode" labelledBy="rp-mode" align="right" value={current ?? USE_DEFAULT} onChange={(v) => void pickMode(v ? (v as PermissionMode) : undefined, roomId)} options={[{ value: USE_DEFAULT, label: `Default (${appMode ? MODE_INFO[appMode].label : 'App mode'})` }, ...modes]} {...menu} />
        </Row>
      </Section>
      <Section title="Always allowed" scope="mac" footnote={<>Never allow and protected branches apply in every room, from <SettingsLink to={{ page: 'permissions' }}>Settings, Permissions</SettingsLink>.</>}>
        <Row label="Commands" desc="Saved when you choose Always allow in this room." full={<TagList label="Commands always allowed" value={room.allow ?? []} addLabel="Add command" onChange={(allow) => save({ allow })} />} />
        <Row label="Tools" desc="MCP tools and web fetches, saved the same way." full={<TagList label="Tools always allowed" value={room.allowTools ?? []} addLabel="Add tool" onChange={(allowTools) => save({ allowTools })} />} />
      </Section>
    </RoomPage>
  )
}
