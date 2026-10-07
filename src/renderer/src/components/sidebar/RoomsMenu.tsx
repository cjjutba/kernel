import type { RefObject } from 'react'
import { actions, go } from '../../store'
import { Menu, MENU_SEPARATOR } from '../../ui'
import { openNewRoom, resetDraft } from '../../screens/rooms/draft'

/** The `...` on "Your rooms" (SidebarRoomsMenu.png). */
export function RoomsMenu({ anchorRef }: { anchorRef: RefObject<HTMLElement | null> }) {
  return (
    <Menu
      label="Your rooms" anchorRef={anchorRef} onClose={actions.ui.closeMenu} style={{ left: -4, right: -4, top: 'calc(100% + 2px)' }}
      items={[
        { id: 'new', label: 'New room', icon: 'plus', onSelect: () => openNewRoom() },
        { id: 'connect', label: 'Connect a repo', icon: 'branch', onSelect: () => { resetDraft({ source: 'repo' }); actions.ui.openModal({ name: 'connectRepo' }) } },
        { id: 'open', label: 'Open a folder', icon: 'folder', onSelect: () => { resetDraft({ source: 'folder', baseBranch: '' }); actions.ui.openModal({ name: 'openFolder' }) } },
        MENU_SEPARATOR,
        { id: 'manage', label: 'Manage rooms', icon: 'rooms', onSelect: () => go({ name: 'rooms' }) }
      ]}
    />
  )
}
