import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { go } from '../../store'
import { Button, Icon, IconButton, Menu, isTyping } from '../../ui'
import { ProjectIcon } from '../../components/ProjectIcon'
import { SidebarToggleSlot } from '../../components/PanelToggles'
import type { IssueTracker, ProjectHead, TrackerSwitch } from '../issues/parts'
import { WORK_TABS, useWorkTab, type WorkTab } from './tab'
import { ALL_PROJECTS, projectLabel } from './scope'
import './work.css'

const TRACKERS: { id: IssueTracker; label: string }[] = [{ id: 'linear', label: 'Linear' }, { id: 'github', label: 'GitHub' }]

/**
 * Linear | GitHub (KERNEL-938): which tracker the Issues list reads. A side the project can't use stays in place, greyed and still
 * focusable, so its reason is there to read by hover and by screen reader. Arrow keys skip it.
 */
function TrackerToggle({ active, available, onChange }: TrackerSwitch) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const reason = (t: IssueTracker) => (t === 'linear' ? (available.linear ? undefined : 'Connect Linear in Settings, Integrations') : available.github ? undefined : 'No GitHub remote')
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + TRACKERS.length) % TRACKERS.length
    if (reason(TRACKERS[next].id)) return
    onChange(TRACKERS[next].id)
    refs.current[next]?.focus()
  }
  return (
    <div className="wk-tracker" role="radiogroup" aria-label="Issue tracker">
      {TRACKERS.map((t, i) => {
        const why = reason(t.id)
        return (
          <button key={t.id} ref={(el) => { refs.current[i] = el }} type="button" role="radio" aria-checked={t.id === active} aria-disabled={why ? true : undefined}
            aria-label={why ? `${t.label}, unavailable: ${why}` : t.label} data-tip={why} tabIndex={t.id === active ? 0 : -1}
            onClick={() => { if (!why && t.id !== active) onChange(t.id) }} onKeyDown={(e) => onKey(e, i)}>{t.label}</button>
        )
      })}
    </div>
  )
}

const labels: Record<WorkTab, string> = { issues: 'Issues', prs: 'Pull requests' }

export { ALL_PROJECTS }

interface Props {
  tab: WorkTab
  head: ProjectHead
  /** Pull requests only: adds "All projects" to the picker, which is selected while `head.project` is empty. */
  allProjects?: boolean
  /** How many each tab lists, when the page knows. Pull requests shows its count only above 0. */
  counts?: Partial<Record<WorkTab, string | number>>
  /** Where the list comes from and whose account: "Linear · cj-jutba", "GitHub · cj-jutba". */
  where?: ReactNode
  /** Reads the list again. The button is left out without it. */
  onRefresh?: () => void
  refreshing?: boolean
}

/** The other tab's route. The project is the shared pick (`useWorkProject`), which Pull requests reads itself, so only Issues needs it in the route. */
const routeFor = (tab: WorkTab, projectId?: string) => (tab === 'issues' ? { name: 'issues' as const, projectId } : { name: 'prs' as const })

/**
 * The header of the Work page (KERNEL-874): the title, the Issues and Pull requests tabs, the project picker and, on the right, where
 * the list comes from with Refresh. Keys 1 and 2 switch the tab while focus is not in a text field.
 */
export function WorkHeader({ tab, head, allProjects, counts, where, onRefresh, refreshing }: Props) {
  const [, remember] = useWorkTab()
  // The tab is the route's name. Saving it here is what makes the sidebar's Work open on it.
  useEffect(() => remember(tab), [tab])
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const { projects, project, onProject } = head
  const to = (next: WorkTab) => { if (next !== tab) go(routeFor(next, project?.id)) }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping(e.target)) return
      if (e.key === '1' || e.key === '2') { e.preventDefault(); to(WORK_TABS[Number(e.key) - 1]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + WORK_TABS.length) % WORK_TABS.length
    to(WORK_TABS[next])
    refs.current[next]?.focus()
  }

  const pick = project ?? (allProjects ? { name: 'All projects' } : undefined)
  return (
    <header className="header wk-head">
      <SidebarToggleSlot />
      <Icon name="issues" />
      <h1>Work</h1>
      <div className="wk-tabs" role="tablist" aria-label="Work">
        {WORK_TABS.map((t, i) => (
          <button key={t} ref={(el) => { refs.current[i] = el }} type="button" role="tab" aria-selected={t === tab} tabIndex={t === tab ? 0 : -1} data-tip-kbd={String(i + 1)} onClick={() => to(t)} onKeyDown={(e) => onTabKey(e, i)}>
            {labels[t]}{counts?.[t] !== undefined && !(t === 'prs' && !counts[t]) && <span className="wk-n">{counts[t]}</span>}
          </button>
        ))}
      </div>
      {pick && (
        <>
          <span className="wk-vr" aria-hidden="true" />
          <span ref={anchor} className="wk-project">
            <Button variant="ghost" className="wk-pick" aria-label={`Project: ${project ? projectLabel(project, projects) : pick.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
              {project ? <ProjectIcon project={project} className="wk-letter" fallback="?" /> : <span className="wk-letter" aria-hidden="true">A</span>}{project ? projectLabel(project, projects) : pick.name}<Icon name="chevron" size={12} />
            </Button>
            {open && (
              <Menu label="Project" anchorRef={anchor} onClose={() => setOpen(false)} style={{ left: 0, top: 'calc(100% + 4px)' }}
                items={[
                  ...(allProjects ? [{ id: 'all', label: 'All projects', checked: !project, onSelect: () => onProject(ALL_PROJECTS) }] : []),
                  ...projects.map((r) => ({ id: r.id, label: projectLabel(r, projects), checked: r.id === project?.id, onSelect: () => onProject(r.id) }))
                ]} />
            )}
          </span>
        </>
      )}
      <span className="grow" />
      {head.tracker && <TrackerToggle {...head.tracker} />}
      {where && <span className="wk-where">{where}</span>}
      {onRefresh && <IconButton icon="refresh" size={16} label="Refresh" busy={refreshing} busyPattern="rotate" busyLabel="Refreshing" onClick={onRefresh} />}
    </header>
  )
}
