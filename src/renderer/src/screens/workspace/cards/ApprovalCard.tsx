import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentDef, Approval, AskedQuestion, Decision } from '@shared/types'
import { call } from '../../../api'
import { FileLabel } from '../../../components/FileIcon'
import { go, useStore } from '../../../store'
import { AgentAvatar, Button, CopyButton, Icon, IconButton, useBusy } from '../../../ui'
import { Markdown } from '../markdown'
import { HireServers, hireName } from './HireServers'
import { leadingTitle, parseBlocks } from '../mdParse'
import { attempt } from '../MessageActions'
import { decideAtOnce, useFoldPhase } from './decideFold'
import { decideInChat } from './optimisticAnswer'
import { Criteria, PlanInline, PlanTasks, planCopyText, stepLine } from './plan'
import { AnswerBubble } from './AnswerBubble'
import { answerItemId, answeredList, questionAnswer } from '@shared/approvalAnswer'
import { activeRow, rowStep } from './questionRows'
import { allAnswered, answerDecision, emptyPick, isPlanApproval, isStepList, nextUnanswered, outcome, isPermission, permissionQueue, permissionTitle, pickReady, queueTitle, planSteps, planText, type Picked } from './steps'
import './cards.css'

const EMPTY: AgentDef[] = []

/** One decision path for every surface: the Inbox and the chat call the same channel, and the push event updates this card. */
const decide = (a: Approval, decision: Decision) => attempt('Could not send your answer', () => call('approvals.decide', { id: a.id, decision }))

/** The chat card's head: the agent's avatar and a title (DESIGN.md, Chat cards). `aside` sits at the right, such as "Answered". */
function CardHead({ who, title, aside }: { who: string; title: string; aside?: ReactNode }) {
  return <div className="tc-head"><AgentAvatar name={who} size={18} /><h3>{title}</h3>{aside}</div>
}

function Result({ a }: { a: Approval }) {
  return <span className="done-line">{outcome(a)}</span>
}

/** The pager in a card's head: "‹ 2 of 3 ›". The question card and the permission queue both use it. */
function Pager({ label, at, count, busy, onMove, pagerRef, onKeyDown }: { label: string; at: number; count: number; busy?: boolean; onMove: (to: number) => void; pagerRef?: React.Ref<HTMLDivElement>; onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void }) {
  return (
    <div ref={pagerRef} className="tc-pager" role="group" aria-label={label} onKeyDown={onKeyDown}>
      <button type="button" className="tc-page" aria-label={`Show ${label.toLowerCase().replace(/s$/, '')} ${at}`} disabled={at === 0 || busy} onClick={() => onMove(at - 1)}><Icon name="chevron" size={14} /></button>
      <span aria-live="polite">{at + 1} of {count}</span>
      <button type="button" className="tc-page" data-next aria-label={`Show ${label.toLowerCase().replace(/s$/, '')} ${at + 2}`} disabled={at === count - 1 || busy} onClick={() => onMove(at + 1)}><Icon name="chevron" size={14} /></button>
    </div>
  )
}

/** The permissions waiting in this chat and which one the card shows. Moving is a press on the pager, never a timer. */
type PermQueue = { items: Approval[]; at: number; onMove: (to: number) => void }

