import { useMemo } from 'react'
import { go, useStore } from '../../store'
import { useRemembered } from '../../remember'
import { Banner, Button } from '../../ui'
import { GithubIssues } from './GithubIssues'
import { LinearIssues } from './LinearIssues'
import { IssueSkeleton, NoTracker, trackerChoice, type IssueTracker, type ProjectHead } from './parts'
import { WorkHeader } from '../work/WorkHeader'
import { useWorkProject } from '../work/useWorkProject'
import { useOpenPrCount } from '../prs/model'
import { activeTracker } from './model'
import { useProjectTracker } from './useProjectTracker'
import './issues.css'

/**
 * The Issues tab of Work for one project (KERNEL-471). The project's tracker decides what it lists: Linear's list (the account's, as it always
 * was), the project's GitHub Issues, or a line saying the project has no tracker. The route's `projectId` picks the project, else the one used
 * last. The project menu in the header switches to another project's tracker.
 */
export function Issues({ issueId, projectId, tracker }: { issueId?: string; projectId?: string; tracker?: IssueTracker }) {
  const projects = useStore((s) => s.projects)
  const choices = useMemo(() => projects.filter((r) => !r.archived && !r.hidden), [projects])
  // One project for both Work tabs. While it is All projects, Issues keeps the last single project it was on.
  const { single: project, pick } = useWorkProject(choices, projectId)
  // Another project is another route, so the sidebar follows it and Back returns to the project before.
  const head: ProjectHead = { projects: choices, project, onProject: (id) => { pick(id); go({ name: 'issues', projectId: id }) } }

  const { read, retry } = useProjectTracker(project?.id)
  const prCount = useOpenPrCount()
  // The choice is saved per project. A route that names a tracker, or an issue `#41`, shows that one without saving it.
  const [saved, save] = useRemembered(`kernel.issuesTracker:${project?.id ?? ''}`, trackerChoice)

  // With no project there is no tracker to read, and Linear's list needs none.
  if (!project) return <LinearIssues issueId={issueId} head={head} />
  if (read.kind === 'ready' && read.tracker.kind !== 'none') {
    const t = read.tracker
    const active = activeTracker(t, { issueId, route: tracker, saved })
    // The switch drops the open issue, which belongs to the tracker it came from.
    const onTracker = (next: IssueTracker) => { save(next); go({ name: 'issues', projectId: project.id }) }
    const withSwitch: ProjectHead = { ...head, tracker: { active, available: t.available, onChange: onTracker } }
    return active === 'github'
      ? <GithubIssues key={`${project.id}|github`} project={project} where={t.available.github?.where ?? t.where} issueId={issueId?.startsWith('#') ? issueId : undefined} head={withSwitch} />
      : <LinearIssues key={`${project.id}|linear`} issueId={issueId?.startsWith('#') ? undefined : issueId} head={withSwitch} />
  }

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
