import type { RefObject } from 'react'
import { actions, go } from '../../store'
import { Menu, MENU_SEPARATOR } from '../../ui'
import { openNewProject, resetDraft } from '../../screens/projects/draft'

/** The `...` on "Your projects" (SidebarProjectsMenu.png). */
export function ProjectsMenu({ anchorRef }: { anchorRef: RefObject<HTMLElement | null> }) {
  return (
    <Menu
      label="Your projects" anchorRef={anchorRef} onClose={actions.ui.closeMenu} style={{ left: -4, right: -4, top: 'calc(100% + 2px)' }}
      items={[
        { id: 'new', label: 'New project', icon: 'plus', onSelect: () => openNewProject() },
        { id: 'connect', label: 'Connect a repo', icon: 'branch', onSelect: () => { resetDraft({ source: 'repo' }); actions.ui.openModal({ name: 'connectRepo' }) } },
        { id: 'open', label: 'Open a folder', icon: 'folder', onSelect: () => { resetDraft({ source: 'folder', baseBranch: '' }); actions.ui.openModal({ name: 'openFolder' }) } },
        MENU_SEPARATOR,
        { id: 'manage', label: 'Manage projects', icon: 'projects', onSelect: () => go({ name: 'projects' }) }
      ]}
    />
  )
}
