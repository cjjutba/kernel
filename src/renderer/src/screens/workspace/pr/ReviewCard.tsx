import { useState } from 'react'
import type { PrInfo, Workspace } from '@shared/types'
import { call } from '../../../api'
import { actions } from '../../../store'
import { openComments, reviewLines } from './model'
import '../cards/cards.css'

/**
 * Review comments pulled from GitHub, at the end of the chat while the PR has changes requested (WorkspaceChangesRequested.png).
 * Send to the agent is the header's Address review: both send address-review.md with these comments.
 */
export function ReviewCard({ ws, pr, agentName }: { ws: Workspace; pr: PrInfo; agentName: string }) {
  const [sending, setSending] = useState(false)
  const comments = openComments(pr)
  if (!comments.length) return null
  const reviewer = comments[0].author || 'A reviewer'
  const send = async () => {
    setSending(true)
    try { await call('pr.resolve', { workspaceId: ws.id }) } catch (e) { actions.ui.toast({ title: 'Could not send to the agent', sub: (e as Error).message }) } finally { setSending(false) }
  }
  return (
    <section aria-label="Review comments" className="card tcard">
      <h3>{reviewer} requested changes on #{pr.number}</h3>
      <span className="sub">{comments.length} {comments.length === 1 ? 'comment' : 'comments'}</span>
      <div className="code">{reviewLines(comments).join('\n')}</div>
      <div className="acts">
        <button type="button" className="btn" onClick={() => void call('system.openExternal', { url: pr.url })}>Open on GitHub</button>
        <button type="button" className="btn primary" disabled={sending} onClick={() => void send()}>Send to {agentName}</button>
      </div>
    </section>
  )
}
