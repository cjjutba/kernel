import type { AgentDef } from './types'

// Kernel's built-in Lead and reviewer, and the reads of the roles Kernel resolves for a room's team (KERNEL-397).

/** Kernel's Rowan. Reserved in every repo, so a saved workspace never points at the wrong agent. */
export const KERNEL_LEAD = 'kernel-lead'
/** Kernel's Theo. */
export const KERNEL_REVIEWER = 'kernel-reviewer'
/** `[team] reviewer = "none"`: the room has no reviewer and Kernel's Theo stays out. */
export const NO_REVIEWER = 'none'
export const RESERVED_AGENT_IDS: readonly string[] = [KERNEL_LEAD, KERNEL_REVIEWER]

/** Whether `a` reviews this room's PRs. An agent Kernel didn't resolve, as in tests and fixtures, falls back to its role. */
export const isReviewer = (a: AgentDef): boolean => a.reviewer ?? (!a.lead && !a.retired && /\breview/i.test(a.role))

/** Whether the Lead can hand `a` a task. An agent Kernel didn't resolve takes tasks unless it leads. */
export const takesTasks = (a: AgentDef): boolean => a.member ?? !a.lead
