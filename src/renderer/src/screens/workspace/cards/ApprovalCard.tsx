import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentDef, Approval, AskedQuestion, Decision } from '@shared/types'
import { call } from '../../../api'
import { FileLabel } from '../../../components/FileIcon'
import { go, useStore } from '../../../store'
import { Button, Icon, IconButton, useBusy } from '../../../ui'
import { Markdown } from '../markdown'
import { leadingTitle, parseBlocks } from '../mdParse'
import { attempt, useCopy } from '../MessageActions'
import { PlanInline, PlanTasks, planCopyText, stepLine } from './plan'
import { allAnswered, answerDecision, answeredList, emptyPick, isPlanApproval, isStepList, nextUnanswered, outcome, permissionTitle, pickReady, planSteps, planText, type Picked } from './steps'
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
  const title = permissionTitle(a, who)
  const code = bash ? `$ ${String(input.command ?? '')}` : path || (a.input ? JSON.stringify(a.input, null, 2) : '')
  return (
    <section aria-label={title} className="card tcard">
      <h3>{title}</h3>
      {a.detail && <span className="sub">{a.detail}</span>}
      {code && <div className="code">{!bash && path ? <FileLabel path={path} /> : code}</div>}
      {a.reason && <p className="reason"><Icon name="info" size={14} />{a.reason}</p>}
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

/** Run after the next render: puts focus on an element that does not exist yet, such as the box a click is about to open. */
function useFocusNext() {
  const next = useRef<(() => HTMLElement | null | undefined) | null>(null)
  useEffect(() => {
    const find = next.current
    next.current = null
    find?.()?.focus()
  })
  return (find: () => HTMLElement | null | undefined) => { next.current = find }
}

/**
 * The Something else row once it is on: a text box inside the row, as tall as its text up to four lines, then it
 * scrolls. Enter runs `onEnter`, Shift+Enter adds a line, Escape runs `onEscape`.
 */
function AnswerRow({ mark, value, disabled, onChange, onEnter, onEscape }: { mark: ReactNode; value: string; disabled: boolean; onChange: (text: string) => void; onEnter: () => void; onEscape: () => void }) {
  const box = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onEnter()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onEscape()
    }
  }
  return (
    <div className="qother">
      {mark}
      <textarea ref={box} rows={1} aria-label="Your answer" placeholder="Type your answer" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} onKeyDown={keys} />
    </div>
  )
}

/** One question that is no longer waiting: what was asked, and what you said or how it ended. */
function AnsweredQuestion({ a, who }: { a: Approval; who: string }) {
  const title = `${who} has a question`
  return (
    <section aria-label={title} className="card tcard">
      <h3>{title}</h3>
      <span className="sub">{a.title}</span>
      <Result a={a} />
    </section>
  )
}

