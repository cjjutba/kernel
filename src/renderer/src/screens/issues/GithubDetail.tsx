import { useMemo } from 'react'
import type { GithubIssue, GithubIssueDetail, Project } from '@shared/types'
import { call, cleanError } from '../../api'
import { useDetailLoad } from './useDetailLoad'
import { actions, go, useStore } from '../../store'
import { Button, FailedState, Icon, Skeleton, useBusy } from '../../ui'
import { IssueState } from '../../icons'
import { openLeadChat, openNewChat } from '../../lead'
import { Markdown } from '../workspace/markdown'
import { WorkCard } from './WorkCard'
import { DescriptionFailed } from './parts'
import { githubPlanParts, issueAge, linkedWorkspaces, loginInitials } from './model'

/** The selected GitHub issue: what GitHub says about it, the workspaces already working on it, and the buttons that start work (IssuesGitHub.png). */
export function GithubDetail({ project, id, summary, tick }: { project: Project; id: string; summary?: GithubIssue; tick: number }) {
  const { loaded, failure, retry } = useDetailLoad<GithubIssueDetail>(id, () => call('github.issue', { projectId: project.id, id }), [project.id, tick])
  const failed = failure?.id === id ? failure.message : null
  const [busy, run] = useBusy<'plan'>()
  const workspaces = useStore((s) => s.workspaces)
  const lead = useStore((s) => s.agents[project.id]?.find((a) => a.lead)?.name) || 'Kernel'

  // The description and comments come from `github.issue`. The list already has the rest, so the header shows at once.
  const detail = loaded?.id === id ? loaded : null
  const issue: GithubIssue | undefined = detail ?? summary
  const linked = useMemo(() => linkedWorkspaces(id, workspaces.filter((w) => w.projectId === project.id)), [id, workspaces, project.id])

  const plan = () => run('plan', async () => {
    try {
      const d = detail ?? (await call('github.issue', { projectId: project.id, id }))
      const chat = await call('lead.start', { projectId: project.id, prompt: '', parts: githubPlanParts(d), plan: true })
      await openLeadChat(project.id, chat.id)
    } catch (e) { actions.ui.toast({ title: `Could not plan with ${lead}`, sub: cleanError(e) }) }
  })
  const newChat = () => issue && openNewChat(project.id, { source: { kind: 'issue', id: issue.id, title: issue.title, url: issue.url || undefined, tracker: 'github' } })

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

  const [first, ...others] = issue.assignees
  return (
    <article className="is-detail" aria-label={issue.title}>
      <div className="is-scroll">
        <div className="is-inner">
          <div className="col" style={{ gap: 6 }}>
            <span className="mono muted is-key">{issue.id}</span>
            <h2>{issue.title}</h2>
          </div>

          <dl className="is-facts">
            <dt>State</dt>
            <dd><IssueState shape="todo" />Open</dd>
            <dt>Milestone</dt>
            <dd>{issue.milestone ?? <span className="muted">No milestone</span>}</dd>
            <dt>Assignee</dt>
            <dd>{first ? <><span className="is-av" aria-hidden="true">{loginInitials(first)}</span>{first}{others.length > 0 && <span className="muted">+{others.length}</span>}</> : <span className="muted">Unassigned</span>}</dd>
            <dt>Author</dt>
            <dd>{issue.author ?? <span className="muted">Unknown</span>}</dd>
            <dt>Labels</dt>
            <dd className="is-wide">{issue.labels.length ? issue.labels.map((l) => <span key={l} className="is-label">{l}</span>) : <span className="muted">None</span>}</dd>
          </dl>

          <WorkCard linked={linked} />

          {detail ? (
            <>
              {detail.body.trim() && <Markdown className="is-desc" text={detail.body} />}
              <section aria-label="Comments" className="is-sec">
                <h3>Comments{detail.comments.length > 0 && <span className="is-count">{detail.comments.length}</span>}</h3>
                {detail.comments.length === 0 && <p className="muted" style={{ margin: 0 }}>No comments yet.</p>}
                {detail.comments.map((c) => (
                  <div key={c.id} className="is-comment">
                    <span className="is-av is-av-md" aria-hidden="true">{loginInitials(c.author ?? '?')}</span>
                    <span className="col" style={{ gap: 2, minWidth: 0 }}>
                      <span><span className="is-who">{c.author ?? 'GitHub'}</span><span className="muted is-when">{issueAge(c.createdAt)} ago</span></span>
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
          <div className="is-actions">
            <span className="grow" />
            {issue.url && <a className="btn lg" href={issue.url} target="_blank" rel="noreferrer">Open on GitHub<Icon name="ext" size={12} /></a>}
            <Button size="lg" onClick={newChat}>New chat</Button>
            <Button size="lg" variant={linked[0] ? 'secondary' : 'primary'} busy={busy === 'plan'} busyPattern="arrow-right" busyLabel="Sending" disabled={busy !== null} onClick={() => void plan()}>Plan with {lead}</Button>
            {linked[0] && <Button size="lg" variant="primary" onClick={() => go({ name: 'workspace', workspaceId: linked[0].id })}>Open workspace</Button>}
          </div>
        </div>
      </div>
    </article>
  )
}
