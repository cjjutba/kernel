import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, Approval, PlanStep } from '@shared/types'
import { call } from '../../../api'
import { go, useStore } from '../../../store'
import { Button, Icon, IconButton, useScreenEscape } from '../../../ui'
import { Markdown } from '../markdown'
import { leadingTitle, parseBlocks } from '../mdParse'
import { attempt, useCopy } from '../MessageActions'
import { AnswerBubble } from './AnswerBubble'
import { TranscriptGlide } from '../glideContext'
import { decideInChat } from './optimisticAnswer'
import { planAnswer } from '@shared/approvalAnswer'
import { outcome, planSteps, planText } from './steps'
import './cards.css'

// A plan in its chat, the way Conductor shows one (D-092): the transcript shows a "Propose plan" row and the plan as a
// document, and while it waits the composer carries Copy and Approve, and whatever you type goes back as changes.

const EMPTY: AgentDef[] = []

/** The Copy and Approve strip opens over --plan-dur, 0.5s (composer.css), so the chat above it settles a little after that. */
const STRIP_OPENS_MS = 800

export const stepLine = (s: PlanStep, agents: AgentDef[]) => {
  const who = agents.find((x) => x.id === s.agentId)?.name
  return who ? `${s.title} · ${who}` : s.title
}

/** What Copy puts on the clipboard: the write-up and the Lead's tasks as numbered lines, or an ExitPlanMode plan's markdown. */
export function planCopyText(a: Approval, agents: AgentDef[]): string {
  const text = planText(a)
  if (!a.steps?.length) return text || `# ${a.title}`
  const doc = leadingTitle(parseBlocks(text)) ? text : [`# ${a.title}`, text].filter(Boolean).join('\n\n')
  return [doc, planSteps(a).map((s, i) => `${i + 1}. ${stepLine(s, agents)}`).join('\n')].join('\n\n')
}

const openPlanFile = (a: Approval) =>
  void attempt('Could not open the plan', async () => { await call('system.openInEditor', { path: (await call('approvals.planFile', { id: a.id })).path }) })

/** The Lead's tasks as numbered rows, the agent's name muted beside each, with a way into its workspace once the plan is handed off. */
export function PlanTasks({ a, agents }: { a: Approval; agents: AgentDef[] }) {
  const tasks = useStore((s) => (a.roomId ? s.tasks[a.roomId] : undefined))
  return (
    <ol className="plan-tasks">
      {planSteps(a).map((s, i) => {
        const ws = s.workspaceId ?? (s.taskId ? tasks?.find((t) => t.id === s.taskId)?.workspaceId : undefined)
        const who = agents.find((x) => x.id === s.agentId)?.name
        return (
          <li key={i}>
            <span className="plan-n mono" aria-hidden="true">{i + 1}</span>
            <span className="plan-task">{s.title}{who && <span className="plan-who">{who}</span>}</span>
            {a.status === 'allowed' && ws && <button type="button" className="plan-open" aria-label={`Open ${who ?? 'the'} workspace for ${s.title}`} onClick={() => go({ name: 'workspace', workspaceId: ws })}>Open workspace</button>}
          </li>
        )
      })}
    </ol>
  )
}

/** The Lead's plan as a document: its write-up, headed by the approval's title unless the markdown has its own, then the task rows (PlanWaiting.png). */
function LeadPlan({ a, agents }: { a: Approval; agents: AgentDef[] }) {
  const text = planText(a)
  const blocks = useMemo(() => {
    const parsed = parseBlocks(text)
    return leadingTitle(parsed) ? parsed : [{ type: 'h' as const, level: 1, text: a.title }, ...parsed]
  }, [text, a.title])
  return (
    <div className="plan-card">
      <Markdown blocks={blocks} />
      <PlanTasks a={a} agents={agents} />
    </div>
  )
}