function PermCard({ a, who, queue }: { a: Approval; who: string; queue?: PermQueue }) {
  const phase = useFoldPhase(a.id)
  const input = (a.input ?? {}) as Record<string, unknown>
  const bash = a.toolName === 'Bash'
  const path = String(input.file_path ?? input.path ?? '')
  const decided = a.status !== 'pending'
  // Once it is decided the card says what was asked in the past tense, and what you did.
  const title = queue ? queueTitle(queue.items, who) : decided ? permissionTitle(a, who).replace(' wants to ', ' wanted to ') : permissionTitle(a, who)
  const code = bash ? `$ ${String(input.command ?? '')}` : path || (a.input ? JSON.stringify(a.input, null, 2) : '')
  return (
    <section aria-label={title} className="card tcard">
      <CardHead who={who} title={title} aside={queue && <Pager label="Permissions" at={queue.at} count={queue.items.length} onMove={queue.onMove} />} />
      <div className="tc-body">
        {a.detail && <span className="sub">{a.detail}</span>}
        {code && <div className="code">{!bash && path ? <FileLabel path={path} /> : code}</div>}
        {a.reason && !decided && <p className="reason"><Icon name="info" size={12} />{a.reason}</p>}
        {decided && phase !== 'folding' && <span className="done-line">{a.status === 'allowed' ? 'You allowed it' : a.status === 'denied' ? 'You denied it' : outcome(a)}</span>}
      </div>
      {phase === 'folded' && a.status === 'pending' ? null : (a.status === 'pending' || phase === 'folding') && (
        <div className={`tc-foot${phase ? ' decide-fold' : ''}`}>
          <Button onClick={() => decideAtOnce(a, { behavior: 'deny', message: 'Denied in Kernel.' })}>Deny</Button>
          <span className="grow" />
          <Button onClick={() => decideAtOnce(a, { behavior: 'allow', always: true })}>Always allow here</Button>
          <Button variant="primary" aria-keyshortcuts="Meta+Enter" onClick={() => decideAtOnce(a, { behavior: 'allow' })}>Allow once<span className="tc-kbd" aria-hidden="true">⌘↵</span></Button>
        </div>
      )}
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

/**
 * One question that is no longer waiting: what was asked. Your answer is a bubble inside the card, or, when the chat holds it as its own message, the bubble under it
 * (`answer` is the text for the first and nothing for the second). A question that ended unanswered says how.
 */
function AnsweredQuestion({ a, who, answered, answer }: { a: Approval; who: string; answered: boolean; answer?: string }) {
  const title = `${who} has a question`
  return (
    <section aria-label={title} className="card tcard">
      <CardHead who={who} title={`${who} asked`} aside={answered && <span className="tc-aside">Answered</span>} />
      <div className="tc-body">
        <span className="sub">{a.title}</span>
        {!answered && <Result a={a} />}
        {answer && <AnswerBubble text={answer} />}
      </div>
    </section>
  )
}

/** Several questions that are no longer waiting: each as it was asked, with your answer under it. */
function AnsweredQuestions({ who, rows }: { who: string; rows: { question: string; answer?: string }[] }) {
  const title = `${who} asked ${rows.length} questions`
  return (
    <section aria-label={title} className="card tcard">
      <CardHead who={who} title={`${who} asked`} aside={<span className="tc-aside">Answered</span>} />
      <div className="qdone tc-body">
        {rows.map((r, i) => (
          <div key={i} className="qdone-row">
            <span className="qdone-q">{r.question}</span>
            {r.answer && <span className="qdone-a"><span aria-hidden="true">↳</span>{r.answer}</span>}
          </div>
        ))}
      </div>
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
  const [cursor, setCursor] = useState<{ step: number; at: number } | null>(null)
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
    if (focusTab) focusNext(() => tabs.current?.querySelector<HTMLElement>(to > step ? '[data-next]:not(:disabled), button:not(:disabled)' : 'button:not(:disabled)'))
  }
  const primary = () => {
    if (!pickReady(p) || busy !== null) return
    if (done) return void run('send', () => decideInChat(a, answerDecision(qs, picks)))
    const to = nextUnanswered(picks, step)
    if (to >= 0) move(to)
  }
  const rowButtons = () => [...(group.current?.querySelectorAll<HTMLElement>('button.qrow') ?? [])]
  const row = (i: number) => rowButtons()[i]
  const rowArrows = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !el.matches('button.qrow')) return
    const all = rowButtons()
    const to = rowStep(e.key, all.indexOf(el), all.length)
    if (to < 0) return
    e.preventDefault()
    all[to]?.focus()
  }
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
    if (e.defaultPrevented || e.ctrlKey || e.altKey || busy !== null) return
    // ⌘↵ sends from anywhere in the card, the Something else box included.
    if (e.metaKey && e.key === 'Enter') {
      if (!pickReady(p)) return
      e.preventDefault()
      return primary()
    }
    if (e.metaKey || el.closest('textarea, input')) return
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
  const rowCount = rows + (p.other ? 0 : 1)
  const active = activeRow(cursor?.step === step ? cursor.at : null, q.options.findIndex((o) => p.sel.includes(o.label)), rowCount)
  const rowFocus = (at: number) => () => setCursor({ step, at })

  return (
    <section aria-label={title} className="card tcard" onKeyDown={keys}>
      <CardHead who={who} title={title} aside={many && <Pager label="Questions" at={step} count={qs.length} busy={busy !== null} pagerRef={tabs} onKeyDown={arrows} onMove={(to) => jump(to, true)} />} />
      <div className="tc-body">
        <span className="sub">{q.question}{multi ? ' Choose all that apply.' : ''}</span>
        {!many && a.detail && <div className="code">{a.detail}</div>}
      </div>
      <div ref={group} role={multi ? 'group' : 'radiogroup'} aria-label={many ? `Question ${step + 1} of ${qs.length}: ${q.question}` : q.question} className="qrows" onKeyDown={rowArrows}>
        {q.options.map((o, i) => {
          const on = p.sel.includes(o.label)
          const body = (
            <span className="qtext">
              <span className="qlabel">{o.label}{o.recommended && <span className="qtag">Recommended</span>}</span>
              {o.description && <span className="qdesc">{o.description}</span>}
            </span>
          )
          return multi ? (
            <button key={o.label} type="button" role="checkbox" aria-checked={on} className="qrow" tabIndex={i === active ? 0 : -1} onFocus={rowFocus(i)} data-desc={!!o.description} disabled={busy !== null} onClick={() => choose(o.label, i)}>
              <span className="qbox" aria-hidden="true">{on && <Icon name="check" size={12} />}</span>{body}
            </button>
          ) : (
            <button key={o.label} type="button" role="radio" aria-checked={on} className="qrow" tabIndex={i === active ? 0 : -1} onFocus={rowFocus(i)} data-desc={!!o.description} disabled={busy !== null} onClick={() => choose(o.label, i)}>
              <span className="n mono">{i + 1}</span>{body}
            </button>
          )
        })}
        {p.other ? (
          <AnswerRow
            mark={multi ? <button type="button" className="qbox" aria-label="Remove Something else" disabled={busy !== null} onClick={closeOther}><Icon name="check" size={12} /></button> : <span className="n mono">{rows + 1}</span>}
            value={p.text} disabled={busy !== null} onChange={(text) => setPicks(change({ text }))} onEnter={primary} onEscape={closeOther}
          />
        ) : multi ? (
          <button type="button" role="checkbox" aria-checked={false} className="qrow" tabIndex={rows === active ? 0 : -1} onFocus={rowFocus(rows)} data-other disabled={busy !== null} onClick={openOther}>
            <span className="qbox" aria-hidden="true" /><span className="qtext"><span>Something else</span></span>
          </button>
        ) : (
          <button type="button" role="radio" aria-checked={false} className="qrow" tabIndex={rows === active ? 0 : -1} onFocus={rowFocus(rows)} data-other disabled={busy !== null} onClick={openOther}>
            <span className="n mono">{rows + 1}</span><span className="qtext"><span>Something else</span></span>
          </button>
        )}
      </div>
      <div className="tc-foot">
        {!multi && <span className="tc-hint">{rowCount > 1 ? `Press 1 to ${Math.min(rowCount, 9)} to pick` : 'Press 1 to pick'}</span>}
        {step > 0 && <Button variant="ghost" disabled={busy !== null} onClick={() => move(step - 1)}>Back</Button>}
        {many && step < qs.length - 1 && <Button variant="ghost" disabled={busy !== null} onClick={() => move(step + 1)}>Skip</Button>}
        <Button variant="primary" aria-keyshortcuts="Meta+Enter" busy={busy === 'send'} busyPattern="ripple" busyLabel="Sending" disabled={!pickReady(p) || busy !== null} onClick={primary}>{many && !done ? 'Next' : many ? 'Send answers' : 'Send'}<span className="tc-kbd" aria-hidden="true">⌘↵</span></Button>
      </div>
    </section>
  )
}

