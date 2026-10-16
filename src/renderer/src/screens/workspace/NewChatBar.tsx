import type { Project } from '@shared/types'
import { landing } from '../../nav'
import { actions, getState } from '../../store'
import { Icon, IconButton } from '../../ui'
import { useScreenEscape } from '../../ui/hooks'
import { ProjectIcon } from '../../components/ProjectIcon'
import { SidebarToggleSlot } from '../../components/PanelToggles'

/** Back to where New chat was opened from, or to the landing route when that is somewhere else. False when there is nowhere to go, so the key passes on. The draft stays in the project's box. */
const leave = (): boolean => {
  if (actions.ui.back()) return true
  const s = getState()
  const to = landing(s)
  if (JSON.stringify(to) === JSON.stringify(s.ui.route)) return false
  actions.ui.go(to)
  return true
}

/**
 * New chat's header, the first row a chat has: the breadcrumb "project › New chat" and nothing on the right. No editor button, panel
 * toggle or PR capsule, since there is no workspace yet (KERNEL-788).
 */
export function NewChatHeader({ project }: { project?: Project }) {
  return (
    <header className="header">
      <SidebarToggleSlot />
      {project && !project.archived && <>
        <ProjectIcon project={project} className="crumb-avatar" />
        <span className="crumb">{project.name}</span>
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
    return leave()
  })
  return (
    <div className="ws-tabs">
      <div role="tablist" aria-label="Chats and files" className="row gap-2" style={{ alignItems: 'flex-end', minWidth: 0 }}>
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
