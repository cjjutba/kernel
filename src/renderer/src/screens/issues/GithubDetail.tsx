import { useEffect, useMemo, useRef } from 'react'
import type { GithubIssue, GithubIssueDetail, Project } from '@shared/types'
import { call, cleanError } from '../../api'
import { useDetailLoad } from './useDetailLoad'
import { detailKey } from './cache'
import { actions, useStore } from '../../store'
import { FailedState, Icon, LoadingRow, Skeleton, useBusy } from '../../ui'
import { failToast, useRetryKey } from '../../retry'
import { IssueState } from '../../icons'
import { openLeadChat, openNewChat } from '../../lead'
import { Markdown } from '../workspace/markdown'
import { WorkCard } from './WorkCard'
import { useKeptScroll } from '../../ui/keptScroll'
import { githubPlanParts, issueAge, linkedWorkspaces, loginInitials } from './model'

/** The selected GitHub issue: what GitHub says about it, the workspaces already working on it, and the buttons that start work (IssuesGitHub.png). */
export function GithubDetail({ keep, project, id, summary, tick }: { keep: string; project: Project; id: string; summary?: GithubIssue; tick: number }) {
  const { loaded, failure, retry } = useDetailLoad<GithubIssueDetail>(id, detailKey('github', project.id, id), () => call('github.issue', { projectId: project.id, id }), [project.id, tick])
  const failed = failure?.id === id ? failure.message : null
  // A detail that failed says so in a toast with Try again, and the pane shows a calm state in its place (DESIGN.md, State kinds).
  useRetryKey('githubIssue', retry)
  useEffect(() => { if (failed) failToast(`Couldn't load ${id}`, failed, 'githubIssue') }, [failed, id])
  const [busy, run] = useBusy<'plan'>()
  const workspaces = useStore((s) => s.workspaces)
  const lead = useStore((s) => s.agents[project.id]?.find((a) => a.lead)?.name) || 'Kernel'

  // The description and comments come from `github.issue`. The list already has the rest, so the header shows at once.
  const detail = loaded?.id === id ? loaded : null
  const scroll = useRef<HTMLDivElement>(null)
  useKeptScroll(scroll, { key: `${keep}:${id}`, ready: !!detail })
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

  const [first, ...others] = issue.assignees
  return (
    <article className="is-detail" aria-label={issue.title}>
      <div className="is-scroll" ref={scroll}>
        <div className="is-inner">
          <div className="col is-gap-6">
            <span className="is-keyline">
              <span className="mono muted is-key">{issue.id}</span>
              {issue.url && <a className="is-ext" href={issue.url} target="_blank" rel="noreferrer" aria-label={`Open ${issue.id} on GitHub`}><Icon name="ext" size={13} /></a>}
            </span>
            <h2>{issue.title}</h2>
          </div>

          <div className="is-cols">
          <dl className="is-facts">
            <dt>Status</dt>
            <dd><IssueState shape="todo" size={14} />Open</dd>
            <dt>Milestone</dt>
            <dd>{issue.milestone ?? <span className="muted">No milestone</span>}</dd>
            <dt>Comments</dt>
            <dd>{detail ? detail.comments.length : <span className="muted">…</span>}</dd>
            <dt>Opened by</dt>
            <dd>{issue.author ?? <span className="muted">Unknown</span>}</dd>
            <dt>Assignee</dt>
            <dd>{first ? <><span className="is-av" aria-hidden="true">{loginInitials(first)}</span>{first}{others.length > 0 && <span className="muted">+{others.length}</span>}</> : <span className="muted">Unassigned</span>}</dd>
            <dt>Labels</dt>
            <dd className="is-wide">{issue.labels.length ? issue.labels.map((l) => <span key={l} className="is-label">{l}</span>) : <span className="muted">None</span>}</dd>
          </dl>

          <div className="is-main">
          <WorkCard linked={linked} handOff={{ id, lead, planBusy: busy === 'plan', disabled: busy !== null, onPlan: () => void plan(), onHand: newChat }} />

          {detail ? (
            <>
              {detail.body.trim() && <Markdown className="is-desc" text={detail.body} />}
              <section aria-label="Comments" className="is-sec">
                <h3>Comments{detail.comments.length > 0 && <span className="is-count">{detail.comments.length}</span>}</h3>
                {detail.comments.length === 0 && <p className="muted is-flat">No comments yet.</p>}
                {detail.comments.map((c) => (
                  <div key={c.id} className="is-comment">
                    <span className="is-av is-av-md" aria-hidden="true">{loginInitials(c.author ?? '?')}</span>
                    <span className="col is-gap-2">
                      <span><span className="is-who">{c.author ?? 'GitHub'}</span><span className="muted is-when">{issueAge(c.createdAt)} ago</span></span>
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

    </article>
  )
}