function QuestionCard({ a, who, inChat, hasItem }: { a: Approval; who: string; inChat?: boolean; hasItem?: boolean }) {
  if (a.status === 'pending') return <QuestionSteps a={a} who={who} />
  // The answer is the user's bubble in the card, or the chat's own message under it (KERNEL-838), which only a single question has. Several are listed in the card with their answers.
  // Outside a chat there is no bubble, so a line under the card says it.
  const text = questionAnswer(a)
  const several = (a.questions?.length ?? 0) > 1
  const card = several
    ? <AnsweredQuestions who={who} rows={answeredList(a) ?? (a.questions ?? []).map((q) => ({ question: q.question }))} />
    : <AnsweredQuestion a={a} who={who} answered={!!text} answer={inChat && !hasItem ? text : undefined} />
  return <>{card}{text && !inChat && <span className="done-line">{text.split('\n').join(' · ')}</span>}</>
}

/** Approve with one click. "Request changes" opens a note and sends it back as the reason. */
function ChangesNote({ onSend, onCancel }: { onSend: (note: string) => Promise<unknown>; onCancel: () => void }) {
  const [note, setNote] = useState('')
  const [busy, run] = useBusy()
  const send = () => void run('send', () => onSend(note.trim()))
  return (
    <div className="tc-foot" style={{ flexWrap: 'nowrap' }}>
      <input className="grow-input" aria-label="What should change" placeholder="What should change" autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') onCancel() }} />
      <Button disabled={!!busy} onClick={onCancel}>Cancel</Button>
      <Button variant="primary" busy={!!busy} busyPattern="ripple" busyLabel="Sending" onClick={send}>Send</Button>
    </div>
  )
}

