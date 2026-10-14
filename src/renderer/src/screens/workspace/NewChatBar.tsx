import type { Room } from '@shared/types'
import { actions } from '../../store'
import { Icon, IconButton } from '../../ui'
import { useEscape } from '../../ui/hooks'
import { RoomIcon } from '../../components/RoomIcon'
import { SidebarToggle } from '../../components/PanelToggles'

/** Back to where New chat was opened from, or Home when there is nowhere to go. The draft stays in the room's box. */
const leave = () => { if (!actions.ui.back()) actions.ui.go({ name: 'home' }) }

/**
 * New chat's header, the first row a chat has: the breadcrumb "room › New chat" and nothing on the right. No editor button, panel
 * toggle or PR capsule, since there is no workspace yet (KERNEL-788).
 */
export function NewChatHeader({ room }: { room?: Room }) {
  return (
    <header className="header">
      <SidebarToggle />
      <RoomIcon room={room} className="crumb-avatar" />
      <span className="crumb">{room?.name}</span>
      <span className="muted"><Icon name="right" size={12} /></span>
      <h1 className="ellipsis">New chat</h1>
      <span className="grow" />
    </header>
  )
}

/**
 * The tab row's one tab, "New chat", with the chat icon and a × that stays in view. No rename pencil, no new tab button. The × and Esc
 * go back (KERNEL-788). Esc is a layer, so an open menu takes it first.
 */
export function NewChatTab() {
  useEscape(leave)
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