/** Several questions answered, each with what you said (WorkspaceQuestionAnswers.png). */
function AnsweredQuestions({ who, list }: { who: string; list: { question: string; answer: string }[] }) {
  const title = `You answered ${who}\u2019s ${list.length} questions`
  return (
    <section aria-label={title} className="card tcard">
      <h3>{title}</h3>
      <ol className="qans">
        {list.map((r, i) => (
          <li key={i}>
            <span className="n mono">{i + 1}</span>
            <span className="qans-text"><span className="qans-q">{r.question}</span><span>{r.answer}</span></span>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** An approval from before questions were kept has only a title and its options: one single-select question. */
const askedQuestions = (a: Approval): AskedQuestion[] => a.questions?.length ? a.questions : [{ question: a.title, options: (a.options ?? []).map((label) => ({ label })) }]

/**
 * Every pending question (WorkspaceQuestion.png, WorkspaceQuestionLong.png, WorkspaceQuestionSteps.png). One question has no
 * tabs and no Back: you pick a row, then press Send. Several get a tab per question, which jumps between them with the answers
 * kept; a single-select row records its answer and moves to the next question without one, and a multi-select one ticks rows.
 * Nothing is sent until every question has an answer and Send is pressed. Number keys pick a row and Enter sends.
 */
function QuestionSteps({ a, who }: { a: Approval; who: string }) {
  const qs = useMemo(() => askedQuestions(a), [a])
  const [step, setStep] = useState(0)
  const [picks, setPicks] = useState<Picked[]>(() => qs.map(emptyPick))
  const [busy, run] = useBusy()
  const group = useRef<HTMLDivElement>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const focusNext = useFocusNext()
  const q = qs[step]
  if (!q) return null
  const p = picks[step] ?? emptyPick()
  const many = qs.length > 1
  const multi = !!q.multiSelect
  const done = allAnswered(picks)
  const change = (patch: Partial<Picked>, from = picks) => from.map((x, i) => (i === step ? { ...x, ...patch } : x))
  // Back, Next and a pick put focus on the first option of the question they land on, so the keyboard carries on.
  const firstOption = () => group.current?.querySelector<HTMLElement>('button')
  const move = (to: number) => {
    setStep(to)
    focusNext(firstOption)
  }
  const jump = (to: number, focusTab = false) => {
    setStep(to)
    if (focusTab) focusNext(() => tabs.current?.querySelectorAll<HTMLElement>('button')[to])
  }
  const primary = () => {
    if (!pickReady(p) || busy !== null) return
    if (done) return void run('send', () => decide(a, answerDecision(qs, picks)))
    const to = nextUnanswered(picks, step)
    if (to >= 0) move(to)
  }
  const row = (i: number) => group.current?.querySelectorAll<HTMLElement>('.qrow')[i]
  const choose = (label: string, i: number) => {
    if (multi) return setPicks(change({ sel: p.sel.includes(label) ? p.sel.filter((l) => l !== label) : [...p.sel, label] }))
    const ps = change({ sel: [label], other: false })
    setPicks(ps)
    const to = nextUnanswered(ps, step)
    // With nothing left to answer, focus stays on the picked row so Enter sends it.
    if (to >= 0) move(to)
    else focusNext(() => row(i))
  }
  const openOther = () => {
    setPicks(change(multi ? { other: true } : { other: true, sel: [] }))
    focusNext(() => group.current?.querySelector('textarea'))
  }
  const closeOther = () => {
    setPicks(change({ other: false }))
    focusNext(() => group.current?.querySelector('[data-other]'))
  }
  const arrows = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = e.key === 'ArrowLeft' ? step - 1 : e.key === 'ArrowRight' ? step + 1 : step
    if (to === step || to < 0 || to >= qs.length) return
    e.preventDefault()
    jump(to, true)
  }
  // Number keys pick the row with that number. Enter sends once an answer is picked, from the picked row or from anywhere in the card
  // that is not another button. A button keeps its own Enter, and the Something else box handles its own keys.
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    const el = e.target as HTMLElement
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || el.closest('textarea, input') || busy !== null) return
    if (e.key === 'Enter') {
      const sendable = !el.closest('button') || (!multi && el.getAttribute('aria-checked') === 'true')
      if (!sendable || !pickReady(p)) return
      e.preventDefault()
      return primary()
    }
    if (multi || !/^[1-9]$/.test(e.key)) return
    const i = Number(e.key) - 1
    if (i < q.options.length) {
      e.preventDefault()
      choose(q.options[i].label, i)
    } else if (i === q.options.length && !p.other) {
      e.preventDefault()
      openOther()
    }
  }
  const title = many ? `${who} has ${qs.length} questions` : `${who} has a question`
  const rows = q.options.length

  return (
    <section aria-label={title} className="card tcard" onKeyDown={keys}>
      <h3>{title}</h3>
      {many && (
        <div ref={tabs} className="qtabs" role="group" aria-label="Questions" onKeyDown={arrows}>
          {qs.map((x, i) => {
            const label = x.header?.trim() || `Question ${i + 1}`
            const answered = pickReady(picks[i] ?? emptyPick())
            return (
              <button key={i} type="button" className="qtab" tabIndex={i === step ? 0 : -1} aria-current={i === step ? 'step' : undefined} aria-label={answered ? `${label}, answered` : label} disabled={busy !== null} onClick={() => jump(i)}>
                {answered && i !== step && <Icon name="check" size={12} />}{label}
              </button>
            )
          })}
        </div>
      )}
      <span className="sub">{q.question}{multi ? ' Choose all that apply.' : ''}</span>
      <div ref={group} role={multi ? 'group' : 'radiogroup'} aria-label={many ? `Question ${step + 1} of ${qs.length}: ${q.question}` : q.question} className="qrows">
        {q.options.map((o, i) => {
          const on = p.sel.includes(o.label)
          const body = (
            <span className="qtext">
              <span className="qlabel">{o.label}{o.recommended && <span className="qtag">Recommended</span>}</span>
              {o.description && <span className="qdesc">{o.description}</span>}
            </span>
          )
          return multi ? (
            <button key={o.label} type="button" role="checkbox" aria-checked={on} className="qrow" data-desc={!!o.description} disabled={busy !== null} onClick={() => choose(o.label, i)}>
              <span className="qbox" aria-hidden="true">{on && <Icon name="check" size={11} />}</span>{body}
            </button>
          ) : (
            <button key={o.label} type="button" role="radio" aria-checked={on} className="qrow" data-desc={!!o.description} disabled={busy !== null} onClick={() => choose(o.label, i)}>
              <span className="n mono">{i + 1}</span>{body}
            </button>
          )
        })}
        {p.other ? (
          <AnswerRow
            mark={multi ? <button type="button" className="qbox" aria-label="Remove Something else" disabled={busy !== null} onClick={closeOther}><Icon name="check" size={11} /></button> : <span className="n mono">{rows + 1}</span>}
            value={p.text} disabled={busy !== null} onChange={(text) => setPicks(change({ text }))} onEnter={primary} onEscape={closeOther}
          />
        ) : multi ? (
          <button type="button" role="checkbox" aria-checked={false} className="qrow" data-other disabled={busy !== null} onClick={openOther}>
            <span className="qbox" aria-hidden="true" /><span className="qtext"><span>Something else</span></span>
          </button>
        ) : (
          <button type="button" role="radio" aria-checked={false} className="qrow" data-other disabled={busy !== null} onClick={openOther}>
            <span className="n mono">{rows + 1}</span><span className="qtext"><span>Something else</span></span>
          </button>
        )}
      </div>
      <div className="acts">
        {step > 0 && <Button disabled={busy !== null} onClick={() => move(step - 1)}>Back</Button>}
        <Button variant="primary" busy={busy === 'send'} busyLabel="Sending" disabled={!pickReady(p) || busy !== null} onClick={primary}>{many && !done ? 'Next' : 'Send'}</Button>
      </div>
    </section>
  )
}

function QuestionCard({ a, who }: { a: Approval; who: string }) {
  const list = answeredList(a)
  if (a.status !== 'pending' && list) return <AnsweredQuestions who={who} list={list} />
  return a.status === 'pending' ? <QuestionSteps a={a} who={who} /> : <AnsweredQuestion a={a} who={who} />
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
 * A plan with a write-up as a card, in the Inbox, which has no composer to decide from: its opening heading as the title, the
 * rest as markdown, then the Lead's task rows, and the file Kernel saved it to (D-092). A long one that is already decided folds.
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
        {!!a.steps?.length && <PlanTasks a={a} agents={agents} />}
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
      <h3><FileLabel path={file.path} size={16} /></h3>
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
