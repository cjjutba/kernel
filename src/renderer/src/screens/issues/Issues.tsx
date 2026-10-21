import { useEffect, useMemo } from 'react'
import { go, useStore } from '../../store'
import { useRemembered } from '../../remember'
import { Button, EmptyList, FailedState } from '../../ui'
import { actions } from '../../store'
import { failToast, useRetryKey } from '../../retry'
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

  // Which tracker a project uses is read from the engine, and a failed read says so in a toast with Try again.
  useRetryKey('issuesTracker', retry)
  useEffect(() => { if (read.kind === 'error') failToast("Couldn't load issues", read.message, 'issuesTracker') }, [read.kind === 'error' && read.message])

  // Issues are per project. With none there is nothing to read.
  if (!project) {
    return (
      <div className="panel">
        <WorkHeader tab="issues" head={head} counts={{ prs: prCount }} />
        <EmptyList icon="folder" title="Pick a project" action={<Button onClick={() => actions.ui.openModal({ name: 'connectRepo' })}>Add a project</Button>}>Issues are per project. Pick one to see its issues.</EmptyList>
      </div>
    )
  }
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
      {read.kind === 'error' && <FailedState icon="wifioff" title="Issues didn't load" onRetry={retry}>Kernel will try again on its own. Your agents keep working in the meantime.</FailedState>}
      {read.kind === 'ready' && read.tracker.kind === 'none' && <NoTracker project={project} />}
    </div>
  )
}
