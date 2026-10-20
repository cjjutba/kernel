import { useEffect, useState } from 'react'
import type { LinearScope } from '@shared/types'
import { trackerKind } from '@shared/trackerKind'
import { call, cleanError } from '../../../api'
import { actions, getState, go } from '../../../store'
import { Button, ConfirmDialog, Select, useBusy } from '../../../ui'
import { afterProjectLeaves } from '../../projects/afterProjectLeaves'
import { sourceOf } from '../../projects/projectInfo'
import { ProjectIconRow } from './ProjectIconRow'
import { ProjectReferences } from './ProjectReferences'
import { ProjectTrackerRow } from './ProjectTrackerRow'
import { NoProject, Row, ProjectPage, Section, SettingsLink, useProjectPage } from '../kit'
import { patchProjectSettings } from '../useSettings'

const USE_DEFAULT = ''
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** Settings > a project > General (MorePage projectGeneral, KERNEL-680): the project, its issue tracker and Linear team, and Archive behind a confirm. The rest of the project's settings have pages of their own. */
export function Project({ projectId }: { projectId?: string }) {
  const { project, rs } = useProjectPage(projectId)
  const [busy, run] = useBusy()
  const [confirming, setConfirming] = useState(false)
  // undefined until Integrations answers, so the rows don't flash "Connect Linear" for a connected account or the wrong detected tracker.
  // `teams` is null when Linear isn't connected or its teams didn't load.
  const [linear, setLinear] = useState<{ connected: boolean; teams: LinearScope['teams'] | null } | undefined>(undefined)
  useEffect(() => {
    void call('integrations.list', undefined)
      .then(async (rows) => {
        if (!rows.find((r) => r.id === 'linear')?.connected) return setLinear({ connected: false, teams: null })
        setLinear({ connected: true, teams: await call('linear.scope', undefined).then((scope) => scope.teams, () => null) })
      })
      .catch(() => setLinear({ connected: false, teams: null }))
  }, [])
  if (!project || !projectId) return <NoProject />

  const team = rs?.linear?.team
  const teams = linear?.teams
  const detected = trackerKind({ linearToken: !!linear?.connected, linearTeam: !!team, githubRemote: !!project.repo })
  const tracker = rs?.tracker?.kind ?? detected
  // A saved team that is no longer in the list still shows, so the select never claims None for a team that is set.
  const teamOptions = [{ value: USE_DEFAULT, label: 'None' }, ...[...new Set([...(team ? [team] : []), ...(teams ?? []).map((t) => t.key)])].map((k) => ({ value: k, label: k }))]
  const archive = () => run('archive', async () => {
    try {
      await call('projects.update', { projectId, patch: { archived: true } })
      go(afterProjectLeaves(getState().projects, projectId))
    } catch (e) { actions.ui.toast({ title: 'Could not archive the project', sub: cleanError(e) }) }
    setConfirming(false)
  })
  const restore = () => run('restore', () => call('projects.update', { projectId, patch: { archived: false } }).then((r) => actions.projects.upsert(r), (e) => actions.ui.toast({ title: 'Could not restore the project', sub: cleanError(e) })))
  const open = (what: () => Promise<unknown>, failed: string) => void what().catch((e) => actions.ui.toast({ title: failed, sub: cleanError(e) }))
  return (
    <ProjectPage project={project} rs={rs} title="General" desc="Shared settings live in .kernel/settings.toml in the repo. The rest stay on this Mac.">
      <Section title="Project">
        <ProjectIconRow project={project} />
        <Row id="repository" label="Repository">
          <span className="set-value">{project.repo ?? sourceOf(project)}</span>
          {project.repo && <Button onClick={() => open(() => call('system.openExternal', { url: `https://github.com/${project.repo}` }), 'Could not open GitHub')}>Open on GitHub</Button>}
        </Row>
        <Row id="path" label="Local path">
          <span className="set-value">{home(project.path)}</span>
          <Button onClick={() => open(() => call('app.openIn', { path: project.path }), 'Could not open the folder')}>Open</Button>
        </Row>
      </Section>
      {rs && linear && (
        <Section title="Issues">
          <ProjectTrackerRow projectId={projectId} rs={rs} detected={detected} />
          {tracker === 'linear' && (teams
            ? <Row id="linear-team" label="Linear team" desc="Issues from this team open here.">
                <Select label="Linear team" value={team ?? USE_DEFAULT} options={teamOptions} align="right" onChange={(v) => void patchProjectSettings(projectId, { linear: { team: v || null } })} />
              </Row>
            : <Row id="linear-team" label="Linear team" desc={<>Connect Linear in <SettingsLink to={{ page: 'integrations' }}>Settings, Integrations</SettingsLink>.</>} />)}
        </Section>
      )}
      {rs && <ProjectReferences projectId={projectId} rs={rs} />}
      <Section title="Danger zone">
        <Row id="archive-project" label={project.archived ? 'Restore project' : 'Archive project'} desc={project.archived ? 'Archived. Its chats stay in History.' : 'Stops every agent and archives its workspaces. You can restore it.'}>
          {project.archived
            ? <Button busy={busy === 'restore'} busyLabel="Restoring" onClick={() => void restore()}>Restore project</Button>
            : <Button onClick={() => setConfirming(true)}>Archive project</Button>}
        </Row>
      </Section>
      {confirming && (
        <ConfirmDialog
          title={`Archive ${project.name}?`} body="Every agent stops and all of the project’s workspaces are archived. You can restore the project later." danger
          confirmLabel="Archive project" busy={!!busy} busyPattern="ripple" busyLabel="Archiving" onConfirm={() => void archive()} onCancel={() => setConfirming(false)}
        />
      )}
    </ProjectPage>
  )
}
