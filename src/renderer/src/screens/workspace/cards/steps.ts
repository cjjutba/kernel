import type { Approval, PlanStep } from '@shared/types'

/** The lines of a plan card. Rowan sends `steps`; a plan-mode agent sends numbered text in `detail`. */
export function planSteps(a: Pick<Approval, 'steps' | 'detail'>): PlanStep[] {
  if (a.steps?.length) return a.steps
  return (a.detail ?? '').split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s+/, '').trim()).filter(Boolean).map((title) => ({ title }))
}

/** What a resolved approval says in place of its buttons. */
export function outcome(a: Approval): string {
  switch (a.status) {
    case 'allowed': return a.kind === 'plan' || a.kind === 'agent' ? 'Approved' : a.kind === 'tool' ? 'Allowed' : 'Approved'
    case 'denied': return a.kind === 'plan' ? 'Changes requested' : 'Denied'
    case 'answered': return a.answer ? `You answered: ${a.answer}` : 'Answered'
    default: return 'Expired'
  }
}