/** A long plan folds to its first screen once it is decided. One still waiting stays open, since you read it to decide. */
const LONG_PLAN_LINES = 28

/** Copy and Open in editor on the Inbox's plan card. Open asks main for the file, which it writes again if it was deleted (D-092). */
function PlanTools({ a, agents }: { a: Approval; agents: AgentDef[] }) {
  const file = !!a.workspaceId && !!planText(a).trim()
  const open = () => void attempt('Could not open the plan', async () => { await call('system.openInEditor', { path: (await call('approvals.planFile', { id: a.id })).path }) })
  return (
    <div className="pcard-tools">
      <CopyButton text={() => planCopyText(a, agents)} label="Copy plan" />
      {file && <IconButton icon="ext" size={14} label="Open in editor" onClick={open} />}
    </div>
  )
}

/** Approve, or say what should change. The words depend on who planned: the Lead hands off, anyone else builds. */
function PlanDecision({ a, lead }: { a: Approval; lead: boolean }) {
  const [asking, setAsking] = useState(false)
  const phase = useFoldPhase(a.id)
  if (phase === 'folded' && a.status === 'pending') return null
  if (a.status !== 'pending' && phase !== 'folding') return <div className="tc-body"><Result a={a} /></div>
  if (asking) return <ChangesNote onCancel={() => setAsking(false)} onSend={(note) => decide(a, { behavior: 'deny', message: note || 'Please revise the plan.' })} />
  return (
    <div className={`tc-foot${phase ? ' decide-fold' : ''}`}>
      <Button onClick={() => setAsking(true)}>{lead ? 'Request changes' : 'Keep planning'}</Button>
      <Button variant="primary" onClick={() => decideAtOnce(a, { behavior: 'allow' })}>{lead ? 'Approve and hand off' : 'Approve and build'}</Button>
    </div>
  )
}

