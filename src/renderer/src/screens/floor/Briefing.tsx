import { useState } from 'react'
import type { AgentDef, Approval, Decision } from '@shared/types'
import { call } from '../../api'
import { Icon } from '../../ui'
import { actions, go } from '../../store'
import { pct } from '../../floor/layout'
import { planSteps } from '../workspace/cards/steps'
import { FloorCard } from './FloorCard'

// What the briefing sequence draws besides people walking (FloorSent to FloorReview): the speech bubble over the office,
// and the cards in Logs for a plan, a permission and PRs ready to merge.

const decide = (a: Approval, decision: Decision) =>
  call('approvals.decide', { id: a.id, decision }).catch((e: Error) => actions.ui.toast({ title: 'Could not send your answer', sub: e.message }))

/** A line someone said out loud, over their head, with an optional link under it (FloorTalk.png). Follows them while they walk. */
export function Bubble({ text, at, link }: { text: string; at: [number, number]; link?: { label: string; onClick: () => void } }) {
  return (
    <div role="status" className="floor-bubble" style={pct(at[0], at[1] - 30)}>
      {text}
      {link && <button type="button" className="floor-bubble-link" onClick={link.onClick}>{link.label}</button>}
    </div>
  )
}

/** The Lead's plan: one row per task with its id and assignee. Approving starts the hand-off (FloorPlan.png). */
export function PlanCard({ approval: a, agents }: { approval: Approval; agents: AgentDef[] }) {
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const lead = agents.find((x) => x.id === a.agentId)?.name ?? 'The Lead'
  const steps = planSteps(a)
  const send = () => void decide(a, { behavior: 'deny', message: note.trim() || 'Please revise the plan.' })
  return (
    <FloorCard title={`${lead}’s plan is ready`}
      actions={asking ? [{ label: 'Cancel', onClick: () => setAsking(false) }, { label: 'Send', primary: true, onClick: send }]
        : [{ label: 'Request changes', onClick: () => setAsking(true) }, { label: 'Approve plan', primary: true, onClick: () => void decide(a, { behavior: 'allow' }) }]}>
      <span className="fcard-meta">{a.title}</span>
      <ol className="fcard-rows">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="mono fcard-id">{s.taskId ?? i + 1}</span>
            <span className="fcard-row-title">{s.title}</span>
            <span className="muted">{agents.find((x) => x.id === s.agentId)?.name ?? ''}</span>
          </li>
        ))}
      </ol>
      {asking && (
        <input className="fcard-note" aria-label="What should change" placeholder="What should change" autoFocus value={note}
          onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') setAsking(false) }} />
      )}
    </FloorCard>
  )
}

/** An agent asking to use a tool: the command or file, Deny and Approve (FloorNeeds.png). */
export function PermCard({ approval: a, agents }: { approval: Approval; agents: AgentDef[] }) {
  const who = agents.find((x) => x.id === a.agentId)?.name ?? 'An agent'
  const input = (a.input ?? {}) as Record<string, unknown>
  const what = a.toolName === 'Bash' ? String(input.command ?? '') : String(input.file_path ?? input.path ?? a.toolName ?? a.title)
  return (
    <FloorCard title={`${who} needs you`}
      actions={[
        { label: 'Deny', onClick: () => void decide(a, { behavior: 'deny', message: 'Denied in Kernel.' }) },
        { label: 'Approve', primary: true, onClick: () => void decide(a, { behavior: 'allow' }) }
      ]}>
      {what && <p className="mono fcard-cmd">{what}</p>}
    </FloorCard>
  )
}

/** PRs ready to merge, with the way to the board and the Inbox (FloorReview.png). */
export function ReviewCard({ roomId, title, sub }: { roomId: string; title: string; sub: string }) {
  return (
    <FloorCard quiet title={title} sub={sub} icon={<span className="fcard-ok"><Icon name="check" size={13} stroke={1.8} /></span>}
      actions={[
        { label: 'Open board', onClick: () => go({ name: 'board', roomId }) },
        { label: 'Review in Inbox', primary: true, onClick: () => go({ name: 'inbox' }) }
      ]} />
  )
}
