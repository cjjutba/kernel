import { useState } from 'react'
import type { AgentDef, Approval, Decision } from '@shared/types'
import { call } from '../../../api'
import { go, useStore } from '../../../store'
import { attempt } from '../MessageActions'
import { outcome, planSteps } from './steps'
import './cards.css'

const EMPTY: AgentDef[] = []

/** One decision path for every surface: the Inbox and the floor call the same channel, and the push event updates this card. */
const decide = (a: Approval, decision: Decision) => attempt('Could not send your answer', () => call('approvals.decide', { id: a.id, decision }))

function Result({ a }: { a: Approval }) {
  return <span className="done-line">{outcome(a)}</span>
}

function PermCard({ a, who }: { a: Approval; who: string }) {
  const input = (a.input ?? {}) as Record<string, unknown>
  const bash = a.toolName === 'Bash'
  const path = String(input.file_path ?? input.path ?? '')
  const title = bash ? `${who} wants to run a command` : path ? `${who} wants to edit a file` : `${who} wants to use ${a.toolName ?? 'a tool'}`
  const code = bash ? `$ ${String(input.command ?? '')}` : path || (a.input ? JSON.stringify(a.input, null, 2) : '')
  return (
    <section aria-label={title} className="card tcard">
      <h3>{title}</h3>
      {a.detail && <span className="sub">{a.detail}</span>}
      {code && <div className="code">{code}</div>}
      {a.status === 'pending' ? (
        <div className="acts">
          <button type="button" className="btn" onClick={() => void decide(a, { behavior: 'deny', message: 'Denied in Kernel.' })}>Deny</button>
          <button type="button" className="btn" onClick={() => void decide(a, { behavior: 'allow', always: true })}>Always allow here</button>
          <button type="button" className="btn primary" onClick={() => void decide(a, { behavior: 'allow' })}>Allow once</button>
        </div>
      ) : <Result a={a} />}
    </section>
  )
}

function QuestionCard({ a, who }: { a: Approval; who: string }) {
  const [other, setOther] = useState(false)
  const [text, setText] = useState('')
  const send = () => text.trim() && void decide(a, { behavior: 'answer', text: text.trim() })
  return (
    <section aria-label={`${who} has a question`} className="card tcard">
      <h3>{`${who} has a question`}</h3>
      <span className="sub">{a.title}</span>
      {a.status === 'pending' ? (
        <>
          <div className="opts">
            {(a.options ?? []).map((o, i) => (
              <button key={o} type="button" className="opt" onClick={() => void decide(a, { behavior: 'answer', text: o })}><span className="n mono">{i + 1}</span>{o}</button>
            ))}
            <button type="button" className="opt" aria-expanded={other} onClick={() => setOther(true)}><span className="n mono">{(a.options?.length ?? 0) + 1}</span>Something else</button>
          </div>
          {other && (
            <div className="acts" style={{ flexWrap: 'nowrap' }}>
              <input className="grow-input" aria-label="Your answer" placeholder="Type your answer" autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
              <button type="button" className="btn primary" disabled={!text.trim()} onClick={send}>Send</button>
            </div>
          )}
        </>
      ) : <Result a={a} />}
    </section>
  )
}

/** Approve with one click. "Request changes" opens a note and sends it back as the reason. */
function ChangesNote({ onSend, onCancel }: { onSend: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('')
  return (
    <div className="acts" style={{ flexWrap: 'nowrap' }}>
      <input className="grow-input" aria-label="What should change" placeholder="What should change" autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSend(note.trim()); if (e.key === 'Escape') onCancel() }} />
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn primary" onClick={() => onSend(note.trim())}>Send</button>
    </div>
  )
}

function PlanCard({ a, agents, lead }: { a: Approval; agents: AgentDef[]; lead: boolean }) {
  const [asking, setAsking] = useState(false)
  const tasks = useStore((s) => (a.roomId ? s.tasks[a.roomId] : undefined))
  const steps = planSteps(a)
  const open = (workspaceId: string) => go({ name: 'workspace', workspaceId })
  return (
    <section aria-label={a.title} className="card tcard">
      <h3>{a.title}</h3>
      <ol className="steps">
        {steps.map((s, i) => {
          const who = agents.find((x) => x.id === s.agentId)?.name
          const ws = s.workspaceId ?? (s.taskId ? tasks?.find((t) => t.id === s.taskId)?.workspaceId : undefined)
          return (
            <li key={i}>
              <span className="n mono">{i + 1}</span>
              <span>{who ? `${s.title} · ${who}` : s.title}</span>
              {a.status === 'allowed' && ws && <button type="button" className="open" aria-label={`Open ${who ?? 'the'} workspace for ${s.title}`} onClick={() => open(ws)}>Open workspace</button>}
            </li>
          )
        })}
      </ol>
      {a.status !== 'pending' ? <Result a={a} /> : asking ? (
        <ChangesNote onCancel={() => setAsking(false)} onSend={(note) => void decide(a, { behavior: 'deny', message: note || 'Please revise the plan.' })} />
      ) : (
        <div className="acts">
          <button type="button" className="btn" onClick={() => setAsking(true)}>{lead ? 'Request changes' : 'Keep planning'}</button>
          <button type="button" className="btn primary" onClick={() => void decide(a, { behavior: 'allow' })}>{lead ? 'Approve and hand off' : 'Approve and build'}</button>
        </div>
      )}
    </section>
  )
}

function HireCard({ a }: { a: Approval }) {
  const [asking, setAsking] = useState(false)
  const file = a.agentFile
  if (!file) return null
  return (
    <section aria-label={file.path} className="card tcard">
      <h3>{file.path}</h3>
      <div className="code">{file.text}</div>
      {a.status !== 'pending' ? <Result a={a} /> : asking ? (
        <ChangesNote onCancel={() => setAsking(false)} onSend={(note) => void decide(a, { behavior: 'deny', message: note || 'Please change the agent file.' })} />
      ) : (
        <div className="acts">
          <button type="button" className="btn" onClick={() => setAsking(true)}>Edit file</button>
          <button type="button" className="btn primary" onClick={() => void decide(a, { behavior: 'allow' })}>Create agent</button>
        </div>
      )}
    </section>
  )
}

/** The card for one approval, by kind (WorkspacePerm, Plan, Question, Hire, Lead). */
export function ApprovalCard({ approval: a }: { approval: Approval }) {
  const agents = useStore((s) => (a.roomId ? s.agents[a.roomId] : undefined)) ?? EMPTY
  const agent = agents.find((x) => x.id === a.agentId)
  const who = agent?.name ?? 'An agent'
  if (a.kind === 'agent' || a.agentFile) return <HireCard a={a} />
  if (a.kind === 'plan' || a.toolName === 'ExitPlanMode') return <PlanCard a={a} agents={agents} lead={!!agent?.lead} />
  if (a.kind === 'question') return <QuestionCard a={a} who={who} />
  return <PermCard a={a} who={who} />
}
