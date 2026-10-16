import './settings.css'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppSettings, ProjectSettingsSection, SettingsPage } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Icon } from '../../ui'
import { spotKey } from '../../ui/keptScroll'
import { KeepContext } from './kit'
import { landWhenThere } from './landOnRow'
import { NAV_PAGES, PROJECT_PAGES } from './nav'
import { SettingsPending } from './SettingsLoad'
import { useProjectSettingsLoad, useSettings } from './useSettings'
import { About } from './pages/About'
import { AgentEdit } from './pages/AgentEdit'
import { Agents } from './pages/Agents'
import { Accounts } from './pages/Accounts'
import { Appearance } from './pages/Appearance'
import { BigTerminal } from './pages/BigTerminal'
import { Environment } from './pages/Environment'
import { General } from './pages/General'
import { McpServers } from './pages/McpServers'
import { Models } from './pages/Models'
import { Notifications } from './pages/Notifications'
import { Permissions } from './pages/Permissions'
import { Git } from './pages/Git'
import { Hooks } from './pages/Hooks'
import { Integrations } from './pages/Integrations'
import { PRs } from './pages/PRs'
import { Privacy } from './pages/Privacy'
import { Project } from './pages/Project'
import { ProjectGit } from './pages/ProjectGit'
import { ProjectPrs } from './pages/ProjectPrs'
import { ProjectSetup } from './pages/ProjectSetup'
import { Shortcuts } from './pages/Shortcuts'
import { Team } from './pages/Team'

export { SettingsNav } from './SettingsNav'

/** The page to the right of the Settings nav. A project's pages are `page: 'project'`, and `section` picks one. */
export function Settings({ page, projectId, section, agentId }: { page: SettingsPage; projectId?: string; section?: ProjectSettingsSection; agentId?: string }) {
  const settings = useSettings()
  const [failed, setFailed] = useState(false)
  const load = async () => {
    try {
      actions.settings.set(await call('settings.get', undefined))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }
  useEffect(() => { if (!settings) void load() }, [!!settings])
  let body: ReactNode
  if (page === 'shortcuts') body = <Shortcuts />
  else if (page === 'about') body = <About />
  else if (!settings) body = <SettingsPending title={page === 'project' ? 'Project settings' : NAV_PAGES.find((n) => n.page === page)?.label ?? 'Settings'} failed={failed} what="settings" onRetry={load} />
  else if (page === 'general') body = <General s={settings} />
  else if (page === 'appearance') body = <Appearance s={settings} />
  else if (page === 'notifications') body = <Notifications s={settings} />
  else if (page === 'models') body = <Models s={settings} />
  else if (page === 'agents') body = agentId ? <AgentEdit key={agentId} agentId={agentId} /> : <Agents />
  else if (page === 'accounts') body = <Accounts s={settings} />
  else if (page === 'mcp') body = <McpServers />
  else if (page === 'permissions') body = <Permissions s={settings} />
  else if (page === 'env') body = <Environment />
  else if (page === 'privacy') body = <Privacy s={settings} />
  else if (page === 'bigterm') body = <BigTerminal s={settings} />
  else if (page === 'git') body = <Git s={settings} />
  else if (page === 'prs') body = <PRs s={settings} />
  else if (page === 'hooks') body = <Hooks s={settings} />
  else if (page === 'integrations') body = <Integrations />
  else if (page === 'project') body = <ProjectGate projectId={projectId} section={section} agentId={agentId} s={settings} />
  // A search result or a link names a row: land on it once the page has drawn it. The route is a new object for every move, so picking the same result twice lands twice.
  const route = useStore((s) => s.ui.route)
  const panel = useRef<HTMLDivElement>(null)
  const row = route.name === 'settings' ? route.row : undefined
  useEffect(() => (row ? landWhenThere(row, panel.current) : undefined), [route, row, !!settings])
  const view = page === 'project' ? section ?? 'general' : page
  const keep = useMemo(
    () => ({ key: `${page === 'project' ? spotKey.settings('project', view, projectId) : spotKey.settings('app', view)}${agentId ? `:${agentId}` : ''}`, target: !!row || !!agentId }),
    [page, view, projectId, agentId, row]
  )
  return <div className="panel" ref={panel}><KeepContext.Provider value={keep}>{body}</KeepContext.Provider></div>
}

/** A project's page waits for the project's files, with its title in place, and says so when they don't come. */
function ProjectGate({ projectId, section = 'general', agentId, s }: { projectId?: string; section?: ProjectSettingsSection; agentId?: string; s: AppSettings }) {
  const project = useStore((st) => st.projects.find((r) => r.id === projectId))
  const { rs, failed, retry } = useProjectSettingsLoad(projectId)
  if (project && !rs) {
    const crumb = <>{project.name}<span className="set-crumb-sep" aria-hidden="true"><Icon name="right" size={16} /></span></>
    return <SettingsPending title={PROJECT_PAGES.find((p) => p.section === section)?.label ?? 'Settings'} crumb={crumb} failed={failed} what={`${project.name} settings`} onRetry={retry} />
  }
  return <ProjectBody projectId={projectId} section={section} agentId={agentId} s={s} />
}

/** One of a project's pages. Each reads and writes its own project only. */
function ProjectBody({ projectId, section = 'general', agentId, s }: { projectId?: string; section?: ProjectSettingsSection; agentId?: string; s: AppSettings }) {
  switch (section) {
    case 'git': return <ProjectGit projectId={projectId} s={s} />
    case 'setup': return <ProjectSetup projectId={projectId} />
    case 'agents': return agentId && projectId ? <AgentEdit key={`${projectId}/${agentId}`} projectId={projectId} agentId={agentId} /> : <Team projectId={projectId} s={s} />
    case 'prs': return <ProjectPrs projectId={projectId} s={s} />
    case 'environment': return <Environment projectId={projectId} />
    default: return <Project projectId={projectId} />
  }
}
