import type { Room } from '@shared/types'
import { landing } from '../../nav'
import { actions, getState } from '../../store'
import { Icon, IconButton } from '../../ui'
import { useScreenEscape } from '../../ui/hooks'
import { RoomIcon } from '../../components/RoomIcon'
import { SidebarToggleSlot } from '../../components/PanelToggles'

/** Back to where New chat was opened from, or New chat in the first room when there is nowhere to go. The draft stays in the room's box. */
const leave = () => { if (!actions.ui.back()) actions.ui.go(landing(getState())) }

/**
 * New chat's header, the first row a chat has: the breadcrumb "room › New chat" and nothing on the right. No editor button, panel
 * toggle or PR capsule, since there is no workspace yet (KERNEL-788).
 */
export function NewChatHeader({ room }: { room?: Room }) {
  return (
    <header className="header">
      <SidebarToggleSlot />
      {room && !room.archived && <>
        <RoomIcon room={room} className="crumb-avatar" />
        <span className="crumb">{room.name}</span>
        <span className="muted"><Icon name="right" size={12} /></span>
      </>}
      <h1 className="ellipsis">New chat</h1>
      <span className="grow" />
    </header>
  )
}

/**
 * The tab row's one tab, "New chat", with the chat icon and a × that stays in view. No rename pencil, no new tab button. The × and Esc
 * go back (KERNEL-788). Esc is the screen's own, so an open menu and a field being edited take it first, and a toast waits.
 */
export function NewChatTab() {
  useScreenEscape((_e, inField) => {
    if (inField) return false
    leave()
    return true
  })
  return (
    <div className="ws-tabs">
      <div role="tablist" aria-label="Chats and files" className="row" style={{ gap: 2, alignItems: 'flex-end', minWidth: 0 }}>
        <span className="tab-group" data-on data-rest>
          <button type="button" role="tab" aria-selected id="ws-tab-new-chat" className="ws-tab">
            <span className="tab-glyph" aria-hidden="true"><Icon name="chat" size={14} /></span>
            <span className="ellipsis">New chat</span>
          </button>
          <span className="tab-end">
            <IconButton className="tab-caret more" icon="close" size={12} label="Close New chat" onClick={leave} />
          </span>
        </span>
      </div>
    </div>
  )
}
