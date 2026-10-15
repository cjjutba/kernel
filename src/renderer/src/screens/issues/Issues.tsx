import { useMemo, useState } from 'react'
import { go, lastProject, useStore } from '../../store'
import { Banner, Button } from '../../ui'
import { GithubIssues } from './GithubIssues'
import { LinearIssues } from './LinearIssues'
import { IssueSkeleton, NoTracker, type ProjectHead } from './parts'
import { WorkHeader } from '../work/WorkHeader'
import { useOpenPrCount } from '../prs/model'
import { useProjectTracker } from './useProjectTracker'
import './issues.css'

/**
 * The Issues tab of Work for one project (KERNEL-471). The project's tracker decides what it lists: Linear's list (the account's, as it always
 * was), the project's GitHub Issues, or a line saying the project has no tracker. The route's `projectId` picks the project, else the one used
 * last. The project menu in the header switches to another project's tracker.
 */
export function Issues({ issueId, projectId }: { issueId?: string; projectId?: string }) {
  const projects = useStore((s) => s.projects)
  const choices = useMemo(() => projects.filter((r) => !r.archived && !r.hidden), [projects])
  // The project opened last, read once. A store selector runs on every change and must not touch localStorage.
  const [lastProjectId] = useState(lastProject)
  const project = choices.find((r) => r.id === projectId) ?? choices.find((r) => r.id === lastProjectId) ?? choices[0]
  // Another project is another route, so the sidebar follows it and Back returns to the project before.
  const head: ProjectHead = { projects: choices, project, onProject: (id) => go({ name: 'issues', projectId: id }) }

  const { read, retry } = useProjectTracker(project?.id)
  const prCount = useOpenPrCount()

  // With no project there is no tracker to read, and Linear's list needs none.
  if (!project) return <LinearIssues issueId={issueId} head={head} />
  if (read.kind === 'ready' && read.tracker.kind === 'linear') return <LinearIssues key={project.id} issueId={issueId} head={head} />
  if (read.kind === 'ready' && read.tracker.kind === 'github') return <GithubIssues key={project.id} project={project} where={read.tracker.where} issueId={issueId} head={head} />

  return (
    <div className="panel">
      <WorkHeader tab="issues" head={head} counts={{ prs: prCount }} />
      {read.kind === 'loading' && <IssueSkeleton />}
      {read.kind === 'error' && (
        <div className="is-center">
          <div className="is-fail">
            <Banner kind="offline" title="Can't load issues" actions={<Button size="md" onClick={retry}>Try again</Button>}>{read.message}</Banner>
          </div>
        </div>
      )}
      {read.kind === 'ready' && read.tracker.kind === 'none' && <NoTracker project={project} />}
    </div>
  )
}
