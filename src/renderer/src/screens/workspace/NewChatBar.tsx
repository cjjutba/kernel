import type { ReactNode } from 'react'
import type { Project } from '@shared/types'
import { landing } from '../../nav'
import { actions, getState } from '../../store'
import { openProject } from '../../lead'
import { Icon } from '../../ui'
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
 * The one header row of a Lead chat: project avatar and name (a link to the project), a separator, then the tabs and the new tab button
 * (`children`), and what sits on the right (`end`). The chat's title is its tab, so it is said once.
 */
export function OneRowHeader({ project, children, end }: { project?: Project; children: ReactNode; end?: ReactNode }) {
  return (
    <header className="header" data-one-row>
      <SidebarToggleSlot />
      {project && !project.archived && <>
        <ProjectIcon project={project} className="crumb-avatar" />
        <button type="button" className="crumb" onClick={() => void openProject(project.id)}>{project.name}</button>
        <span className="muted"><Icon name="right" size={12} /></span>
      </>}
      {children}
      <span className="grow" />
      {end}
    </header>
  )
}

/**
 * New chat's header, the only row a chat has: the project, then its one tab, "New chat", with no close button while it is the only tab
 * and empty. No editor button, panel toggle or PR capsule, since there is no workspace yet (KERNEL-788).
 */
export function NewChatHeader({ project }: { project?: Project }) {
  return <OneRowHeader project={project}><NewChatTab /></OneRowHeader>
}

/**
 * The tab row's one tab, "New chat", with the chat icon and no close button, since closing the only, empty tab would only leave the page.
 * There is no new tab button, since the one tab is already a new chat. Esc goes back (KERNEL-788). Esc is the screen's own, so an open
 * menu and a field being edited take it first, and a toast waits.
 */
export function NewChatTab() {
  useScreenEscape((_e, inField) => {
    if (inField) return false
    return leave()
  })
  return (
    <div className="ws-tabs" data-inline>
      <div role="tablist" aria-label="Chats and files" className="row gap-2" style={{ alignItems: 'flex-end', minWidth: 0 }}>
        <span className="tab-group" data-on>
          <button type="button" role="tab" aria-selected id="ws-tab-new-chat" className="ws-tab">
            <span className="tab-glyph" aria-hidden="true"><Icon name="chat" size={14} /></span>
            <span className="ellipsis">New chat</span>
          </button>
        </span>
      </div>
    </div>
  )
}
