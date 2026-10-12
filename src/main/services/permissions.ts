import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { Decision } from '@shared/types'
import type { AppSettings } from './settings'
import type { RunnerHost } from './providers/types'
import { needsUser } from './approvals'
import { bashVerdict, roomRule, usesNetwork } from './bashGuard'

// The permission rules both runners apply (KERNEL-434). A runner describes the step, asks `decide`, and turns the answer
// into its own protocol: Claude's canUseTool result or hook output, Codex's approval decision.

type Permissions = AppSettings['permissions']

/** What a step that reaches the network gets while Settings, Permissions has network access off. */
export const NETWORK_OFF = 'Network access is off in Kernel (Settings, Permissions).'

/** What a command on Never allow, or a push to a protected branch, gets. */
export const neverAllowed = (command: string) => `Kernel blocks "${command}" in every room.`

/** Why a command on Always ask goes to the user, for a CLI that takes a reason with an ask. */
export const ALWAYS_ASK = 'On the Always ask list in Kernel.'

/** Kernel's answer about a step: allow it, ask the user, or deny it with a message for the agent. Undefined is no opinion. */
export type Verdict = { behavior: 'allow' } | { behavior: 'ask'; reason: string } | { behavior: 'deny'; message: string } | undefined

/** One step an agent wants to take, as its runner describes it. */
export interface Step {
  /** The tool by Claude Code's name. A Codex command is `Bash`, a Codex file change `Edit` or `Write`. */
  tool: string
  /** A Bash step's command as the agent meant it, without Codex's shell wrapper. */
  command?: string
  /** The step asks for network access itself, apart from what its command does (Codex's network approval). */
  network?: boolean
  /**
   * Inside or outside Codex's sandbox, which decides what the mode lets through (docs/decisions/KERNEL-406.md). Unset on
   * Claude, which runs no sandbox and applies the mode itself before it asks.
   */
  sandbox?: 'inside' | 'outside'
}

/** What a step is decided by. */
export interface Rules {
  permissions: Permissions
  /** The mode the step runs in. Settings, Permissions' own for now. */
  mode: Permissions['mode']
  /** The room's Always allow rules, read only when a command needs them. */
  roomAllow: () => string[]
  /** The workspace has its own worktree, the only place Bypass permissions applies. */
  worktree: boolean
}

/** The rules for a runner's next step, read from Settings, Permissions and the room as they stand now. */
export function rulesOf(host: Pick<RunnerHost, 'settings' | 'roomAllow' | 'workspace'>): Rules {
  const permissions = host.settings().permissions
  return { permissions, mode: permissions.mode, roomAllow: () => host.roomAllow(), worktree: host.workspace.mode === 'worktree' }
}

const ALLOW: Verdict = { behavior: 'allow' }

/** Kernel's lists on one command: Never allow and protected-branch pushes deny, a room's Always allow rule allows, Always ask asks. */
export function guardVerdict(command: string, rules: Rules): Verdict {
  const v = bashVerdict(command, rules.permissions, rules.roomAllow())
  if (v === 'deny') return { behavior: 'deny', message: neverAllowed(command) }
  if (v === 'allow') return ALLOW
  if (v === 'ask') return { behavior: 'ask', reason: ALWAYS_ASK }
  return undefined
}

/**
 * A step as Kernel decides it, in order: Kernel's own tools allow, Network off denies, then the Bash lists, then the mode.
 * Undefined leaves it to the user, since a runner only asks about a step its CLI would ask the user about.
 */
export function decide(step: Step, rules: Rules): Verdict {
  if (step.tool.startsWith('mcp__kernel__')) return ALLOW
  if (rules.permissions.network === false && (WEB_TOOLS.has(step.tool) || step.network || (step.command && usesNetwork(step.command)))) return { behavior: 'deny', message: NETWORK_OFF }
  return (step.command ? guardVerdict(step.command, rules) : undefined) ?? byMode(step, rules)
}

const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

/**
 * What the mode lets through of a step the lists left open. Inside Codex's sandbox, every mode but Manual (`default`)
 * accepts, as Claude Code's Accept edits takes an edit in the workspace. Outside it, the user decides in every mode
 * (KERNEL-406). On Claude, Bypass permissions takes the rest in a worktree, but never a question or a plan.
 */
function byMode(step: Step, rules: Rules): Verdict {
  if (needsUser(step.tool) || step.sandbox === 'outside') return undefined
  if (step.sandbox === 'inside') return rules.mode !== 'default' ? ALLOW : undefined
  return rules.mode === 'bypassPermissions' && rules.worktree ? ALLOW : undefined
}

/**
 * Always allow on a command saves a rule for the room: Claude Code's suggestion when it is one Bash rule that may be saved,
 * else the command itself.
 */
export function saveAlwaysAllow(host: Pick<RunnerHost, 'allowInRoom'>, step: Step, decision: Decision | undefined, o: { suggestions?: PermissionUpdate[]; suppressAlwaysAllowRule?: boolean } = {}) {
  if (decision?.behavior === 'allow' && decision.always && step.command) host.allowInRoom(roomRule(step.command, o.suggestions, o.suppressAlwaysAllowRule))
}
