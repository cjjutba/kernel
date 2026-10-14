import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, Approval, PlanStep } from '@shared/types'
import { call } from '../../../api'
import { go, useStore } from '../../../store'
import { Button, Icon, IconButton } from '../../../ui'
import { Markdown } from '../markdown'
import { leadingTitle, parseBlocks } from '../mdParse'
import { attempt, useCopy } from '../MessageActions'
import { AnswerBubble } from './AnswerBubble'
import { outcome, planAnswer, planSteps, planText } from './steps'
import './cards.css'

// A plan in its chat, the way Conductor shows one (D-092): the transcript shows a "Propose plan" row and the plan as a
// document, and while it waits the composer carries Copy and Approve, and whatever you type goes back as changes.

const EMPTY: AgentDef[] = []

/** The Copy and Approve strip opens over --plan-dur, 0.5s (composer.css), so the chat above it settles a little after that. */
const STRIP_OPENS_MS = 800

/** Pressing Approve in this chat (or ⌘⇧↵) sends this on window, with the chat's id. The transcript scrolls to its end and the plan stops holding its place. */
export const PLAN_APPROVE_EVENT = 'kernel:plan-approve'

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

/** The plan in the transcript. No buttons to decide here: they sit on the composer while the plan waits (PlanBar). */
export function PlanInline({ a, agents }: { a: Approval; agents: AgentDef[] }) {
  const text = planText(a)
  const blocks = useMemo(() => parseBlocks(text), [text])
  const [copied, copy] = useCopy(planCopyText(a, agents))
  const ref = useRef<HTMLDivElement>(null)
  // The transcript follows its end, which would open a long plan at its last line. One taller than the chat opens at its top.
  // The Approve strip opens over a second and shortens the chat under it, which would leave a plan that fits with its end
  // below the fold, so while it opens the end stays in view.
  useEffect(() => {
    if (a.status !== 'pending') return
    const el = ref.current
    const scroller = el?.closest('.ws-scroll')
    if (!el || !scroller) return
    const frame = requestAnimationFrame(() => { if (el.offsetHeight > scroller.clientHeight) el.scrollIntoView({ block: 'start' }) })
    const resize = new ResizeObserver(() => { if (el.offsetHeight <= scroller.clientHeight) el.scrollIntoView({ block: 'end' }) })
    resize.observe(scroller)
    const stop = setTimeout(() => resize.disconnect(), STRIP_OPENS_MS)
    // Approving scrolls the chat to its end, so the plan stops keeping its own end in view while the strip closes.
    const approving = () => resize.disconnect()
    window.addEventListener(PLAN_APPROVE_EVENT, approving)
    return () => { cancelAnimationFrame(frame); clearTimeout(stop); resize.disconnect(); window.removeEventListener(PLAN_APPROVE_EVENT, approving) }
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
      {answer && <AnswerBubble text={answer} images={a.images} />}
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

/**
 * Copy and Approve on top of the composer while a plan in this chat waits. ⌘⇧↵ approves from anywhere in the window.
 * The Lead's Approve also hands the plan to the team, as before.
 * Approve closes the strip at once, the opening animation in reverse, with no spinner (KERNEL-789). The composer keeps it
 * mounted through `closing` (the plan stopped waiting) until the animation ends, then `onClosed` removes it.
 */
export function PlanBar({ a, closing = false, onClosed }: { a: Approval; closing?: boolean; onClosed?: () => void }) {
  const agents = useStore((s) => (a.roomId ? s.agents[a.roomId] : undefined)) ?? EMPTY
  const [copied, copy] = useCopy(planCopyText(a, agents))
  const [pressed, setPressed] = useState(false)
  // Drops a second press (or ⌘⇧↵) while the strip closes, the guard useBusy gave before (D-086). A ref, so two presses in one frame still count once.
  const sent = useRef(false)
  const approve = () => {
    if (sent.current) return
    sent.current = true
    setPressed(true)
    window.dispatchEvent(new CustomEvent(PLAN_APPROVE_EVENT, { detail: { chatId: a.chatId } }))
    void attempt('Could not approve the plan', () => call('approvals.decide', { id: a.id, decision: { behavior: 'allow' } })).then((ok) => {
      if (!ok) { sent.current = false; setPressed(false) }
    })
  }
  // A plan that stopped waiting for another reason (decided in Inbox, denied, expired) is closing too, and can't be approved.
  useEffect(() => { if (closing) sent.current = true }, [closing])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !e.shiftKey || !(e.metaKey || e.ctrlKey) || e.isComposing) return
      e.preventDefault()
      approve()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [a.id])
  const out = closing || pressed
  // Reduced motion has no close animation to wait for, so a strip whose plan stopped waiting goes at once.
  useEffect(() => { if (closing && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) onClosed?.() }, [closing])
  return (
    <div className="cmp-planbar" role="group" aria-label="Plan" data-closing={out || undefined} onAnimationEnd={(e) => { if (out && e.target === e.currentTarget && e.animationName === 'planbar-out') onClosed?.() }}>
      <span className="grow" />
      <Button variant="ghost" icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      <Button variant="primary" aria-keyshortcuts="Meta+Shift+Enter" onClick={approve}>Approve<span className="cmp-planbar-kbd" aria-hidden="true">⌘⇧↵</span></Button>
    </div>
  )
}

/** The strip above the composer. It stays mounted after the plan stops waiting, until its close animation ends (KERNEL-789). */
export function PlanStrip({ plan }: { plan: Approval | undefined }) {
  const [strip, setStrip] = useState(plan)
  if (plan && plan !== strip) setStrip(plan)
  return strip ? <PlanBar key={strip.id} a={strip} closing={!plan} onClosed={() => setStrip(undefined)} /> : null
}
