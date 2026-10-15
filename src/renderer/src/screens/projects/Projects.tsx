import type { Project } from '@shared/types'
import { actions, useStore } from '../../store'
import { openProject } from '../../lead'
import { KernelMark } from '../../icons'
import { Button, Icon, Pill, useListKeys } from '../../ui'
import { call } from '../../api'
import { oneOf, useRemembered } from '../../remember'
import { openNewProject } from './draft'
import { ago, initial, projectState, sourceOf, stateLabel, teamOf } from './projectInfo'
import './projects.css'
import { ProjectIcon } from '../../components/ProjectIcon'
import { SidebarToggleSlot } from '../../components/PanelToggles'

type Tab = 'all' | 'active' | 'archived'

function ProjectRow({ project, nav }: { project: Project; nav: ReturnType<typeof useListKeys>['rowProps'] }) {
  const agents = teamOf(useStore((s) => s.agents[project.id]))
  const status = useStore((s) => s.status[project.id])
  const approvals = useStore((s) => s.approvals)
  const workspaces = useStore((s) => s.workspaces)
  const lastActive = useStore((s) => s.activity.find((e) => e.projectId === project.id)?.ts)
  const state = projectState(project, approvals, status, workspaces)
  const open = () => void openProject(project.id)
  const show = () => void call('projects.update', { projectId: project.id, patch: { hidden: false } }).then((r) => actions.projects.upsert(r))
  return (
    <div className="rm-row" onClick={open}>
      <span className="rm-name">
        <ProjectIcon project={project} className="rm-letter" />
        <span className="col" style={{ minWidth: 0 }}>
          <button type="button" {...nav(project.id)} className="rm-link" onClick={(e) => { e.stopPropagation(); open() }}>{project.name}</button>
          <span className="rm-desc ellipsis">{project.desc}</span>
        </span>
        {project.hidden && <button type="button" className="rm-show" aria-label={`Show ${project.name} in the sidebar`} onClick={(e) => { e.stopPropagation(); show() }}>Show in sidebar</button>}
      </span>
      <span className="rm-source">
        <Icon name={project.kind === 'folder' || (!project.repo && project.kind !== 'scratch') ? 'folder' : project.kind === 'scratch' ? 'burst' : 'branch'} size={16} />
        <span className="mono ellipsis">{sourceOf(project)}</span>
      </span>
      <span className="row" style={{ gap: 8 }}>
        <span className="rm-team" aria-hidden="true">{agents.slice(0, 5).map((a) => <span key={a.id}>{a.builtIn === 'lead' ? <KernelMark size={12} /> : initial(a)}</span>)}</span>
        <span className="rm-count">{agents.length} {agents.length === 1 ? 'agent' : 'agents'}</span>
      </span>
      <span>
        <span className="rm-status" data-state={state}>{stateLabel[state]}</span>
      </span>
      <span className="rm-updated">{ago(lastActive ?? project.createdAt)}</span>
    </div>
  )
}

/** Projects.png: every project with its source, team and live status. */
export function Projects() {
  const projects = useStore((s) => s.projects)
  // Rooms were renamed projects (KERNEL-880). The saved key keeps its old name, so the tab picked before the update stays.
  const [tab, setTab] = useRemembered<Tab>('kernel.roomsTab', oneOf<Tab>(['all', 'active', 'archived'], 'all'))
  const active = projects.filter((r) => !r.archived)
  const shown = tab === 'all' ? projects : tab === 'active' ? active : projects.filter((r) => r.archived)
  const tabs: [Tab, string, number][] = [['all', 'All projects', projects.length], ['active', 'Active', active.length], ['archived', 'Archived', projects.length - active.length]]
  const keys = useListKeys({ ids: shown.map((r) => r.id), rowId: (id) => `rm-${id}`, onOpen: (id) => void openProject(id) })
  return (
    <div className="panel">
      <header className="header" style={{ paddingRight: 12 }}>
        <SidebarToggleSlot />
        <Icon name="projects" />
        <h1>All projects</h1>
        <span className="grow" />
        <Button variant="primary" icon="plus" onClick={() => openNewProject()}>New project</Button>
      </header>
      <div className="rm-tabs" role="group" aria-label="Filter projects">
        {tabs.map(([id, label, n]) => <Pill key={id} pressed={tab === id} onClick={() => setTab(id)}>{label}<span className="rm-n">{n}</span></Pill>)}
      </div>
      <div className="rm-table" onKeyDown={keys.onKeyDown}>
        <div className="rm-head"><span>Name</span><span>Source</span><span>Agents</span><span>Status</span><span style={{ textAlign: 'right' }}>Updated</span></div>
        {shown.map((r) => <ProjectRow key={r.id} project={r} nav={keys.rowProps} />)}
        {!shown.length && <p className="muted" style={{ padding: 24, margin: 0 }}>{tab === 'archived' ? 'No archived projects.' : 'No projects yet. Make one with New project.'}</p>}
      </div>
    </div>
  )
}
