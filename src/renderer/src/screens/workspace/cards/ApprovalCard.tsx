import { useId, useMemo, useState } from 'react'
import type { AgentDef, Approval, Decision } from '@shared/types'
import { call } from '../../../api'
import { go, useStore } from '../../../store'
import { Button, Icon, IconButton, useBusy } from '../../../ui'
import { Markdown } from '../markdown'
import { leadingTitle, parseBlocks } from '../mdParse'
import { attempt } from '../MessageActions'
import { PlanInline, planCopyText, stepLine, useCopy } from './plan'
import { isPlanApproval, isStepList, outcome, planSteps, planText } from './steps'
import './cards.css'

const EMPTY: AgentDef[] = []

/** One decision path for every surface: the Inbox and the floor call the same channel, and the push event updates this card. */
const decide = (a: Approval, decision: Decision) => attempt('Could not send your answer', () => call('approvals.decide', { id: a.id, decision }))

function Result({ a }: { a: Approval }) {
  return <span className="done-line">{outcome(a)}</span>
}

function PermCard({ a, who }: { a: Approval; who: string }) {
  const [busy, run] = useBusy<'deny' | 'always' | 'once'>()
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
          <Button busy={busy === 'deny'} busyLabel="Denying" disabled={busy !== null} onClick={() => void run('deny', () => decide(a, { behavior: 'deny', message: 'Denied in Kernel.' }))}>Deny</Button>
          <Button busy={busy === 'always'} busyLabel="Allowing" disabled={busy !== null} onClick={() => void run('always', () => decide(a, { behavior: 'allow', always: true }))}>Always allow here</Button>
          <Button variant="primary" busy={busy === 'once'} busyLabel="Allowing" disabled={busy !== null} onClick={() => void run('once', () => decide(a, { behavior: 'allow' }))}>Allow once</Button>
        </div>
      ) : <Result a={a} />}
    </section>
  )
}

function QuestionCard({ a, who }: { a: Approval; who: string }) {
  const [other, setOther] = useState(false)
  const [text, setText] = useState('')
  const [busy, run] = useBusy()
  const answer = (key: string, reply: string) => void run(key, () => decide(a, { behavior: 'answer', text: reply }))
  const send = () => text.trim() && answer('text', text.trim())
  return (
    <section aria-label={`${who} has a question`} className="card tcard">
      <h3>{`${who} has a question`}</h3>
      <span className="sub">{a.title}</span>
      {a.status === 'pending' ? (
        <>
          <div className="opts">
            {(a.options ?? []).map((o, i) => (
              <button key={o} type="button" className="opt" disabled={busy !== null} aria-busy={busy === String(i) || undefined} onClick={() => answer(String(i), o)}>{busy === String(i) ? <span className="spin" aria-hidden="true" /> : <span className="n mono">{i + 1}</span>}{o}</button>
            ))}
            <button type="button" className="opt" aria-expanded={other} disabled={busy !== null} onClick={() => setOther(true)}><span className="n mono">{(a.options?.length ?? 0) + 1}</span>Something else</button>
          </div>
          {other && (
            <div className="acts" style={{ flexWrap: 'nowrap' }}>
              <input className="grow-input" aria-label="Your answer" placeholder="Type your answer" autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
              <Button variant="primary" busy={busy === 'text'} busyLabel="Sending" disabled={!text.trim() || busy !== null} onClick={send}>Send</Button>
            </div>
          )}
        </>
      ) : <Result a={a} />}
    </section>
  )
}

/** Approve with one click. "Request changes" opens a note and sends it back as the reason. */
function ChangesNote({ onSend, onCancel }: { onSend: (note: string) => Promise<unknown>; onCancel: () => void }) {
  const [note, setNote] = useState('')
  const [busy, run] = useBusy()
  const send = () => void run('send', () => onSend(note.trim()))
  return (
    <div className="acts" style={{ flexWrap: 'nowrap' }}>
      <input className="grow-input" aria-label="What should change" placeholder="What should change" autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') onCancel() }} />
      <Button disabled={!!busy} onClick={onCancel}>Cancel</Button>
      <Button variant="primary" busy={!!busy} busyLabel="Sending" onClick={send}>Send</Button>
    </div>
  )
}

/** A long plan folds to its first screen once it is decided. One still waiting stays open, since you read it to decide. */
const LONG_PLAN_LINES = 28

/** Copy and Open in editor on the Inbox's plan card. Open asks main for the file, which it writes again if it was deleted (D-092). */
function PlanTools({ a, agents }: { a: Approval; agents: AgentDef[] }) {
  const [copied, copy] = useCopy(planCopyText(a, agents))
  const file = !!a.workspaceId && !!planText(a).trim()
  const open = () => void attempt('Could not open the plan', async () => { await call('system.openInEditor', { path: (await call('approvals.planFile', { id: a.id })).path }) })
  return (
    <div className="pcard-tools">
      <IconButton icon={copied ? 'check' : 'copy'} size={14} label={copied ? 'Copied' : 'Copy plan'} onClick={copy} />
      {file && <IconButton icon="ext" size={14} label="Open in editor" onClick={open} />}
    </div>
  )
}

