import { useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { actions, useStore } from '../../store'
import { openProject } from '../../lead'
import { AgentAvatar, Button, EmptyState, Icon, Pill, Spinner, Toggle, useBusy, useListKeys } from '../../ui'
import { call, cleanError } from '../../api'
import { oneOf, useRemembered } from '../../remember'
import { openNewProject } from './draft'
import { ago, projectState, sourceOf, stateLabel, teamOf } from './projectInfo'
import './projects.css'
import { ProjectIcon } from '../../components/ProjectIcon'
import { SidebarToggleSlot } from '../../components/PanelToggles'
import { useKeptScroll } from '../../ui/keptScroll'

type Tab = 'all' | 'active' | 'archived'

function ProjectRow({ project, nav }: { project: Project; nav: ReturnType<typeof useListKeys>['rowProps'] }) {
  const agents = teamOf(useStore((s) => s.agents[project.id]))
  const status = useStore((s) => s.status[project.id])
  const approvals = useStore((s) => s.approvals)
  const lastActive = useStore((s) => s.activity.find((e) => e.projectId === project.id)?.ts)
  const state = projectState(project, approvals, status)
  const open = () => void openProject(project.id)
  const update = (patch: Partial<Project>, failed: string) => call('projects.update', { projectId: project.id, patch }).then((r) => actions.projects.upsert(r), (e) => actions.ui.toast({ title: failed, sub: cleanError(e) }))
  const [restoring, run] = useBusy()
  const restore = () => run('restore', () => update({ archived: false }, 'Could not restore the project'))
  return (
    <div className="rm-row" data-keep-id={project.id} data-state={state} onClick={open}>
      <span className="rm-name">
        <ProjectIcon project={project} className="rm-letter" />
        <span className="col rm-text">
          <button type="button" {...nav(project.id)} className="rm-link" onClick={(e) => { e.stopPropagation(); open() }}>{project.name}</button>
          <span className="rm-desc ellipsis">{project.desc}</span>
        </span>
      </span>
      <span className="rm-source">
        <Icon name={project.kind === 'folder' || (!project.repo && project.kind !== 'scratch') ? 'folder' : project.kind === 'scratch' ? 'burst' : 'branch'} size={14} />
        <span className="mono ellipsis">{sourceOf(project)}</span>
      </span>
      <span className="row rm-agents">
        <span className="rm-team" aria-hidden="true">{agents.slice(0, 5).map((a) => <AgentAvatar key={a.id} name={a.builtIn === 'lead' ? 'Kernel' : a.name} size={20} />)}</span>
        <span className="rm-count">{agents.length} {agents.length === 1 ? 'agent' : 'agents'}</span>
      </span>
      <span>
        <span className="rm-status" data-state={state}>
          {state === 'you' && <Icon name="warning" size={12} />}
          {state === 'working' && <Spinner label={null} pattern="wave" />}
          {stateLabel[state]}
        </span>
      </span>
      <span className="rm-updated">{ago(lastActive ?? project.createdAt)}</span>
      {/* An archived project comes back with Restore. Every other one is shown in the sidebar or hidden from it. */}
      <span className="rm-side" onClick={(e) => e.stopPropagation()}>
        {project.archived
          ? <Button size="sm" busy={!!restoring} busyLabel="Restoring" aria-label={`Restore ${project.name}`} onClick={() => void restore()}>Restore</Button>
          : <Toggle checked={!project.hidden} label={`Show ${project.name} in the sidebar`} onChange={(on) => void update({ hidden: !on }, on ? 'Could not show the project' : 'Could not hide the project')} />}
      </span>
    </div>
  )
}

/** Projects.png: every project with its source, team and live status, and the switch that shows it in the sidebar or hides it. */
export function Projects() {
  const projects = useStore((s) => s.projects)
  // Rooms were renamed projects (KERNEL-880). The saved key keeps its old name, so the tab picked before the update stays.
  const [tab, setTab] = useRemembered<Tab>('kernel.roomsTab', oneOf<Tab>(['all', 'active', 'archived'], 'all'))
  const [query, setQuery] = useState('')
  const active = projects.filter((r) => !r.archived)
  const q = query.trim().toLowerCase()
  const inTab = tab === 'all' ? projects : tab === 'active' ? active : projects.filter((r) => r.archived)
  const shown = q ? inTab.filter((r) => [r.name, r.desc ?? '', sourceOf(r)].some((t) => t.toLowerCase().includes(q))) : inTab
  const tabs: [Tab, string, number][] = [['all', 'All projects', projects.length], ['active', 'Active', active.length], ['archived', 'Archived', projects.length - active.length]]
  const keys = useListKeys({ ids: shown.map((r) => r.id), rowId: (id) => `rm-${id}`, onOpen: (id) => void openProject(id) })
  const table = useRef<HTMLDivElement>(null)
  useKeptScroll(table, { key: 'projects', ready: shown.length > 0 })
  return (
    <div className="panel">
      <header className="header pj-header">
        <SidebarToggleSlot />
        <h1>All projects</h1>
        <span className="grow" />
        <Button variant="primary" icon="plus" onClick={() => openNewProject()}>New project</Button>
      </header>
      <div className="rm-tabs" role="group" aria-label="Filter projects">
        {tabs.map(([id, label, n]) => <Pill key={id} pressed={tab === id} onClick={() => setTab(id)}>{label}<span className="rm-n">{n}</span></Pill>)}
        <span className="grow" />
        {projects.length > 0 && (
          <label className="rm-filter">
            <Icon name="search" size={14} />
            <input type="search" aria-label="Filter projects" placeholder="Filter projects" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
      </div>
      {projects.length === 0 ? (
        <div className="rm-empty">
          <EmptyState icon="folder" title="No projects yet" action={<Button variant="primary" onClick={() => openNewProject()}>New project</Button>}>
            Add a repo or a folder, and Kernel's team can start working in it.
          </EmptyState>
        </div>
      ) : (
        <div className="rm-table" ref={table} onKeyDown={keys.onKeyDown}>
          <div className="rm-head"><span>Name</span><span>Source</span><span>Agents</span><span>Status</span><span style={{ textAlign: 'right' }}>Updated</span><span style={{ textAlign: 'right' }}>In sidebar</span></div>
          {shown.map((r) => <ProjectRow key={r.id} project={r} nav={keys.rowProps} />)}
          {!shown.length && <p className="muted rm-none">{q ? 'No projects match that filter.' : tab === 'archived' ? 'No archived projects.' : 'No active projects.'}</p>}
        </div>
      )}
    </div>
  )
}
