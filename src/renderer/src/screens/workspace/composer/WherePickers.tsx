import { useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { ProjectIcon } from '../../../components/ProjectIcon'
import { Button, Icon } from '../../../ui'
import { PopSearch, WherePop } from './WherePop'

/**
 * The project New chat starts in, opened from the title: the project's name, underlined, in "What's next for Kernel?", or a Pick a project button
 * when the page has no project. It opens below the title, never over it. Search, the projects with a check on the current one, then New project. There is no "No project" row.
 */
export function ProjectPicker({ variant, projects, project, open, disabled, onToggle, onClose, onPick, onNewProject }: {
  variant: 'title' | 'button'; projects: Project[]; project: Project | undefined; open: boolean; disabled?: boolean
  onToggle: () => void; onClose: () => void; onPick: (id: string) => void; onNewProject: () => void
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [text, setText] = useState('')
  const close = (refocus?: boolean) => { setText(''); onClose(); if (refocus) anchor.current?.querySelector('button')?.focus() }
  const needle = text.trim().toLowerCase()
  const shown = projects.filter((r) => !needle || r.name.toLowerCase().includes(needle))
  const pick = (id: string) => { onPick(id); close(true) }
  return (
    <span ref={anchor} className={variant === 'title' ? 'lead-project-anchor' : 'cmp-branch-anchor'}>
      {variant === 'title'
        ? <button type="button" className="lead-project" disabled={disabled} aria-label={`Project: ${project?.name ?? 'none'}, change project`} aria-haspopup="menu" aria-expanded={open} data-tip={(project?.name.length ?? 0) > 24 ? project?.name : undefined} onClick={onToggle}><span className="ellipsis">{project?.name}</span></button>
        : <Button disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>Pick a project<Icon name="chevron" size={12} /></Button>}
      {open && (
        <WherePop anchorRef={anchor} label="Project" width={248} drop="down" onClose={close} focusFirst={false}
          onKey={(e) => { if (e.key === 'Enter' && e.target instanceof HTMLInputElement && shown[0]) { e.preventDefault(); pick(shown[0].id) } }}>
          <PopSearch label="Search projects…" value={text} onChange={setText} />
          <div className="where-list" role="group" aria-label="Projects">
            {shown.map((r) => (
              <button key={r.id} type="button" role="menuitemradio" aria-checked={r.id === project?.id} className="menu-item where-row" onClick={() => pick(r.id)}>
                <ProjectIcon project={r} size={16} /><span className="grow ellipsis">{r.name}</span>{r.id === project?.id && <Icon name="check" size={14} />}
              </button>
            ))}
            {!shown.length && <p className="where-note">No project matches</p>}
          </div>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item where-row" onClick={() => { close(); onNewProject() }}>
            <Icon name="plus" size={16} /><span className="grow">New project</span>
          </button>
        </WherePop>
      )}
    </span>
  )
}
