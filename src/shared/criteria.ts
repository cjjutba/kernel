import type { PlanCriterion } from './types'

/** The criterion's text, whether the plan stored it as a plain string or with a named check. */
export const criterionText = (c: PlanCriterion): string => (typeof c === 'string' ? c : c.text)

/** The CI check the Lead named as proof of the criterion, if any. */
export const criterionCheck = (c: PlanCriterion): string | undefined => (typeof c === 'string' ? undefined : c.check?.trim() || undefined)
