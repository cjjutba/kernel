import { useEffect, type ReactNode } from 'react'
import type { OnboardingStep } from '@shared/types'
import { go } from '../../store'
import { Button, isTyping } from '../../ui'
import { useAccounts } from './Accounts'
import { useChecks } from './Checks'
import { useLoop } from './Loop'
import { useTeam } from './Team'
import './onboarding.css'

type Step = Extract<OnboardingStep, 'checks' | 'accounts' | 'team' | 'loop'>
export const STEPS: { id: Step; name: string }[] = [
  { id: 'checks', name: 'Check your Mac' },
  { id: 'accounts', name: 'Accounts' },
  { id: 'team', name: 'Your team' },
  { id: 'loop', name: 'Stay in the loop' }
]

/** What a step tells the frame: its heading, whether Continue is held, and what the primary button does. */
export interface StepFrame { title: string; sub: string; canContinue: boolean; busy?: boolean; busyLabel?: string; onContinue: () => void; extra?: ReactNode; body: ReactNode }

/**
 * First run, after the welcome (KERNEL-1088): four steps in a full window. The heading, the 560px column and the footer sit at the same
 * height on every step, so moving between them changes only the card. Required checks hold Continue, and nothing is picked for you.
 * A step is a hook that returns its frame, so the frame owns the track, Enter and the buttons. App keys this by step, since each step calls its own hook.
 */
export function Onboarding({ step }: { step: Step }) {
  const at = STEPS.findIndex((s) => s.id === step)
  const frame = { checks: useChecks, accounts: useAccounts, team: useTeam, loop: useLoop }[step]()
  const last = at === STEPS.length - 1
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented || isTyping(e.target)) return
      if ((e.target as Element | null)?.closest?.('button, a, [role=radio], [role=option], [role=menuitem], [role=menuitemradio], [role=dialog]')) return
      if (document.querySelector('.modal, .menu')) return
      if (!frame.canContinue || frame.busy) return
      e.preventDefault()
      frame.onContinue()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const back = () => go({ name: 'onboarding', step: STEPS[at - 1]!.id }, { history: 'replace' })
  return (
    <div className="panel ob-bare ob-flow">
      <div className="ob-track" role="group" aria-label={`Step ${at + 1} of ${STEPS.length}, ${STEPS[at]!.name}`}>
        <span className="ob-segs" aria-hidden="true">{STEPS.map((s, i) => <span key={s.id} className="ob-seg" data-on={i <= at ? 'true' : undefined} data-now={i === at ? 'true' : undefined} />)}</span>
        <span className="ob-where">{`${at + 1} of ${STEPS.length} · ${STEPS[at]!.name}`}</span>
      </div>
      <div className="ob-main">
        <div className="ob-col">
          <h1 className="ob-h1 ob-h1-lg">{frame.title}</h1>
          <p className="ob-sub">{frame.sub}</p>
          {frame.body}
        </div>
      </div>
      <div className="ob-col ob-foot">
        {at === 0 ? <span className="ob-time">Takes about two minutes</span> : <Button variant="ghost" onClick={back} disabled={frame.busy}>Back</Button>}
        <span className="grow" />
        {frame.extra}
        <Button variant="primary" disabled={!frame.canContinue} busy={frame.busy} busyLabel={frame.busyLabel} onClick={frame.onContinue}>
          {last ? 'Finish setup' : 'Continue'}<span className="ob-enter" aria-hidden="true">↵</span>
        </Button>
      </div>
    </div>
  )
}

