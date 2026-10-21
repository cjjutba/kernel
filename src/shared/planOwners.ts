import type { PlanOwner, PlanStep } from './types'

/** Who the plan card and the Lead's reply call the Lead's own work. */
export const KERNEL_OWNER = 'Kernel'

/** The owner a step has now: its teammate's id, or null when Kernel does it. */
export const ownerOf = (s: PlanStep): PlanOwner => s.agentId ?? null

/**
 * The steps with the owners the user chose. `known` is the ids a step may go to: an owner outside it, or a missing one,
 * leaves the step as the Lead proposed it. A step whose owner differs from the proposal is marked `ownerChanged`.
 */
export function applyOwners(steps: PlanStep[], owners: PlanOwner[] | undefined, known: ReadonlySet<string>): PlanStep[] {
  if (!Array.isArray(owners)) return steps
  return steps.map((s, i) => {
    const o = owners[i]
    if (o === undefined || (o !== null && (typeof o !== 'string' || !known.has(o))) || o === ownerOf(s)) return s
    const { agentId: _from, ...rest } = s
    return { ...rest, ...(o ? { agentId: o } : {}), ownerChanged: true }
  })
}