/** Approve, or say what should change. The words depend on who planned: the Lead hands off, anyone else builds. */
function PlanDecision({ a, lead }: { a: Approval; lead: boolean }) {
  const [asking, setAsking] = useState(false)
  const [busy, run] = useBusy()
  if (a.status !== 'pending') return <Result a={a} />
  if (asking) return <ChangesNote onCancel={() => setAsking(false)} onSend={(note) => decide(a, { behavior: 'deny', message: note || 'Please revise the plan.' })} />
  return (
    <div className="acts">
      <Button disabled={!!busy} onClick={() => setAsking(true)}>{lead ? 'Request changes' : 'Keep planning'}</Button>
      <Button variant="primary" busy={!!busy} busyLabel="Approving" onClick={() => void run('approve', () => decide(a, { behavior: 'allow' }))}>{lead ? 'Approve and hand off' : 'Approve and build'}</Button>
    </div>
  )
}

/** A short plan as numbered rows, in the Inbox: the Lead's task list, or a plan-mode plan that is one list. */
function PlanSteps({ a, agents, lead }: { a: Approval; agents: AgentDef[]; lead: boolean }) {
  const tasks = useStore((s) => (a.roomId ? s.tasks[a.roomId] : undefined))
  const steps = planSteps(a)
  const open = (workspaceId: string) => go({ name: 'workspace', workspaceId })
  return (
    <section aria-label={a.title} className="card tcard">
      <div className="pcard-row">
        <h3>{a.title}</h3>
        <PlanTools a={a} agents={agents} />
      </div>
      <ol className="steps">
        {steps.map((s, i) => {
          const who = agents.find((x) => x.id === s.agentId)?.name
          const ws = s.workspaceId ?? (s.taskId ? tasks?.find((t) => t.id === s.taskId)?.workspaceId : undefined)
          return (
            <li key={i}>
              <span className="n mono">{i + 1}</span>
              <span>{stepLine(s, agents)}</span>
              {a.status === 'allowed' && ws && <button type="button" className="open" aria-label={`Open ${who ?? 'the'} workspace for ${s.title}`} onClick={() => open(ws)}>Open workspace</button>}
            </li>
          )
        })}
      </ol>
      <PlanDecision a={a} lead={lead} />
    </section>
  )
}

/**
 * A plan-mode plan as a card, in the Inbox, which has no composer to decide from: its opening heading as the title, the
 * rest as markdown, and the file Kernel saved it to (D-092). A long one that is already decided folds.
 */
function PlanDoc({ a, agents, lead }: { a: Approval; agents: AgentDef[]; lead: boolean }) {
  const text = planText(a)
  const blocks = useMemo(() => parseBlocks(text), [text])
  const heading = leadingTitle(blocks)
  const long = text.split('\n').length > LONG_PLAN_LINES
  const [open, setOpen] = useState(() => !long || a.status === 'pending')
  const bodyId = useId()
  const title = heading ?? a.title
  return (
    <section aria-label={title} className="card tcard pcard">
      <div className="pcard-head">
        <span className="pcard-kicker"><Icon name="doc" size={13} />Plan</span>
        {a.planFile && <span className="pcard-file mono ellipsis" title={a.planFile}>{a.planFile}</span>}
        <PlanTools a={a} agents={agents} />
      </div>
      <h3>{title}</h3>
      <div id={bodyId} className="pcard-body selectable" data-folded={long && !open ? 'true' : undefined}>
        <Markdown blocks={heading ? blocks.slice(1) : blocks} />
      </div>
      {long && (
        <button type="button" className="pcard-more" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          <span className="chev" data-open={open}><Icon name="right" size={12} /></span>{open ? 'Show less' : 'Show full plan'}
        </button>
      )}
      <div className="pcard-foot"><PlanDecision a={a} lead={lead} /></div>
    </section>
  )
}

function PlanCard({ a, agents, lead }: { a: Approval; agents: AgentDef[]; lead: boolean }) {
  return isStepList(a) ? <PlanSteps a={a} agents={agents} lead={lead} /> : <PlanDoc a={a} agents={agents} lead={lead} />
}

function HireCard({ a }: { a: Approval }) {
  const [asking, setAsking] = useState(false)
  const [busy, run] = useBusy()
  const file = a.agentFile
  if (!file) return null
  return (
    <section aria-label={file.path} className="card tcard">
      <h3>{file.path}</h3>
      <div className="code">{file.text}</div>
      {a.status !== 'pending' ? <Result a={a} /> : asking ? (
        <ChangesNote onCancel={() => setAsking(false)} onSend={(note) => decide(a, { behavior: 'deny', message: note || 'Please change the agent file.' })} />
      ) : (
        <div className="acts">
          <Button disabled={!!busy} onClick={() => setAsking(true)}>Edit file</Button>
          <Button variant="primary" busy={!!busy} busyLabel="Creating" onClick={() => void run('create', () => decide(a, { behavior: 'allow' }))}>Create agent</Button>
        </div>
      )}
    </section>
  )
}

/** The card for one approval, by kind (WorkspacePerm, Plan, Question, Hire, Lead). `inChat` is set in a transcript, where a composer sits below. */
export function ApprovalCard({ approval: a, inChat }: { approval: Approval; inChat?: boolean }) {
  const agents = useStore((s) => (a.roomId ? s.agents[a.roomId] : undefined)) ?? EMPTY
  const agent = agents.find((x) => x.id === a.agentId)
  const who = agent?.name ?? 'An agent'
  if (a.kind === 'agent' || a.agentFile) return <HireCard a={a} />
  if (isPlanApproval(a)) return inChat ? <PlanInline a={a} agents={agents} /> : <PlanCard a={a} agents={agents} lead={!!agent?.lead} />
  if (a.kind === 'question') return <QuestionCard a={a} who={who} />
  return <PermCard a={a} who={who} />
}
