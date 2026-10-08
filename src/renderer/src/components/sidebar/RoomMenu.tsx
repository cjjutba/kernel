import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Room } from '@shared/types'
import { call } from '../../api'
import { actions, go } from '../../store'
import { Menu, MENU_SEPARATOR } from '../../ui'

const GAP = 2
const EDGE = 8

/**
 * A room's `...` (SidebarRoomMenu.png). It renders in a portal at a fixed spot, because the rooms list scrolls and would
 * clip it. It drops under the row, or opens above it when the window has no room below. The sidebar closes it when the
 * list scrolls, since it is placed once.
 */
export function RoomMenu({ room, anchorRef }: { room: Room; anchorRef: RefObject<HTMLElement | null> }) {
  const box = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState(() => anchorRef.current?.getBoundingClientRect() ?? null)
  const [up, setUp] = useState(false)
  // A menu that mounts with its row (a fixture, or the sidebar coming back) runs before the row's ref is set, so it measures after.
  useEffect(() => { if (!at) setAt(anchorRef.current?.getBoundingClientRect() ?? null) }, [])
  useLayoutEffect(() => {
    if (at && box.current && at.bottom + GAP + box.current.offsetHeight > window.innerHeight - EDGE) setUp(true)
  }, [at])
  const hide = async () => {
    const hidden = await call('rooms.update', { roomId: room.id, patch: { hidden: true } })
    actions.rooms.upsert(hidden)
    actions.ui.toast({ title: `${room.name} is hidden`, sub: 'It stays on All rooms.' })
  }
  if (!at) return null
  return createPortal(
    <div ref={box} className="room-menu" style={{ left: at.left - 4, width: at.width + 8, ...(up ? { bottom: window.innerHeight - at.top + GAP } : { top: at.bottom + GAP }) }}>
      <Menu
        label={`${room.name} options`} anchorRef={anchorRef} onClose={actions.ui.closeMenu}
        items={[
          { id: 'ws', label: 'New workspace', icon: 'plus', onSelect: () => actions.ui.openModal({ name: 'newWorkspace', roomId: room.id }) },
          { id: 'from', label: 'New workspace from...', icon: 'link', onSelect: () => actions.ui.openModal({ name: 'newWorkspace', roomId: room.id }) },
          { id: 'settings', label: 'Room settings', icon: 'sliders', onSelect: () => go({ name: 'settings', page: 'git', roomId: room.id }) },
          { id: 'hide', label: 'Hide room', icon: 'eyeoff', onSelect: () => void hide() },
          MENU_SEPARATOR,
          { id: 'remove', label: 'Remove room', icon: 'trash', danger: true, onSelect: () => actions.ui.openModal({ name: 'confirm', kind: 'removeRoom', roomId: room.id }) }
        ]}
      />
    </div>,
    document.body
  )
}
