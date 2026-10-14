import type { AgentDef, TeamConfig } from './types'

// Kernel's built-in Lead, its own reviews, and the reads of the roles Kernel resolves for a room's team (KERNEL-397).

/** Kernel, the Lead. Reserved in every repo, so a saved workspace never points at the wrong agent. */
export const KERNEL_LEAD = 'kernel-lead'
/** The Lead's name in every room (KERNEL-692). Another agent with this name shows as "Kernel (agent)". */
export const KERNEL_NAME = 'Kernel'
/** The file that customizes Kernel, in the room's .claude/agents. Customize writes it and Reset deletes it (KERNEL-692). */
export const KERNEL_FILE = 'kernel.md'
/**
 * Kernel's own reviews (KERNEL-549). `[team] reviewer = "kernel-reviewer"` picks Kernel's code review. Kernel's Theo ran
 * under this id until KERNEL-553, so a review workspace from then still finds him by it.
 */
export const KERNEL_REVIEWER = 'kernel-reviewer'
/** `[team] reviewer = "none"`: the room has no reviewer and Kernel's code review stays out. */
export const NO_REVIEWER = 'none'
export const RESERVED_AGENT_IDS: readonly string[] = [KERNEL_LEAD, KERNEL_REVIEWER]

/**
 * What a room's reviewer picker shows: the agent that reviews, else `none` when `[team]` turns review off, else Kernel's
 * code review, which runs when no agent reviews (KERNEL-553).
 */
export const reviewerChoice = (team: AgentDef[], config?: TeamConfig): string =>
  team.find((a) => a.reviewer)?.id ?? (config?.reviewer === NO_REVIEWER ? NO_REVIEWER : KERNEL_REVIEWER)

/** Whether `a` reviews this room's PRs. An agent Kernel didn't resolve, as in tests and fixtures, falls back to its role. */
export const isReviewer = (a: AgentDef): boolean => a.reviewer ?? (!a.lead && !a.retired && /\breview/i.test(a.role))

/** Whether the Lead can hand `a` a task. An agent Kernel didn't resolve takes tasks unless it leads. */
export const takesTasks = (a: AgentDef): boolean => a.member ?? !a.lead