/** A short plan as numbered rows, in the Inbox: the Lead's task list, or a plan-mode plan that is one list. */
function PlanSteps({ a, agents, lead }: { a: Approval; agents: AgentDef[]; lead: boolean }) {
  const tasks = useStore((s) => (a.projectId ? s.tasks[a.projectId] : undefined))
  const steps = planSteps(a)
  const open = (workspaceId: string) => go({ name: 'workspace', workspaceId })
  return (
    <section aria-label={a.title} className="card tcard">
      <div className="tc-head">
        <AgentAvatar name={agents.find((x) => x.id === a.agentId)?.name ?? 'Kernel'} size={18} />
        <h3>{a.title}</h3>
        <PlanTools a={a} agents={agents} />
      </div>
      <ol className="steps tc-body">
        {steps.map((s, i) => {
          const who = agents.find((x) => x.id === s.agentId)?.name
          const ws = s.workspaceId ?? (s.taskId ? tasks?.find((t) => t.id === s.taskId)?.workspaceId : undefined)
          return (
            <li key={i}>
              <span className="n mono">{i + 1}</span>
              <span>{stepLine(s, agents)}<Criteria step={s} className="step-criteria" /></span>
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
      <div className="tc-head">
        <AgentAvatar name={agents.find((x) => x.id === a.agentId)?.name ?? 'Kernel'} size={18} />
        <h3>{title}</h3>
        <PlanTools a={a} agents={agents} />
      </div>
      {a.planFile && <span className="pcard-file mono ellipsis" title={a.planFile}>{a.planFile}</span>}
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

function HireCard({ a, lead, inChat }: { a: Approval; lead: string; inChat?: boolean }) {
  const decideHere = inChat ? decideInChat : decide
  const [asking, setAsking] = useState(false)
  const [busy, run] = useBusy()
  const file = a.agentFile
  if (!file) return null
  const scope = file.scope === 'team' ? 'Proposed to the team as a pull request' : 'Saved just for you'
  return (
    <section aria-label={file.path} className="card tcard">
      <CardHead who={lead} title={file.path} />
      <div className="tc-body">
        <div className="code">{file.text}</div>
        <HireServers servers={file.servers} agent={hireName(file)} lead={lead} />
        {a.status !== 'pending' && <p className="hire-scope">{scope}</p>}
        {a.status !== 'pending' && <Result a={a} />}
      </div>
      {a.status !== 'pending' ? null : asking ? (
        <ChangesNote onCancel={() => setAsking(false)} onSend={(note) => decideHere(a, { behavior: 'deny', message: note || 'Please change the agent file.' })} />
      ) : (
        <div className="tc-foot">
          <span className="tc-hint hire-scope"><Icon name="user" size={13} />{scope}</span>
          <Button disabled={!!busy} onClick={() => setAsking(true)}>Edit file</Button>
          <Button variant="primary" busy={!!busy} busyPattern="ripple" busyLabel="Creating" onClick={() => void run('create', () => decideHere(a, { behavior: 'allow' }))}>Create agent</Button>
        </div>
      )}
    </section>
  )
}

/**
 * Several permissions waiting in one chat are one card that pages through them (KERNEL-1114). The oldest draws it and the rest draw
 * nothing. Answering one takes it out of the queue, so the card shows the next, and the answered one keeps its result line in the chat.
 */
function PermissionRow({ a, who }: { a: Approval; who: string }) {
  const approvals = useStore((s) => s.approvals)
  const queue = useMemo(() => permissionQueue(approvals, a), [approvals, a])
  const [at, setAt] = useState(0)
  if (a.status !== 'pending' || queue.length < 2) return <PermCard a={a} who={who} />
  if (queue[0].id !== a.id) return null
  const here = Math.min(at, queue.length - 1)
  return <PermCard key={queue[here].id} a={queue[here]} who={who} queue={{ items: queue, at: here, onMove: setAt }} />
}

/** The card for one approval, by kind (WorkspacePerm, Plan, Question, Hire, Lead). `inChat` is set in a transcript, where a composer sits below. */
export function ApprovalCard({ approval: a, inChat }: { approval: Approval; inChat?: boolean }) {
  const agents = useStore((s) => (a.projectId ? s.agents[a.projectId] : undefined)) ?? EMPTY
  const agent = agents.find((x) => x.id === a.agentId)
  const who = agent?.name ?? 'An agent'
  const hasItem = useStore((s) => !!a.chatId && !!s.items[a.chatId]?.some((i) => i.id === answerItemId(a.id)))
  if (a.kind === 'agent' || a.agentFile) return <HireCard a={a} lead={agent?.name ?? 'the Lead'} inChat={inChat} />
  if (isPlanApproval(a)) return inChat ? <PlanInline a={a} agents={agents} hasItem={hasItem} /> : <PlanCard a={a} agents={agents} lead={!!agent?.lead} />
  if (a.kind === 'question') return <QuestionCard a={a} who={who} inChat={inChat} hasItem={hasItem} />
  return inChat && isPermission(a) ? <PermissionRow a={a} who={who} /> : <PermCard a={a} who={who} />
}
