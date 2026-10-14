'use client'

import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { CheckIcon, CopyIcon, MergeIcon, PlanDocIcon, PlanModeIcon, ReplayIcon, SendIcon } from '@/components/ui/icons'
import { useTimers } from './timers'

// The three steps as one small working copy of the app. Each card shows its finished state at rest, so the story reads
// without a click. Used in order, they are connected: the brief makes Kernel write the plan, approving it starts the
// three agents, and their pull requests become ready to merge.

export type Step = { num: string; title: string; text: string }

const BRIEF = 'Add PDF export to invoices. Spec first.'
const TASKS = [
  { agent: 'Noor', title: 'PDF renderer', pr: 41 },
  { agent: 'Kai', title: 'Download button', pr: 42 },
  { agent: 'Ivy', title: 'Snapshot tests', pr: 43 }
]
const PLAN_TEXT = `T-15 Export invoices as PDF\n${TASKS.map((t, i) => `${i + 1}. ${t.title} (${t.agent})`).join('\n')}`

type Brief = 'compose' | 'reading' | 'sent'
type Plan = 'writing' | 'pending' | 'approving' | 'approved' | 'revising'
type Pr = 'building' | 'checks' | 'ready' | 'merging' | 'merged'
const READY: Pr[] = ['ready', 'ready', 'ready']

export function StepFlow({ steps }: { steps: Step[] }) {
  const { later, clear } = useTimers()
  const [brief, setBrief] = useState<Brief>('compose')
  const [text, setText] = useState(BRIEF)
  const [sent, setSent] = useState('')
  const [plan, setPlan] = useState<Plan>('pending')
  const [shown, setShown] = useState(TASKS.length)
  const [revised, setRevised] = useState(false)
  const [notes, setNotes] = useState('')
  const [copied, setCopied] = useState(false)
  const [prs, setPrs] = useState<Pr[]>(READY)
  const [active, setActive] = useState(0)
  const [touched, setTouched] = useState(false)

  const setPr = (i: number, next: Pr) => setPrs((all) => all.map((p, j) => (j === i ? next : p)))

  /** Kernel writes the plan: its rows arrive one at a time, then it waits for approval. */
  const writePlan = () => {
    setPlan('writing')
    setShown(0)
    TASKS.forEach((_, i) => later(500 + i * 450, () => setShown(i + 1)))
    later(500 + TASKS.length * 450 + 300, () => setPlan('pending'))
  }

  const sendBrief = (e: FormEvent) => {
    e.preventDefault()
    const b = text.trim()
    if (!b || brief !== 'compose') return
    setTouched(true)
    setSent(b)
    setBrief('reading')
    setRevised(false)
    later(1400, () => {
      setBrief('sent')
      setActive(1)
      writePlan()
    })
  }

  const approve = () => {
    if (plan !== 'pending') return
    setTouched(true)
    setPlan('approving')
    later(900, () => {
      setPlan('approved')
      setActive(2)
      // Three agents, three branches, at once. Each builds, its checks run, and its PR is ready.
      setPrs(['building', 'building', 'building'])
      TASKS.forEach((_, i) => {
        later(1300 + i * 500, () => setPr(i, 'checks'))
        later(2600 + i * 650, () => setPr(i, 'ready'))
      })
    })
  }

  const sendNotes = (e: FormEvent) => {
    e.preventDefault()
    if (plan !== 'pending' || !notes.trim()) return
    setTouched(true)
    setNotes('')
    setPlan('revising')
    later(1500, () => {
      setRevised(true)
      writePlan()
    })
  }

  const approveShortcut = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && e.metaKey && e.shiftKey) {
      e.preventDefault()
      approve()
    }
  }

  const copy = () => {
    void navigator.clipboard?.writeText(PLAN_TEXT).catch(() => undefined)
    setCopied(true)
    later(1500, () => setCopied(false))
  }

  const merge = (i: number) => {
    if (prs[i] !== 'ready') return
    setTouched(true)
    setActive(2)
    setPr(i, 'merging')
    later(1100, () => setPr(i, 'merged'))
  }

  const replay = () => {
    clear()
    setBrief('compose')
    setText(BRIEF)
    setSent('')
    setPlan('pending')
    setShown(TASKS.length)
    setRevised(false)
    setNotes('')
    setCopied(false)
    setPrs(READY)
    setActive(0)
    setTouched(false)
  }

  const cards = [
    <BriefCard key="brief" brief={brief} plan={plan} text={text} sent={sent} onText={setText} onSend={sendBrief} />,
    <PlanCard
      key="plan"
      plan={plan}
      shown={shown}
      revised={revised}
      notes={notes}
      copied={copied}
      onNotes={setNotes}
      onSendNotes={sendNotes}
      onShortcut={approveShortcut}
      onApprove={approve}
      onCopy={copy}
    />,
    <PrCard key="prs" prs={prs} onMerge={merge} />
  ]

  return (
    <>
      <div className="mt-14 grid grid-steps gap-4">
        {steps.map((s, i) => (
          <article
            key={s.num}
            className={`overflow-hidden rounded-frame border bg-linear-to-b from-surface-2 to-surface-1 transition-colors duration-300 ${
              touched && active === i ? 'border-edge' : 'border-line'
            }`}
          >
            <div className="relative flex h-64 items-center border-b border-line-soft p-5 bg-dots-card">{cards[i]}</div>
            <div className="p-6">
              <span className={`font-mono text-micro leading-normal font-medium transition-colors ${touched && active === i ? 'text-ink-2' : 'text-faint'}`}>
                {s.num}
              </span>
              <h3 className="mt-2 text-step-title">{s.title}</h3>
              <p className="mt-2 text-body text-muted">{s.text}</p>
            </div>
          </article>
        ))}
      </div>
      <div className="mt-5 flex min-h-8 flex-wrap items-center justify-between gap-3 px-1 text-small text-faint">
        <p>Every card works, and they work together. Start with the brief.</p>
        {touched && (
          <button
            type="button"
            onClick={replay}
            className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-ui font-medium text-muted transition-colors hover:bg-white/5 hover:text-white"
          >
            <ReplayIcon size={14} />
            Replay
          </button>
        )}
      </div>
    </>
  )
}

