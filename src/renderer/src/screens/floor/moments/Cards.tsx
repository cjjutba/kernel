import { useState } from 'react'
import type { AgentDef, Approval, Decision, Overlap, Workspace } from '@shared/types'
import { call } from '../../../api'
import { actions, go } from '../../../store'
import { FloorCard } from '../FloorCard'
import { NUMBERS, cap, fileName, names } from './moments'
import './moments.css'

const failed = (title: string) => (e: Error) => actions.ui.toast({ title, sub: e.message })
const decide = (a: Approval, decision: Decision) => call('approvals.decide', { id: a.id, decision }).catch(failed('Could not send your answer'))

/**
 * An agent's question (AskUserQuestion, or the Lead's `ask_user`): one row per option, and a box when there are none (FloorQuestion.png).
 * It answers through `approvals.decide`, so the chat card, the Inbox and the raised hand all settle from the same event.
 */
export function QuestionCard({ approval: a, agents }: { approval: Approval; agents: AgentDef[] }) {
  const [text, setText] = useState('')
  const who = agents.find((x) => x.id === a.agentId)?.name ?? 'An agent'
  const options = a.options ?? []
  const send = () => text.trim() && void decide(a, { behavior: 'answer', text: text.trim() })
  return (
    <FloorCard title={`${who} has a question`} sub={a.title} actions={[]}>
      {options.length > 0 ? (
        <div className="fopts">
          {options.map((o) => <button key={o} type="button" className="fopt" onClick={() => void decide(a, { behavior: 'answer', text: o })}>{o}</button>)}
        </div>
      ) : (
        <div className="fopts">
          <input className="fcard-note" aria-label="Your answer" placeholder="Type your answer" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
          <button type="button" className="btn primary fopt-send" disabled={!text.trim()} onClick={send}>Send</button>
        </div>
      )}
    </FloorCard>
  )
}

/**
 * Two agents changed the same file in different worktrees (FloorOverlap.png). One row per side with a link to its workspace
 * and the lines it touched. Let the Lead sort it sends both to the Lead and takes the card off the floor.
 */
export function OverlapCard({ overlap: o, roomId, agents, workspaces }: { overlap: Overlap; roomId: string; agents: AgentDef[]; workspaces: Workspace[] }) {
  const lead = agents.find((a) => a.lead)
  const rows = o.parties.map((p) => ({
    ...p, name: agents.find((a) => a.id === p.agentId)?.name ?? p.agentId, ws: workspaces.find((w) => w.id === p.workspaceId)
  }))
  const count = rows.length
  return (
    <FloorCard title={`${cap(NUMBERS[count] ?? String(count))} agents changed the same file`}
      sub={`${names(rows.map((r) => r.name))} edited ${fileName(o.path)} in different worktrees. Merging ${count > 2 ? 'them all' : 'both'} later will conflict.`}
      actions={[
        { label: 'Open board', onClick: () => go({ name: 'board', roomId }) },
        { label: `Let ${lead?.name ?? 'the Lead'} sort it`, primary: true, onClick: () => void call('rooms.resolveOverlap', { overlapId: o.id }).catch(failed('Could not hand that to the Lead')) }
      ]}>
      <div className="fcard-grid mono">
        {rows.map((r) => (
          <div key={r.workspaceId} className="fcard-grid-row">
            <span>{r.name}</span>
            {r.ws
              ? <button type="button" className="fcard-link" aria-label={`Open ${r.name}’s workspace ${r.ws.name}`} onClick={() => go({ name: 'workspace', workspaceId: r.ws!.id })}>{r.ws.name}</button>
              : <span>{r.workspaceId}</span>}
            <span>{r.lines}</span>
          </div>
        ))}
      </div>
    </FloorCard>
  )
}

/** The workspaces behind an overlap's log line: a link to each side. */
export function OverlapLinks({ workspaceIds, workspaces }: { workspaceIds: string[]; workspaces: Workspace[] }) {
  const open = workspaceIds.map((id) => workspaces.find((w) => w.id === id)).filter((w): w is Workspace => !!w)
  if (!open.length) return null
  return (
    <p className="log-links">
      {open.map((w) => <button key={w.id} type="button" className="fcard-link mono" onClick={() => go({ name: 'workspace', workspaceId: w.id })}>{w.name}</button>)}
    </p>
  )
}
