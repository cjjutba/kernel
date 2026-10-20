import { useEffect, useState } from 'react'
import type { LinearScope } from '@shared/types'
import { trackerKind } from '@shared/trackerKind'
import { call, cleanError } from '../../../api'
import { actions, getState, go } from '../../../store'
import { Button, ConfirmDialog, Icon, LinkButton, Select, useBusy } from '../../../ui'
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
  const teamName = (key: string) => { const t = teams?.find((x) => x.key === key); return t ? `${t.name} (${t.key})` : key }
  const teamOptions = [{ value: USE_DEFAULT, label: 'None' }, ...[...new Set([...(team ? [team] : []), ...(teams ?? []).map((t) => t.key)])].map((k) => ({ value: k, label: teamName(k) }))]
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
          {project.repo
            ? <LinkButton variant="action" aria-label={`Open ${project.repo} on GitHub`} onClick={() => open(() => call('system.openExternal', { url: `https://github.com/${project.repo}` }), 'Could not open GitHub')}><span className="set-value">{project.repo}</span><Icon name="ext" size={12} /></LinkButton>
            : <span className="set-value">{sourceOf(project)}</span>}
        </Row>
        <Row id="path" label="Local path">
          <span className="set-value">{home(project.path)}</span>
          <Button onClick={() => open(() => call('app.openIn', { path: project.path }), 'Could not open the folder')}>Reveal</Button>
        </Row>
        {rs && <ProjectReferences projectId={projectId} rs={rs} />}
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
      <Section title="Danger zone">
        {project.archived
          ? <Row id="archive-project" label="Archived" desc="Hidden from the sidebar. Its chats stay in History.">
              <Button busy={busy === 'restore'} busyLabel="Restoring" onClick={() => void restore()}>Restore project</Button>
            </Row>
          : <Row id="archive-project" label="Archive project" desc="It leaves the sidebar. Workspaces stay in History.">
              <Button aria-label="Archive project" onClick={() => setConfirming(true)}>Archive</Button>
            </Row>}
        <Row id="remove-project" label="Remove project" desc="Kernel forgets it. The folder stays on disk.">
          <Button onClick={() => actions.ui.openModal({ name: 'confirm', kind: 'removeProject', projectId })}>Remove project</Button>
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
