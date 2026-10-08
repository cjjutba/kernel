import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, Approval, PlanStep } from '@shared/types'
import { call } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, Icon, IconButton, useBusy } from '../../../ui'
import { Markdown } from '../markdown'
import { parseBlocks } from '../mdParse'
import { attempt } from '../MessageActions'
import { outcome, planSteps, planText } from './steps'
import './cards.css'

// A plan in its chat, the way Conductor shows one (D-092): the transcript shows a "Propose plan" row and the plan as a
// document, and while it waits the composer carries Copy and Approve, and whatever you type goes back as changes.

const EMPTY: AgentDef[] = []

export const stepLine = (s: PlanStep, agents: AgentDef[]) => {
  const who = agents.find((x) => x.id === s.agentId)?.name
  return who ? `${s.title} · ${who}` : s.title
}

/** What Copy puts on the clipboard: the plan's markdown, or the Lead's task list as numbered lines. */
export function planCopyText(a: Approval, agents: AgentDef[]): string {
  return planText(a) || [`# ${a.title}`, '', ...planSteps(a).map((s, i) => `${i + 1}. ${stepLine(s, agents)}`)].join('\n')
}

/** Copies `text` and says "Copied" for 1.5s. */
export function useCopy(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  const copy = () => void navigator.clipboard.writeText(text).then(
    () => { setCopied(true); setTimeout(() => setCopied(false), 1500) },
    () => actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' })
  )
  return [copied, copy]
}

const openPlanFile = (a: Approval) =>
  void attempt('Could not open the plan', async () => { await call('system.openInEditor', { path: (await call('approvals.planFile', { id: a.id })).path }) })

/** The Lead's task list as the plan's body, with a way into each workspace once it is handed off. */
function StepsDoc({ a, agents }: { a: Approval; agents: AgentDef[] }) {
  const tasks = useStore((s) => (a.roomId ? s.tasks[a.roomId] : undefined))
  return (
    <div className="md md-doc">
      <p className="md-h" data-level={1} role="heading" aria-level={4}>{a.title}</p>
      <ol>
        {planSteps(a).map((s, i) => {
          const ws = s.workspaceId ?? (s.taskId ? tasks?.find((t) => t.id === s.taskId)?.workspaceId : undefined)
          const who = agents.find((x) => x.id === s.agentId)?.name
          return (
            <li key={i}>
              {stepLine(s, agents)}
              {a.status === 'allowed' && ws && <button type="button" className="plan-open" aria-label={`Open ${who ?? 'the'} workspace for ${s.title}`} onClick={() => go({ name: 'workspace', workspaceId: ws })}>Open workspace</button>}
            </li>
          )
        })}
      </ol>
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
  useEffect(() => {
    if (a.status !== 'pending') return
    const frame = requestAnimationFrame(() => {
      const el = ref.current
      const scroller = el?.closest('.ws-scroll')
      if (el && scroller && el.offsetHeight > scroller.clientHeight) el.scrollIntoView({ block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [a.id])
  const file = a.planFile?.slice(a.planFile.lastIndexOf('/') + 1)
  return (
    <div ref={ref} className="plan-inline">
      <div className="trow">
        <span className="muted"><Icon name="doc" size={15} stroke={1.3} /></span>
        <span className="ink2">Propose plan</span>
        {file && <button type="button" className="plan-file mono ellipsis" aria-label={`Open ${file} in editor`} data-tip="Open in editor" onClick={() => openPlanFile(a)}>{file}</button>}
        <IconButton icon={copied ? 'check' : 'copy'} size={13} className="plan-copy" label={copied ? 'Copied' : 'Copy plan'} onClick={copy} />
      </div>
      {text ? <Markdown blocks={blocks} className="md-doc" /> : <StepsDoc a={a} agents={agents} />}
      {a.status !== 'pending' && <span className="meta">{a.status === 'allowed' ? 'Plan approved' : outcome(a)}</span>}
    </div>
  )
}

/**
 * Copy and Approve on top of the composer while a plan in this chat waits. ⌘⇧↵ approves from anywhere in the window.
 * The Lead's Approve also hands the plan to the team, as before.
 */
export function PlanBar({ a }: { a: Approval }) {
  const agents = useStore((s) => (a.roomId ? s.agents[a.roomId] : undefined)) ?? EMPTY
  const [copied, copy] = useCopy(planCopyText(a, agents))
  const [busy, run] = useBusy()
  // useBusy drops a second press (or ⌘⇧↵) while the first is still on its way (D-086).
  const approve = () => void run('approve', () => attempt('Could not approve the plan', () => call('approvals.decide', { id: a.id, decision: { behavior: 'allow' } })))
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !e.shiftKey || !(e.metaKey || e.ctrlKey) || e.isComposing) return
      e.preventDefault()
      approve()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [a.id])
  return (
    <div className="cmp-planbar" role="group" aria-label="Plan">
      <Button variant="ghost" icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      <Button variant="primary" aria-keyshortcuts="Meta+Shift+Enter" busy={!!busy} busyLabel="Approving" onClick={approve}>Approve<span className="cmp-planbar-kbd" aria-hidden="true">⌘⇧↵</span></Button>
    </div>
  )
}
