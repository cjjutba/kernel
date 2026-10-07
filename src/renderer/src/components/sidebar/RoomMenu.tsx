import type { RefObject } from 'react'
import type { Room } from '@shared/types'
import { call } from '../../api'
import { actions, go } from '../../store'
import { Menu, MENU_SEPARATOR } from '../../ui'

/** A room's `...` (SidebarRoomMenu.png). */
export function RoomMenu({ room, anchorRef }: { room: Room; anchorRef: RefObject<HTMLElement | null> }) {
  const hide = async () => {
    const hidden = await call('rooms.update', { roomId: room.id, patch: { hidden: true } })
    actions.rooms.upsert(hidden)
    actions.ui.toast({ title: `${room.name} is hidden`, sub: 'It stays on All rooms.' })
  }
  return (
    <Menu
      label={`${room.name} options`} anchorRef={anchorRef} onClose={actions.ui.closeMenu} style={{ left: -4, right: -4, top: 'calc(100% + 2px)' }}
      items={[
        { id: 'ws', label: 'New workspace', icon: 'plus', onSelect: () => actions.ui.openModal({ name: 'newWorkspace', roomId: room.id }) },
        { id: 'from', label: 'New workspace from...', icon: 'link', onSelect: () => actions.ui.openModal({ name: 'newWorkspace', roomId: room.id }) },
        { id: 'settings', label: 'Room settings', icon: 'sliders', onSelect: () => go({ name: 'settings', page: 'git', roomId: room.id }) },
        { id: 'hide', label: 'Hide room', icon: 'eyeoff', onSelect: () => void hide() },
        MENU_SEPARATOR,
        { id: 'remove', label: 'Remove room', icon: 'trash', danger: true, onSelect: () => actions.ui.openModal({ name: 'confirm', kind: 'removeRoom', roomId: room.id }) }
      ]}
    />
  )
}
