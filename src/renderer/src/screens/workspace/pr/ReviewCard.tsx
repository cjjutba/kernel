import type { PrInfo, Workspace } from '@shared/types'
import { call } from '../../../api'
import { actions } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { openComments, reviewLines } from './model'
import '../cards/cards.css'

/**
 * Review comments pulled from GitHub, at the end of the chat while the PR has changes requested (WorkspaceChangesRequested.png).
 * Send to the agent is the header's Address review: both send address-review.md with these comments.
 */
export function ReviewCard({ ws, pr, agentName }: { ws: Workspace; pr: PrInfo; agentName: string }) {
  const [busy, run] = useBusy()
  const comments = openComments(pr)
  if (!comments.length) return null
  const reviewer = comments[0].author || 'A reviewer'
  const send = () => run('send', async () => {
    try { await call('pr.resolve', { workspaceId: ws.id }) } catch (e) { actions.ui.toast({ title: 'Could not send to the agent', sub: (e as Error).message }) }
  })
  return (
    <section aria-label="Review comments" className="card tcard">
      <h3>{reviewer} requested changes on #{pr.number}</h3>
      <span className="sub">{comments.length} {comments.length === 1 ? 'comment' : 'comments'}</span>
      <div className="code">{reviewLines(comments).join('\n')}</div>
      <div className="acts">
        <button type="button" className="btn" onClick={() => void call('system.openExternal', { url: pr.url })}>Open on GitHub</button>
        <Button variant="primary" busy={!!busy} busyLabel="Sending" onClick={() => void send()}>Send to {agentName}</Button>
      </div>
    </section>
  )
}
