import { useEffect, useMemo, useRef, useState } from 'react'
import type { IssueTakenFinding, LinearIssue, LinearIssueDetail, Project } from '@shared/types'
import { call, cleanError } from '../../api'
import { useDetailLoad } from './useDetailLoad'
import { detailKey, forgetTracker } from './cache'
import { actions, getState, lastProject, useStore } from '../../store'
import { Button, FailedState, Icon, LoadingRow, Select, Skeleton, useBusy } from '../../ui'
import { failToast, useRetryKey } from '../../retry'
import { IssuePriority, IssueState, PRIORITIES } from '../../icons'
import { openLeadChat, openNewChat } from '../../lead'
import { ProjectIcon } from '../../components/ProjectIcon'
import { Markdown } from '../workspace/markdown'
import { initials, issueAge, linkedWorkspaces, stateShape } from './model'
import { WorkCard } from './WorkCard'
import { ConfirmIssueTaken } from './ConfirmIssueTaken'
import { takenFindings } from '../new-workspace/taken'
import { useKeptScroll } from '../../ui/keptScroll'

/** The selected issue: what Linear says about it, the workspaces already working on it, and the buttons that start work. */
export function IssueDetail({ keep, headProject, id, summary, tick, onPlanned }: { keep: string; headProject?: Project; id: string; summary?: LinearIssue; tick: number; onPlanned: () => void }) {
  const { loaded, failure, retry } = useDetailLoad<LinearIssueDetail>(id, detailKey('linear', '', id), () => call('linear.issue', { id }), [tick])
  const failed = failure?.id === id ? failure.message : null
  // A detail that failed says so in a toast with Try again, and the pane shows a calm state in its place (DESIGN.md, State kinds). A cached copy keeps showing, as it did.
  useRetryKey('issue', retry)
  useEffect(() => { if (failed) failToast(`Couldn't load ${id}`, failed, 'issue') }, [failed, id])
  const [busy, run] = useBusy<'plan' | 'link'>()
  // Work already on the issue holds Plan with Kernel back until the person says to start anyway.
  // It is pinned to the issue and project Plan was clicked on, so a new selection can't retarget it.
  const [asking, setAsking] = useState<{ issue: string; projectId: string; findings: IssueTakenFinding[] } | null>(null)
  const current = useRef(id)
  current.current = id
  useEffect(() => { setAsking(null) }, [id])
  const [picked, setPicked] = useState<{ issue: string; project: string } | null>(null)
  const projects = useStore((s) => s.projects)
  const projectSettings = useStore((s) => s.projectSettings)
  const agents = useStore((s) => s.agents)
  const workspaces = useStore((s) => s.workspaces)
  // The project opened last, read once. A store selector runs on every change and must not touch localStorage.
  const [lastProjectId] = useState(lastProject)

  // The description and comments come from `linear.issue`. The list already has the rest, so the header shows at once.
  const issue: LinearIssue | undefined = loaded?.id === id ? loaded : summary
  const detail = loaded?.id === id ? loaded : null
  const scroll = useRef<HTMLDivElement>(null)
  useKeptScroll(scroll, { key: `${keep}:${id}`, ready: !!detail })

  const choices = useMemo(() => projects.filter((r) => !r.archived && !r.hidden), [projects])
  const ids = choices.map((r) => r.id).join(',')
  const [settled, setSettled] = useState(() => choices.every((r) => !!getState().projectSettings[r.id]))
  // Each project's Linear team is in its settings file, so read the ones the store doesn't have before saying a team has no project.
  useEffect(() => {
    const missing = choices.filter((r) => !getState().projectSettings[r.id])
    if (missing.length === 0) { setSettled(true); return }
    let live = true
    setSettled(false)
    void Promise.allSettled(missing.map((r) => call('settings.project', { projectId: r.id }).then((rs) => actions.settings.setProject(r.id, rs)))).then(() => live && setSettled(true))
    return () => { live = false }
  }, [ids])

  const team = issue?.team.key
  const linkedProject = team ? choices.find((r) => projectSettings[r.id]?.linear?.team?.toUpperCase() === team.toUpperCase()) : undefined
  const project = choices.find((r) => r.id === (picked?.issue === id ? picked.project : undefined)) ?? linkedProject ?? choices.find((r) => r.id === headProject?.id) ?? choices.find((r) => r.id === lastProjectId) ?? choices[0]
  // The page's project is where this plans. The choice only shows when the issue can go elsewhere: its team belongs to another project, or the page has none.
  const choosable = !headProject || project?.id !== headProject.id || picked?.issue === id
  const lead = (project && agents[project.id]?.find((a) => a.lead)?.name) || 'Kernel'
  const linked = linkedWorkspaces(id, workspaces)
  const unlinked = !!issue && settled && !linkedProject && !!project

  const startPlan = async (issueId: string, projectId: string) => {
    try {
      const { chatId } = await call('linear.plan', { id: issueId, projectId })
      onPlanned()
      await openLeadChat(projectId, chatId)
    } catch (e) { actions.ui.toast({ title: `Could not plan with ${lead}`, sub: cleanError(e) }) }
  }
  const plan = () => project && run('plan', async () => {
    const target = id
    if (linked.length === 0) return startPlan(target, project.id)
    // What Kernel found on the issue, then the workspaces already linked to it, three things at most.
    const found = await takenFindings((req) => call('issues.taken', req), project.id, target)
    if (current.current !== target) return
    const mine: IssueTakenFinding[] = linked.flatMap((w) => [{ kind: 'branch' as const, ref: w.branch }, ...(w.prNumber && !['none', 'merged', 'closed'].includes(w.prState) ? [{ kind: 'pr' as const, number: w.prNumber, title: w.title ?? w.name }] : [])])
    const seen = new Set<string>()
    setAsking({ issue: target, projectId: project.id, findings: [...found, ...mine].filter((f) => { const k = JSON.stringify(f); return !seen.has(k) && !!seen.add(k) }).slice(0, 3) })
  })
  const link = () => project && team && run('link', async () => {
    try { actions.settings.setProject(project.id, await call('settings.setProject', { projectId: project.id, patch: { linear: { team } } })); forgetTracker(project.id) }
    catch (e) { actions.ui.toast({ title: `Could not link ${team} to ${project.name}`, sub: cleanError(e) }) }
  })
  const newChat = () => issue && openNewChat(project?.id, { source: { kind: 'issue', id: issue.id, title: issue.title, url: issue.url } })

  if (!issue || (failed && !detail)) {
    return (
      <article className="is-detail" aria-label={id} aria-busy={!failed || undefined}>
        {failed ? <FailedState icon="question" title={`${id} didn't load`} onRetry={retry}>The rest of Work still works.</FailedState> : (
          <div className="is-scroll"><div className="is-skeleton is-sk-detail" role="status" aria-label={`Loading ${id}`}>
            <div className="is-sk-body"><Skeleton width={90} height={8} /><Skeleton width={340} height={14} /><Skeleton width={420} height={9} /><Skeleton width={380} height={9} /><Skeleton width={260} height={9} /></div>
            <LoadingRow what={id} inline />
          </div></div>
        )}
      </article>
    )
  }

  // Started, with no assignee and no workspace of ours. Kernel's agents aren't Linear users, so a linked workspace means someone is on it.
  const nobody = issue.state.type === 'started' && !issue.assignee && linked.length === 0
  const cycle = issue.cycle ? issue.cycle.name || `Cycle ${issue.cycle.number}` : 'No cycle'
  return (
    <article className="is-detail" aria-label={issue.title}>
      <div className="is-scroll" ref={scroll}>
        <div className="is-inner">
          <div className="col is-gap-6">
            <span className="is-keyline">
              <span className="mono muted is-key">{issue.id}</span>
              <a className="is-ext" href={issue.url} target="_blank" rel="noreferrer" aria-label={`Open ${issue.id} in Linear`}><Icon name="ext" size={13} /></a>
            </span>
            <h2>{issue.title}</h2>
          </div>

          <div className="is-cols">
          <dl className="is-facts">
            <dt>Status</dt>
            <dd><IssueState shape={stateShape(issue.state.type)} size={14} />{issue.state.name}</dd>
            <dt>Linear project</dt>
            <dd>{issue.project?.name ?? <span className="muted">No Linear project</span>}</dd>
            <dt>Priority</dt>
            <dd><IssuePriority priority={issue.priority} label />{PRIORITIES[issue.priority] ?? PRIORITIES[0]}</dd>
            <dt>Cycle</dt>
            <dd>{issue.cycle ? cycle : <span className="muted">{cycle}</span>}</dd>
            <dt>Assignee</dt>
            <dd>{issue.assignee ? <><span className="is-av" aria-hidden="true">{initials(issue.assignee.name)}</span>{issue.assignee.name}</> : <span className="muted">{nobody ? 'No one is on this' : 'Unassigned'}</span>}</dd>
            <dt>Labels</dt>
            <dd>{issue.labels.length ? issue.labels.map((l) => <span key={l} className="is-label">{l}</span>) : <span className="muted">None</span>}</dd>
          </dl>

          <div className="is-main">
          <WorkCard linked={linked} handOff={project ? { id, lead, planBusy: busy === 'plan', disabled: busy !== null, onPlan: () => void plan(), onHand: newChat } : undefined} />

          {detail ? (
            <>
              {detail.description.trim() && <Markdown className="is-desc" text={detail.description} />}
              <section aria-label="Comments" className="is-sec">
                <h3>Comments{detail.comments.length > 0 && <span className="is-count">{detail.comments.length}</span>}</h3>
                {detail.comments.length === 0 && <p className="muted is-flat">No comments yet.</p>}
                {detail.comments.map((c) => (
                  <div key={c.id} className="is-comment">
                    <span className="is-av is-av-md" aria-hidden="true">{initials(c.author ?? '?')}</span>
                    <span className="col is-gap-2">
                      <span><span className="is-who">{c.author ?? 'Linear'}</span><span className="muted is-when">{issueAge(c.createdAt)} ago</span></span>
                      <Markdown className="is-body" text={c.body} />
                    </span>
                  </div>
                ))}
              </section>
            </>
          ) : (
            <div className="col is-gap-8" aria-busy="true"><Skeleton width="85%" /><Skeleton width="70%" /><Skeleton width="40%" /><LoadingRow what={id} inline /></div>
          )}
          </div>
          </div>
        </div>
      </div>

      {((unlinked && project) || (project && choosable)) && (
        <div className="is-foot">
          <div className="is-inner">
            {unlinked && project && (
              <div role="status" className="banner is-link">
                <Icon name="link" />
                <div className="grow"><div className="banner-title">{team} isn't linked to a project</div><div className="muted">Link it to {project.name} so its issues open there by default.</div></div>
                <Button variant="primary" busy={busy === 'link'} busyLabel="Linking" disabled={busy !== null} onClick={() => void link()}>Link {team} to {project.name}</Button>
              </div>
            )}
            {project && choosable && (
              <div className="is-actions">
                <Select
                  variant="chip" className="is-project" prefix="Plan in" leading={<ProjectIcon project={project} className="is-letter" />} label="Project" value={project.id}
                  options={choices.map((r) => ({ value: r.id, label: r.name, leading: <ProjectIcon project={r} className="is-letter" /> }))} onChange={(v) => setPicked({ issue: id, project: v })}
                />
              </div>
            )}
          </div>
        </div>
      )}
      {asking && asking.issue === id && <ConfirmIssueTaken issue={asking.issue} findings={asking.findings} onStart={async () => { await startPlan(asking.issue, asking.projectId); setAsking(null) }} onCancel={() => setAsking(null)} />}
    </article>
  )
}