// ---------- 01 The brief

const shell = 'w-full rounded-lg border border-edge bg-surface-3 text-left'

function BriefCard({ brief, plan, text, sent, onText, onSend }: { brief: Brief; plan: Plan; text: string; sent: string; onText: (v: string) => void; onSend: (e: FormEvent) => void }) {
  // Once sent, the line under the brief follows the plan in step 02.
  const after = plan === 'approved' ? 'Approved · the agents are on it' : plan === 'writing' || plan === 'revising' ? 'Kernel is writing the plan' : 'Plan ready · see step 02'
  if (brief === 'compose') {
    return (
      <form onSubmit={onSend} className={`${shell} px-4 pt-3 pb-3 transition-colors focus-within:border-rule`}>
        <label htmlFor="brief-input" className="sr-only">
          Brief for Kernel
        </label>
        <textarea
          id="brief-input"
          rows={2}
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) onSend(e)
          }}
          placeholder="Describe what to build"
          className="block w-full resize-none bg-transparent text-ui leading-snug text-ink outline-none placeholder:text-faint"
        />
        <div className="mt-4 flex items-center">
          <span className="inline-flex h-6 items-center rounded-chip border border-line-strong bg-chip px-2 text-micro text-ink-2">To Kernel</span>
          <span className="flex-1" />
          <button
            type="submit"
            aria-label="Send the brief to Kernel"
            disabled={!text.trim()}
            className="inline-flex size-7 items-center justify-center rounded-full bg-ink text-canvas transition-opacity hover:bg-white disabled:opacity-30"
          >
            <SendIcon />
          </button>
        </div>
      </form>
    )
  }
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="ml-auto max-w-full rounded-lg border border-edge bg-surface-4 px-3 py-2 text-small leading-snug text-ink">{sent}</div>
      <p role="status" className="flex min-w-0 items-center gap-2 text-small text-muted">
        {brief === 'reading' ? (
          <>
            <span aria-hidden="true" className="spinner text-ink-2" />
            <span className="truncate">Kernel is reading the repo</span>
          </>
        ) : (
          <>
            <CheckIcon className="shrink-0 text-ink-2" />
            <span className="truncate">{after}</span>
          </>
        )}
      </p>
    </div>
  )
}

