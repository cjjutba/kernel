import { useSyncExternalStore } from 'react'
import type { AgentDef, Approval, Decision, PlanOwner } from '@shared/types'
import { ownerOf } from '@shared/planOwners'
import { takesTasks } from '@shared/team'
import { planSteps } from './steps'

// Who does each step of a waiting plan, as the user left it on the card (plan-step-owners). The card in the chat and the
// Approve button on the composer are different components, so the picks live here, by approval id, until the plan is decided.

const picks = new Map<string, PlanOwner[]>()
const watchers = new Set<() => void>()
const watch = (w: () => void) => { watchers.add(w); return () => { watchers.delete(w) } }
let version = 0

/** The owners a plan shows: the user's picks over what the Lead proposed. */
export const ownersOf = (a: Approval): PlanOwner[] => picks.get(a.id) ?? planSteps(a).map(ownerOf)

/** The owners of a waiting plan, drawn again when one is picked. */
export function useOwners(a: Approval): PlanOwner[] {
  useSyncExternalStore(watch, () => version)
  return ownersOf(a)
}

/** Sets who does step `i`. A pick back to what the Lead proposed is dropped, so Approve sends nothing the user didn't change. */
export function pickOwner(a: Approval, i: number, owner: PlanOwner) {
  const next = ownersOf(a).slice()
  next[i] = owner
  const proposed = planSteps(a).map(ownerOf)
  if (next.every((o, j) => o === proposed[j])) picks.delete(a.id)
  else picks.set(a.id, next)
  version++
  watchers.forEach((w) => w())
}

/** An allow decision for a plan carries the owners the user changed. Any other decision goes as it is. */
export function withOwners(a: Approval, decision: Decision): Decision {
  const owners = picks.get(a.id)
  return decision.behavior === 'allow' && a.kind === 'plan' && owners ? { ...decision, owners } : decision
}

/** Teammates a step can go to: those who take tasks, apart from the Lead. */
export const teammates = (agents: AgentDef[]): AgentDef[] => agents.filter((x) => takesTasks(x) && !x.lead && !x.retired)
