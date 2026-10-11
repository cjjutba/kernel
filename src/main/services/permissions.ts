import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, Decision, PermissionMode, Room, Workspace } from '@shared/types'
import { PERMISSION_MODES } from '@shared/types'
import type { AppSettings } from './settings'
import type { RunnerHost } from './providers/types'
import { needsUser } from './approvals'
import { bashVerdict, pushMightReach, roomRule, usesNetwork } from './bashGuard'

// The permission rules both runners apply (KERNEL-434). A runner describes the step, asks `decide`, and turns the answer
// into its own protocol: Claude's canUseTool result or hook output, Codex's approval decision. The mode a chat runs in is
// `effectiveMode` (KERNEL-447).

type Permissions = AppSettings['permissions']

/** The mode a chat's steps run in: one of the app's four, or `plan` while the chat plans. */
export type RunMode = PermissionMode | 'plan'

/** What the modes are called in the app, for notes. */
export const MODE_NAMES: Record<RunMode, string> = { default: 'Manual', acceptEdits: 'Accept edits', auto: 'Auto', bypassPermissions: 'Bypass permissions', plan: 'Plan' }

/** The modes from the strictest to the loosest. Plan only reads. Auto lets a classifier take commands that Accept edits asks about. */
const STRICTEST_FIRST: RunMode[] = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']

/** The stricter of two modes. */
export const stricter = <M extends RunMode>(a: M, b: M): M => (STRICTEST_FIRST.indexOf(a) <= STRICTEST_FIRST.indexOf(b) ? a : b)

/**
 * What a chat can run now, as far as Kernel knows: Auto for its provider and model, and Bypass permissions under admin
 * policy. A read still under way counts as no, so a chat starts in the safer mode and moves once Kernel knows.
 */
export interface ChatAvailability { auto: boolean; bypass: boolean }

/** The workspace may run Bypass permissions: it has its own worktree, or Settings, Permissions has Only in worktrees off. Unset counts as on. */
export const bypassFits = (ws: Pick<Workspace, 'mode'>, settings: Pick<AppSettings, 'permissions'>) => ws.mode === 'worktree' || settings.permissions.bypassOnlyInWorktrees === false

/**
 * The mode a chat runs in (KERNEL-447). Plan comes first, then the chat's own mode, the room's and the app's. An agent file's
 * `permissionMode` only tightens it: its `plan` and `dontAsk` count as Manual, the strictest mode that still builds, since
 * Kernel's own plan step owns plan mode. Auto falls back to Accept edits where the chat can't run it, and so does Bypass
 * permissions where policy turns it off or the workspace doesn't fit it. A mode Kernel doesn't know counts as Manual.
 */
export function effectiveMode(chat: Pick<Chat, 'plan' | 'mode'>, ws: Pick<Workspace, 'mode'>, room: Pick<Room, 'permissionMode'> | undefined, settings: Pick<AppSettings, 'permissions'>, avail: ChatAvailability, agent?: Pick<AgentDef, 'permissionMode'>): RunMode {
  if (chat.plan) return 'plan'
  let mode = known(chat.mode) ?? known(room?.permissionMode) ?? known(settings.permissions.mode) ?? 'default'
  const file = agent?.permissionMode
  if (file) mode = stricter(mode, known(file) ?? 'default')
  if (mode === 'auto' && !avail.auto) return 'acceptEdits'
  if (mode === 'bypassPermissions' && !(avail.bypass && bypassFits(ws, settings))) return 'acceptEdits'
  return mode
}

const known = (mode: string | undefined): PermissionMode | undefined => (PERMISSION_MODES as readonly string[]).includes(mode ?? '') ? mode as PermissionMode : undefined

/** What a step that reaches the network gets while Settings, Permissions has network access off. */
export const NETWORK_OFF = 'Network access is off in Kernel (Settings, Permissions).'

/** What a command on Never allow, or a push to a protected branch, gets. */
export const neverAllowed = (command: string) => `Kernel blocks "${command}" in every room.`

/** What a push that might reach a protected branch gets in Bypass permissions, with the push that works instead. */
export function pushOwnBranch(branches: string[], branch?: string): string {
  const named = branches.length > 1 ? `${branches.slice(0, -1).join(', ')} or ${branches[branches.length - 1]}` : branches[0]
  const own = branch && !branches.includes(branch) ? `: git push origin ${branch}` : ''
  return `Kernel blocks pushes that might reach ${named} in Bypass permissions. Push your own branch by name${own}.`
}

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
  /** The mode the step runs in (`effectiveMode`). */
  mode: RunMode
  /** The room's Always allow rules, read only when a command needs them. */
  roomAllow: () => string[]
  /** The workspace's branch, which the refusal of a push in Bypass permissions names as the one to push. */
  branch?: string
}

/** The rules for a runner's next step: Settings, Permissions and the room as they stand now, in `mode`, else the chat's mode now. */
export function rulesOf(host: Pick<RunnerHost, 'settings' | 'roomAllow' | 'workspace' | 'mode'>, mode: RunMode = host.mode()): Rules {
  return { permissions: host.settings().permissions, mode, roomAllow: () => host.roomAllow(), branch: host.workspace.branch }
}

const ALLOW: Verdict = { behavior: 'allow' }

/**
 * Kernel's lists on one command: Never allow and protected-branch pushes deny, a room's Always allow rule allows, Always ask
 * asks. In Bypass permissions only the denials hold, and a push that might reach a protected branch is one of them (KERNEL-447).
 */
export function guardVerdict(command: string, rules: Rules): Verdict {
  const v = bashVerdict(command, rules.permissions, rules.roomAllow())
  if (rules.mode === 'bypassPermissions') {
    const branches = rules.permissions.protectedBranches ?? []
    if (pushMightReach(command, branches)) return { behavior: 'deny', message: pushOwnBranch(branches, rules.branch) }
    return v === 'deny' ? { behavior: 'deny', message: neverAllowed(command) } : undefined
  }
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

/** The modes that take a file edit without asking. */
const TAKES_EDITS = new Set<RunMode>(['acceptEdits', 'auto', 'bypassPermissions'])

/**
 * What the mode lets through of a step the lists left open, on Codex. Inside its sandbox every mode that takes edits accepts,
 * as Claude Code's Accept edits takes an edit in the workspace. Outside it the user decides, as KERNEL-406 set, except in
 * Bypass permissions, which accepts (KERNEL-447). A question or a plan always goes to the user.
 *
 * A Claude step gets no opinion in any mode. Claude Code applies the mode before it asks, so in Bypass permissions what
 * reaches Kernel is a step the CLI insists on asking about, such as the critical-path `rm`, and the user answers it (KERNEL-433).
 */
function byMode(step: Step, rules: Rules): Verdict {
  if (needsUser(step.tool) || !step.sandbox) return undefined
  if (rules.mode === 'bypassPermissions') return ALLOW
  return step.sandbox === 'inside' && TAKES_EDITS.has(rules.mode) ? ALLOW : undefined
}

/**
 * Always allow on a command saves a rule for the room: Claude Code's suggestion when it is one Bash rule that may be saved,
 * else the command itself.
 */
export function saveAlwaysAllow(host: Pick<RunnerHost, 'allowInRoom'>, step: Step, decision: Decision | undefined, o: { suggestions?: PermissionUpdate[]; suppressAlwaysAllowRule?: boolean } = {}) {
  if (decision?.behavior === 'allow' && decision.always && step.command) host.allowInRoom(roomRule(step.command, o.suggestions, o.suppressAlwaysAllowRule))
}