// ---------- 02 The plan, in Kernel's composer in plan mode

type PlanProps = {
  plan: Plan
  shown: number
  revised: boolean
  notes: string
  copied: boolean
  onNotes: (v: string) => void
  onSendNotes: (e: FormEvent) => void
  onShortcut: (e: KeyboardEvent<HTMLInputElement>) => void
  onApprove: () => void
  onCopy: () => void
}

function PlanCard({ plan, shown, revised, notes, copied, onNotes, onSendNotes, onShortcut, onApprove, onCopy }: PlanProps) {
  const approved = plan === 'approved'
  const waiting = plan === 'pending' || plan === 'approving'
  const bar = 'flex h-10 items-center gap-1.5 rounded-t-lg pr-1.5 pl-3 text-small font-medium whitespace-nowrap text-ink-2'
  return (
    <div className={`w-full rounded-lg border bg-surface-2 text-left ${approved ? 'border-edge' : 'plan-ring'}`}>
      {waiting && (
        <div className={`${bar} bg-plan-bar`}>
          <PlanDocIcon size={14} className="shrink-0 text-plan" />
          <span className="truncate">{revised ? 'Revised' : 'Plan'}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCopy}
            disabled={plan === 'approving'}
            className="inline-flex h-6.5 items-center gap-1.5 rounded-chip px-2 text-micro font-medium text-ink-2 transition-colors hover:bg-white/5 hover:text-white"
          >
            <CopyIcon size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={plan === 'approving'}
            aria-busy={plan === 'approving'}
            aria-keyshortcuts="Meta+Shift+Enter"
            className={`inline-flex h-6.5 items-center gap-1.5 rounded-chip border px-2.5 text-micro font-medium transition-colors ${
              plan === 'approving' ? 'border-plan/45 bg-plan/12 text-plan' : 'border-plan bg-plan text-on-plan hover-mix-plan'
            }`}
          >
            {plan === 'approving' ? <span aria-hidden="true" className="spinner" /> : null}
            {plan === 'approving' ? 'Approving' : 'Approve'}
            {plan !== 'approving' && (
              <span aria-hidden="true" className="text-badge font-normal opacity-60">
                ⌘⇧↵
              </span>
            )}
          </button>
        </div>
      )}
      {(plan === 'writing' || plan === 'revising') && (
        <p role="status" className={`${bar} gap-2 bg-plan-bar`}>
          <span aria-hidden="true" className="spinner text-plan" />
          {plan === 'writing' ? 'Kernel is writing the plan' : 'Kernel is revising the plan'}
        </p>
      )}
      {approved && (
        <p role="status" className={`${bar} gap-2 border-b border-line`}>
          <CheckIcon className="shrink-0" />
          <span className="truncate">Approved · 3 agents started</span>
        </p>
      )}
      <ol aria-label="Tasks in the plan" className={`px-3 py-1.5 transition-opacity ${plan === 'revising' ? 'opacity-45' : ''}`}>
        {TASKS.map((t, i) => (
          <li
            key={t.title}
            className={`flex h-6 items-center gap-2.5 text-small font-medium text-ink-2 transition-opacity duration-300 ${i < shown ? 'opacity-100' : 'opacity-0'}`}
          >
            <span className={`w-2.5 shrink-0 text-micro font-normal ${approved ? 'text-faint' : 'text-plan'}`}>{i + 1}</span>
            <span className="truncate">{t.title}</span>
            <span className="ml-auto shrink-0 font-normal text-muted">{t.agent}</span>
          </li>
        ))}
      </ol>
      <form onSubmit={onSendNotes}>
        <label htmlFor="plan-notes" className="sr-only">
          Changes to the plan for Kernel
        </label>
        <input
          id="plan-notes"
          value={notes}
          onChange={(e) => onNotes(e.target.value)}
          onKeyDown={onShortcut}
          disabled={plan !== 'pending'}
          placeholder={approved ? 'Approved. The agents are on it.' : 'Enter your plan adjustments here'}
          autoComplete="off"
          className="block w-full border-t border-line-soft bg-transparent px-3 pt-2.5 pb-0.5 text-small text-ink caret-plan outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-2 pt-1 pr-2 pb-2 pl-3 text-micro">
          <span className="text-ink-2">Opus 5.5</span>
          {!approved && (
            <span className="inline-flex items-center gap-1 font-medium text-plan">
              <PlanModeIcon size={12} />
              Plan
            </span>
          )}
          <span className="flex-1" />
          <button
            type="submit"
            aria-label="Send the changes to Kernel"
            disabled={plan !== 'pending' || !notes.trim()}
            className="inline-flex size-6 items-center justify-center rounded-full bg-surface-4 text-faint transition-colors enabled:bg-plan enabled:text-on-plan enabled:hover-mix-plan"
          >
            <SendIcon size={12} />
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------- 03 The pull requests, as the Lead's PRs panel lists them

function PrCard({ prs, onMerge }: { prs: Pr[]; onMerge: (i: number) => void }) {
  const ready = prs.filter((p) => p === 'ready').length
  const merged = prs.filter((p) => p === 'merged').length
  const heading = ready ? `Ready to merge ${ready}` : merged === prs.length ? 'All merged' : prs.some((p) => p === 'building') ? 'Building' : 'Checks running'
  return (
    <div className={shell}>
      <p className="flex h-9 items-center border-b border-line-soft px-3 text-micro font-medium text-muted">{heading}</p>
      <ul>
        {TASKS.map((t, i) => (
          <li key={t.title} className="flex h-10.5 min-w-0 items-center gap-2 border-b border-line-soft px-3 last:border-b-0">
            <span className="shrink-0 text-small font-medium text-ink">{t.agent}</span>
            <span className="min-w-0 truncate text-small text-muted">{t.title}</span>
            <span className="shrink-0 font-mono text-micro leading-normal text-muted">#{t.pr}</span>
            <span className="flex-1" />
            <PrState state={prs[i]!} onMerge={() => onMerge(i)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function PrState({ state, onMerge }: { state: Pr; onMerge: () => void }) {
  const button = 'inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-chip border px-2.5 text-micro font-medium transition-colors'
  if (state === 'building' || state === 'checks') {
    return (
      <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-micro text-muted">
        <span aria-hidden="true" className="spinner" />
        {state === 'building' ? 'Building' : 'Checks'}
      </span>
    )
  }
  if (state === 'merged') {
    return (
      <span role="status" className="inline-flex shrink-0 items-center gap-1 text-micro font-medium text-merged-text">
        <MergeIcon size={12} />
        Merged
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onMerge}
      disabled={state === 'merging'}
      aria-busy={state === 'merging'}
      className={`${button} ${state === 'merging' ? 'border-ready-edge bg-ready-soft text-ready-fg' : 'border-ready-solid bg-ready-solid text-white hover-mix-ready'}`}
    >
      {state === 'merging' && <span aria-hidden="true" className="spinner" />}
      {state === 'merging' ? 'Merging' : 'Merge'}
    </button>
  )
}