/** The plan in the transcript. No buttons to decide here: they sit on the composer while the plan waits (PlanBar). A settled plan's answer is the chat's own user row (`hasItem`); the bubble here is the fallback for older chats. */
export function PlanInline({ a, agents, hasItem }: { a: Approval; agents: AgentDef[]; hasItem?: boolean }) {
  const text = planText(a)
  const blocks = useMemo(() => parseBlocks(text), [text])
  const [copied, copy] = useCopy(planCopyText(a, agents))
  const ref = useRef<HTMLDivElement>(null)
  // The transcript follows its end, which would open a long plan at its last line. One taller than the chat opens at its top. The Approve strip opens over a second and shortens
  // the chat under it, which would leave a plan that fits with its end below the fold, so while it opens the end stays in view. The transcript's glide does both.
  const glide = useContext(TranscriptGlide)
  useEffect(() => {
    if (a.status === 'pending' && ref.current) glide?.(ref.current, STRIP_OPENS_MS)
  }, [a.id])
  const file = a.planFile?.slice(a.planFile.lastIndexOf('/') + 1)
  const answer = planAnswer(a)
  return (
    <>
      <div ref={ref} className="plan-inline">
        <div className="trow">
          <span className="plan-doc-icon"><Icon name="doc" size={16} /></span>
          <span className="ink2">Propose plan</span>
          {file && <button type="button" className="plan-file mono ellipsis" aria-label={`Open ${file} in editor`} data-tip="Open in editor" onClick={() => openPlanFile(a)}>{file}</button>}
          <IconButton icon={copied ? 'check' : 'copy'} size={14} className="plan-copy" label={copied ? 'Copied' : 'Copy plan'} onClick={copy} />
        </div>
        {a.steps?.length || !text ? <LeadPlan a={a} agents={agents} /> : <Markdown blocks={blocks} className="md-doc" />}
        {a.status === 'expired' && <PlanExpired a={a} />}
      </div>
      {answer && !hasItem && <AnswerBubble text={answer} images={a.images} />}
    </>
  )
}

/** Why a plan can no longer be decided, drawn like a PR note in the chat: the plan glyph, the reason and a hairline (KERNEL-313). A decided plan has the user's bubble instead. */
function PlanExpired({ a }: { a: Approval }) {
  return (
    <div className="note inline" data-plan={a.status}>
      <Icon name="plan" size={14} />
      <span className="note-text">{outcome(a)}</span>
      <span className="note-rule" aria-hidden="true" />
    </div>
  )
}

/** What the strip hands the composer: the approval whose strip is mounted, which holds plan mode while it closes (KERNEL-833), and what pressed Approve. */
export interface PlanStripState {
  /** The plan whose strip is on screen, including while it closes. */
  shown: Approval | undefined
  /** The strip is closing: Approve was pressed, or its plan stopped waiting or was replaced. */
  closing: boolean
  /** "Plan approved" once the approval went through, for a screen reader. */
  said: string
  approve: () => void
  closed: () => void
}

/**
 * The plan strip's state, held by the composer so the placeholder, the Plan chip and the glow can stay in plan mode until the strip has closed (KERNEL-833).
 * The strip stays mounted after its plan stops waiting (approved here or in Inbox, denied, expired) until its close animation ends or is cancelled. A plan that
 * arrives meanwhile waits for that. The approval call goes out at once, and a failed one opens the strip again, as a new strip if it had already gone.
 * `onApproved` runs at the press, where the composer takes the focus the Approve button held.
 */
export function usePlanStrip(plan: Approval | undefined, onApproved?: () => void): PlanStripState {
  const [shown, setShown] = useState(plan)
  const [pressed, setPressed] = useState(false)
  // The plan whose strip closed after Approve while the plan still waited (a slow approval), so it doesn't open again before the call fails.
  const [gone, setGone] = useState<string | undefined>()
  const [approved, setApproved] = useState<string | undefined>()
  if (approved && plan && plan.id !== approved) setApproved(undefined)
  if (shown && plan && plan.id === shown.id && plan !== shown) setShown(plan)
  if (!shown && plan && plan.id !== gone) setShown(plan)
  if (gone && plan?.id !== gone) setGone(undefined)
  const closing = !!shown && (pressed || !plan || plan.id !== shown.id)
  // Drops a second press (or ⌘⇧↵) while the strip closes, the guard useBusy gave before (D-086). A ref, so two presses in one frame still count once.
  const sent = useRef(false)
  const now = useRef({ shown, closing, plan, onApproved })
  now.current = { shown, closing, plan, onApproved }
  const approve = () => {
    const { shown: a, closing: out, onApproved: after } = now.current
    if (!a || out || sent.current) return
    sent.current = true
    setPressed(true)
    after?.()
    void decideInChat(a, { behavior: 'allow' }, 'Could not approve the plan').then((ok) => {
      sent.current = false
      if (ok) setApproved(a.id)
      else { setPressed(false); setGone(undefined) }
    })
  }
  const closed = () => {
    const { shown: a, plan: waiting } = now.current
    if (!a) return
    setPressed(false)
    // Still waiting: the strip is gone and stays gone until the call fails or another plan comes.
    if (waiting && waiting.id === a.id) setGone(a.id)
    setShown(waiting && waiting.id !== a.id ? waiting : undefined)
  }
  return { shown, closing, said: approved ? 'Plan approved' : '', approve, closed }
}

