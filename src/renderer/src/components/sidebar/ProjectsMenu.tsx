import type { RefObject } from 'react'
import { actions, go } from '../../store'
import { Menu, MENU_SEPARATOR, type MenuEntry } from '../../ui'
import { ServiceMark } from '../../icons'
import { openNewProject, resetDraft } from '../../screens/projects/draft'
import { isRemote } from '../../remote/isRemote'
import { useProjectSort, useShowHidden } from './projectOrder'

/** The menu under the + on "My projects" (SidebarProjectsMenu.png): add a project, then how the list is ordered and whether hidden projects show. */
export function ProjectsMenu({ anchorRef }: { anchorRef: RefObject<HTMLElement | null> }) {
  const [sort, setSort] = useProjectSort()
  const [hidden, setHidden] = useShowHidden()
  // Adding a project picks a folder or clones to this Mac's disk, which a paired browser can't.
  const adding: (MenuEntry | typeof MENU_SEPARATOR)[] = isRemote() ? [] : [
        { id: 'connect', label: 'Connect a GitHub repo', leading: <ServiceMark name="github" size={14} />, onSelect: () => { resetDraft({ source: 'repo' }); actions.ui.openModal({ name: 'connectRepo' }) } },
        { id: 'open', label: 'Open a folder', icon: 'folder', onSelect: () => { resetDraft({ source: 'folder', baseBranch: '' }); actions.ui.openModal({ name: 'openFolder' }) } },
        { id: 'new', label: 'Start from scratch', icon: 'burst', onSelect: () => openNewProject() },
    MENU_SEPARATOR
  ]
  return (
    <Menu
      label="My projects" anchorRef={anchorRef} onClose={actions.ui.closeMenu} style={{ left: -4, right: -4, top: 'calc(100% + 2px)' }}
      items={[
        ...adding,
        { id: 'name', label: 'Sort by name', icon: 'swap', checked: sort === 'name', onSelect: () => setSort('name') },
        { id: 'recent', label: 'Sort by recent', icon: 'clock', checked: sort === 'recent', onSelect: () => setSort('recent') },
        { id: 'hidden', label: 'Show hidden projects', icon: 'eye', checked: hidden, onSelect: () => setHidden(!hidden) },
        MENU_SEPARATOR,
        { id: 'manage', label: 'Manage projects', icon: 'projects', onSelect: () => go({ name: 'projects' }) }
      ]}
    />
  )
}
