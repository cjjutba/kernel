import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Project } from '@shared/types'
import { call, cleanError } from '../../api'
import { openNewChat } from '../../lead'
import { projectAgents } from '../../nav'
import { actions, go } from '../../store'
import { Menu, MENU_SEPARATOR } from '../../ui'

const GAP = 2
const EDGE = 8

/**
 * A project's `...` (SidebarProjectMenu.png). It renders in a portal at a fixed spot, because the projects list scrolls and would
 * clip it. It drops under the row, or opens above it when the window has no project below. The sidebar closes it when the
 * list scrolls, since it is placed once.
 */
export function ProjectMenu({ project, anchorRef }: { project: Project; anchorRef: RefObject<HTMLElement | null> }) {
  const box = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState(() => anchorRef.current?.getBoundingClientRect() ?? null)
  const [up, setUp] = useState(false)
  // A menu that mounts with its row (a fixture, or the sidebar coming back) runs before the row's ref is set, so it measures after.
  useEffect(() => { if (!at) setAt(anchorRef.current?.getBoundingClientRect() ?? null) }, [])
  useLayoutEffect(() => {
    if (at && box.current && at.bottom + GAP + box.current.offsetHeight > window.innerHeight - EDGE) setUp(true)
  }, [at])
  const hide = async () => {
    const hidden = await call('projects.update', { projectId: project.id, patch: { hidden: true } })
    actions.projects.upsert(hidden)
  }
  // A paused project offers Resume in place of Pause.
  const togglePause = () => call('projects.setPaused', { projectId: project.id, paused: !project.paused })
    .then(actions.projects.upsert)
    .catch((e: Error) => actions.ui.toast({ title: project.paused ? 'Could not resume the project' : 'Could not pause the project', sub: cleanError(e) }))
  if (!at) return null
  return createPortal(
    <div ref={box} className="project-menu" style={{ left: at.left - 4, width: at.width + 8, ...(up ? { bottom: window.innerHeight - at.top + GAP } : { top: at.bottom + GAP }) }}>
      <Menu
        label={`${project.name} options`} anchorRef={anchorRef} onClose={actions.ui.closeMenu}
        items={[
          { id: 'ws', label: 'New chat', icon: 'plus', onSelect: () => openNewChat(project.id) },
          { id: 'from', label: 'New chat from...', icon: 'link', onSelect: () => openNewChat(project.id) },
          { id: 'agents', label: 'Agents', icon: 'team', onSelect: () => go(projectAgents(project.id)) },
          { id: 'archived', label: 'Archived', icon: 'history', onSelect: () => go({ name: 'history', projectId: project.id }) },
          { id: 'pause', label: project.paused ? 'Resume project' : 'Pause project', icon: project.paused ? 'play' : 'pause', onSelect: () => void togglePause() },
          { id: 'settings', label: 'Project settings', icon: 'sliders', onSelect: () => go({ name: 'settings', page: 'project', projectId: project.id }) },
          { id: 'hide', label: 'Hide project', icon: 'eyeoff', onSelect: () => void hide() },
          MENU_SEPARATOR,
          { id: 'remove', label: 'Remove project', icon: 'trash', danger: true, onSelect: () => actions.ui.openModal({ name: 'confirm', kind: 'removeProject', projectId: project.id }) }
        ]}
      />
    </div>,
    document.body
  )
}