/**
 * Copy and Approve on top of the composer while a plan in this chat waits. ⌘⇧↵ approves from anywhere in the window.
 * The Lead's Approve also hands the plan to the team, as before.
 * Approve closes the strip at once, the opening animation in reverse, with no spinner (KERNEL-789): its margin and hairline go with it, and so does the
 * composer's top padding (composer.css), so the box shrinks as one. With text in the box, Approve asks first (KERNEL-833): Send changes sends it as the
 * plan's change request, and Approve approves and leaves it in the box.
 */
export function PlanBar({ a, closing, hasText, onApprove, onSendChanges, onBack, onClosed }: {
  a: Approval
  closing: boolean
  hasText: boolean
  onApprove: () => void
  onSendChanges: () => void
  /** Escape backed out of the question: the caret goes back to the box. */
  onBack: () => void
  onClosed: () => void
}) {
  const agents = useStore((s) => (a.roomId ? s.agents[a.roomId] : undefined)) ?? EMPTY
  const [copied, copy] = useCopy(planCopyText(a, agents))
  const [asked, setAsked] = useState(false)
  // The question stays in the strip while it closes, so pressing Approve in it does not swap back to Copy and Approve for the length of the close (KERNEL-839).
  const asking = asked && hasText
  const group = useRef<HTMLDivElement>(null)
  const press = () => {
    if (closing) return
    if (hasText && !asking) setAsked(true)
    else onApprove()
  }
  const latest = useRef(press)
  latest.current = press
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !e.shiftKey || !(e.metaKey || e.ctrlKey) || e.isComposing) return
      e.preventDefault()
      latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // The question takes the focus (on Send changes, the choice that loses nothing), and Escape backs out of it from anywhere.
  useEffect(() => {
    if (asking) group.current?.querySelector<HTMLElement>('[data-ask-first]')?.focus()
  }, [asking])
  useScreenEscape((_, inField) => {
    if (inField) return false
    setAsked(false)
    onBack()
    return true
  }, asking)
  // No close animation runs in a window nobody sees, or with reduced motion, so the strip goes at once. Elsewhere it goes when its animation ends or is cancelled.
  useEffect(() => {
    if (!closing) return
    const gone = () => { if (document.hidden || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) onClosed() }
    gone()
    document.addEventListener('visibilitychange', gone)
    return () => document.removeEventListener('visibilitychange', gone)
  }, [closing])
  // React has no prop for animationcancel. A strip whose close is cancelled (display none, the element hidden) goes like one that ended. The reopen after a failed
  // approval drops `data-closing` and so cancels this animation too, which the attribute check tells apart.
  const away = useRef(onClosed)
  away.current = onClosed
  useEffect(() => {
    const el = group.current
    if (!el) return
    const done = (e: Event) => { if (e.target === el && (e as AnimationEvent).animationName === 'planbar-out' && el.hasAttribute('data-closing')) away.current() }
    el.addEventListener('animationend', done)
    el.addEventListener('animationcancel', done)
    return () => { el.removeEventListener('animationend', done); el.removeEventListener('animationcancel', done) }
  }, [])
  return (
    <div ref={group} className="cmp-planbar" role="group" aria-label="Plan" data-closing={closing || undefined}>
      {asking ? (
        <>
          <span className="cmp-planbar-ask ellipsis">Approve without your changes?</span>
          <Button variant="ghost" data-ask-first="" onClick={() => { setAsked(false); onSendChanges() }}>Send changes</Button>
          <Button variant="primary" aria-keyshortcuts="Meta+Shift+Enter" onClick={press}>Approve</Button>
        </>
      ) : (
        <>
          <span className="grow" />
          <Button variant="ghost" icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          <Button variant="primary" aria-keyshortcuts="Meta+Shift+Enter" onClick={press}>Approve<span className="cmp-planbar-kbd" aria-hidden="true">⌘⇧↵</span></Button>
        </>
      )}
    </div>
  )
}

/** The strip above the composer, from `usePlanStrip`. */
export function PlanStrip({ strip, hasText, onSendChanges, onBack }: { strip: PlanStripState; hasText: boolean; onSendChanges: () => void; onBack: () => void }) {
  return strip.shown ? <PlanBar key={strip.shown.id} a={strip.shown} closing={strip.closing} hasText={hasText} onApprove={strip.approve} onSendChanges={onSendChanges} onBack={onBack} onClosed={strip.closed} /> : null
}
