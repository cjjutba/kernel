import { useEffect, useMemo, useRef, useState } from 'react'
import type { LinearIssue, LinearIssueDetail } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go, lastProject, useStore } from '../../store'
import { Button, FailedState, Icon, Select, Skeleton, useBusy } from '../../ui'
import { IssuePriority, IssueState, PRIORITIES } from '../../icons'
import { openLeadChat, openNewChat } from '../../lead'
import { ProjectIcon } from '../../components/ProjectIcon'
import { Markdown } from '../workspace/markdown'
import { DescriptionFailed } from './parts'
import { initials, issueAge, linkedWorkspaces, stateShape } from './model'
import { WorkCard } from './WorkCard'

/** The selected issue: what Linear says about it, the workspaces already working on it, and the buttons that start work. */
export function IssueDetail({ id, summary, tick, onPlanned }: { id: string; summary?: LinearIssue; tick: number; onPlanned: () => void }) {
  const [loaded, setLoaded] = useState<LinearIssueDetail | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const failed = failure?.id === id ? failure.message : null
  const waiting = useRef<(() => void)[]>([])
  const [attempt, setAttempt] = useState(0)
  const [busy, run] = useBusy<'plan' | 'link'>()
  const [picked, setPicked] = useState<{ issue: string; project: string } | null>(null)
  const [settled, setSettled] = useState(false)
  const projects = useStore((s) => s.projects)
  const projectSettings = useStore((s) => s.projectSettings)
  const agents = useStore((s) => s.agents)
  const workspaces = useStore((s) => s.workspaces)
  // The project opened last, read once. A store selector runs on every change and must not touch localStorage.
  const [lastProjectId] = useState(lastProject)

  // The description and comments come from `linear.issue`. The list already has the rest, so the header shows at once.
  useEffect(() => {
    let live = true
    call('linear.issue', { id }).then((d) => { if (live) { setLoaded(d); setFailure(null) } }).catch((e: Error) => { if (live) setFailure({ id, message: cleanError(e) }) }).finally(() => waiting.current.splice(0).forEach((done) => done()))
    return () => { live = false }
  }, [id, tick, attempt])
  const retry = () => {
    setAttempt((a) => a + 1)
    return new Promise<void>((done) => waiting.current.push(done))
  }
  const issue: LinearIssue | undefined = loaded?.id === id ? loaded : summary
  const detail = loaded?.id === id ? loaded : null

  const choices = useMemo(() => projects.filter((r) => !r.archived && !r.hidden), [projects])
  const ids = choices.map((r) => r.id).join(',')
  // Each project's Linear team is in its settings file, so read them all before saying a team has no project.
  useEffect(() => {
    let live = true
    setSettled(false)
    void Promise.allSettled(choices.map((r) => call('settings.project', { projectId: r.id }).then((rs) => actions.settings.setProject(r.id, rs)))).then(() => live && setSettled(true))
    return () => { live = false }
  }, [ids])

  const team = issue?.team.key
  const linkedProject = team ? choices.find((r) => projectSettings[r.id]?.linear?.team?.toUpperCase() === team.toUpperCase()) : undefined
  const project = choices.find((r) => r.id === (picked?.issue === id ? picked.project : undefined)) ?? linkedProject ?? choices.find((r) => r.id === lastProjectId) ?? choices[0]
  const lead = (project && agents[project.id]?.find((a) => a.lead)?.name) || 'Kernel'
  const linked = linkedWorkspaces(id, workspaces)
  // The one furthest along, which the footer's main button opens.
  const work = linked[0]
  const unlinked = !!issue && settled && !linkedProject && !!project

  const plan = () => project && run('plan', async () => {
    try {
      const { chatId } = await call('linear.plan', { id, projectId: project.id })
      onPlanned()
      await openLeadChat(project.id, chatId)
    } catch (e) { actions.ui.toast({ title: `Could not plan with ${lead}`, sub: cleanError(e) }) }
  })
  const link = () => project && team && run('link', async () => {
    try { actions.settings.setProject(project.id, await call('settings.setProject', { projectId: project.id, patch: { linear: { team } } })) }
    catch (e) { actions.ui.toast({ title: `Could not link ${team} to ${project.name}`, sub: cleanError(e) }) }
  })
  const newChat = () => issue && openNewChat(project?.id, { source: { kind: 'issue', id: issue.id, title: issue.title, url: issue.url } })

  if (!issue) {
    return (
      <article className="is-detail" aria-label={id} aria-busy={!failed || undefined}>
        {failed ? <FailedState title={`Could not load ${id}`} onRetry={retry}>{failed}</FailedState> : (
          <div className="is-scroll"><div className="is-inner">
            <span className="mono muted is-key">{id}</span>
            <Skeleton width="60%" height={26} />
          </div></div>
        )}
      </article>
    )
  }

  const cycle = issue.cycle ? issue.cycle.name || `Cycle ${issue.cycle.number}` : 'No cycle'
  return (
    <article className="is-detail" aria-label={issue.title}>
      <div className="is-scroll">
        <div className="is-inner">
          <div className="col" style={{ gap: 6 }}>
            <span className="is-keyline">
              <span className="mono muted is-key">{issue.id}</span>
              <a className="is-ext" href={issue.url} target="_blank" rel="noreferrer" aria-label={`Open ${issue.id} in Linear`}><Icon name="ext" size={14} /></a>
            </span>
            <h2>{issue.title}</h2>
          </div>

          <dl className="is-facts">
            <dt>Status</dt>
            <dd><IssueState shape={stateShape(issue.state.type)} />{issue.state.name}</dd>
            <dt>Project</dt>
            <dd>{issue.project?.name ?? <span className="muted">No project</span>}</dd>
            <dt>Priority</dt>
            <dd><IssuePriority priority={issue.priority} label />{PRIORITIES[issue.priority] ?? PRIORITIES[0]}</dd>
            <dt>Cycle</dt>
            <dd>{issue.cycle ? cycle : <span className="muted">{cycle}</span>}</dd>
            <dt>Assignee</dt>
            <dd>{issue.assignee ? <><span className="is-av" aria-hidden="true">{initials(issue.assignee.name)}</span>{issue.assignee.name}</> : <span className="muted">Unassigned</span>}</dd>
            <dt>Labels</dt>
            <dd>{issue.labels.length ? issue.labels.map((l) => <span key={l} className="is-label">{l}</span>) : <span className="muted">None</span>}</dd>
          </dl>

          <WorkCard linked={linked} />

          {detail ? (
            <>
              {detail.description.trim() && <Markdown className="is-desc" text={detail.description} />}
              <section aria-label="Comments" className="is-sec">
                <h3>Comments{detail.comments.length > 0 && <span className="is-count">{detail.comments.length}</span>}</h3>
                {detail.comments.length === 0 && <p className="muted" style={{ margin: 0 }}>No comments yet.</p>}
                {detail.comments.map((c) => (
                  <div key={c.id} className="is-comment">
                    <span className="is-av is-av-md" aria-hidden="true">{initials(c.author ?? '?')}</span>
                    <span className="col" style={{ gap: 2, minWidth: 0 }}>
                      <span><span className="is-who">{c.author ?? 'Linear'}</span><span className="muted is-when">{issueAge(c.createdAt)} ago</span></span>
                      <Markdown className="is-body" text={c.body} />
                    </span>
                  </div>
                ))}
              </section>
            </>
          ) : failed ? (
            <DescriptionFailed onRetry={retry}>{failed}</DescriptionFailed>
          ) : (
            <div className="col" style={{ gap: 8 }} aria-busy="true"><Skeleton width="85%" /><Skeleton width="70%" /><Skeleton width="40%" /></div>
          )}
        </div>
      </div>

      <div className="is-foot">
        <div className="is-inner">
          {unlinked && project && (
            <div role="status" className="banner is-link">
              <Icon name="link" />
              <div className="grow"><div className="banner-title">{team} isn't linked to a project</div><div className="muted">Link it to {project.name} so its issues open there by default.</div></div>
              <Button variant="primary" busy={busy === 'link'} busyLabel="Linking" disabled={busy !== null} onClick={() => void link()}>Link {team} to {project.name}</Button>
            </div>
          )}
          <div className="is-actions">
            {project && (
              <Select
                variant="chip" className="is-project" prefix="Project" leading={<ProjectIcon project={project} className="is-letter" />} label="Project" value={project.id}
                options={choices.map((r) => ({ value: r.id, label: r.name, leading: <ProjectIcon project={r} className="is-letter" /> }))} onChange={(v) => setPicked({ issue: id, project: v })}
              />
            )}
            <span className="grow" />
            <Button size="lg" disabled={!project} onClick={newChat}>New chat</Button>
            <Button size="lg" variant={work ? 'secondary' : 'primary'} busy={busy === 'plan'} busyPattern="arrow-right" busyLabel="Sending" disabled={!project || busy !== null} onClick={() => void plan()}>Plan with {lead}</Button>
            {work && <Button size="lg" variant="primary" onClick={() => go({ name: 'workspace', workspaceId: work.id })}>Open workspace</Button>}
          </div>
        </div>
      </div>
    </article>
  )
}
