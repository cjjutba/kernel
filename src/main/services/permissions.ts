import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, ChatRunMode, Decision, ModeReason, ModeScope, PermissionMode, Room, RunMode, Workspace } from '@shared/types'
import { PERMISSION_MODES } from '@shared/types'
import type { AppSettings } from './settings'
import type { RunnerHost } from './providers/types'
import { needsUser } from './approvals'
import { bashVerdict, pushMightReach, roomRule, usesNetwork } from './bashGuard'

// The permission rules both runners apply (KERNEL-434). A runner describes the step, asks `decide`, and turns the answer
// into its own protocol: Claude's canUseTool result or hook output, Codex's approval decision. The mode a chat runs in is
// `effectiveMode` (KERNEL-447).

type Permissions = AppSettings['permissions']

/** Moved to the shared contract (KERNEL-572). Exported here too for what imports it from here. */
export type { RunMode }

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
export function effectiveMode(...args: Parameters<typeof chatMode>): RunMode { return chatMode(...args).mode }

/**
 * `effectiveMode` with the mode picked for the chat, where it was picked, and why the chat runs in another (KERNEL-572). The
 * first step that moves it off the pick names the reason, so a Bypass pick that an agent file turns into Auto, which the
 * chat can't run, reads as the agent file's doing.
 */
export function chatMode(chat: Pick<Chat, 'plan' | 'mode'>, ws: Pick<Workspace, 'mode'>, room: Pick<Room, 'permissionMode'> | undefined, settings: Pick<AppSettings, 'permissions'>, avail: ChatAvailability, agent?: Pick<AgentDef, 'permissionMode'>): ChatRunMode {
  const own = known(chat.mode)
  const roomMode = known(room?.permissionMode)
  const [picked, pickedIn]: [PermissionMode, ModeScope] = own ? [own, 'chat'] : roomMode ? [roomMode, 'room'] : [known(settings.permissions.mode) ?? 'default', 'app']
  const runs = (mode: RunMode, why?: ModeReason): ChatRunMode => ({ mode, picked, pickedIn, ...(why ? { why } : {}) })
  if (chat.plan) return runs('plan', 'plan')
  const file = agent?.permissionMode
  const mode = file ? stricter(picked, known(file) ?? 'default') : picked
  const tightened = mode !== picked ? 'agentFile' : undefined
  if (mode === 'auto' && !avail.auto) return runs('acceptEdits', tightened ?? 'noAuto')
  // The workspace first: Kernel reads the policy only for one that fits Bypass permissions.
  if (mode === 'bypassPermissions' && !bypassFits(ws, settings)) return runs('acceptEdits', 'worktreesOnly')
  if (mode === 'bypassPermissions' && !avail.bypass) return runs('acceptEdits', 'noBypass')
  return runs(mode, tightened)
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
  /** The tool's input, which a room's tool rule may read: a WebFetch's `url`. */
  input?: unknown
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
  /**
   * Claude Code may run the step in Bypass permissions whatever `mode` says: its process can take bypass, so a switch out of
   * it may be pending or refused, and a subagent may run in it. Bypass's denials hold then too, on top of `mode`'s asks.
   */
  mayBypass?: boolean
  /** The room's Always allow rules, read only when a command needs them. */
  roomAllow: () => string[]
  /** The room's Always allow rules for MCP and web tools (`Room.allowTools`), read only when such a step needs them. */
  roomTools: () => string[]
  /** The workspace's branch, which the refusal of a push in Bypass permissions names as the one to push. */
  branch?: string
}

/** The rules for a runner's next step: Settings, Permissions and the room as they stand now, in `mode`, else the chat's mode now. */
export function rulesOf(host: Pick<RunnerHost, 'settings' | 'roomAllow' | 'roomTools' | 'workspace' | 'mode'>, mode: RunMode = host.mode()): Rules {
  return { permissions: host.settings().permissions, mode, roomAllow: () => host.roomAllow(), roomTools: () => host.roomTools(), branch: host.workspace.branch }
}

const ALLOW: Verdict = { behavior: 'allow' }

/**
 * Kernel's lists on one command: Never allow and protected-branch pushes deny, a room's Always allow rule allows, Always ask
 * asks. In Bypass permissions only the denials hold, and a push that might reach a protected branch is one of them. That
 * denial also holds wherever Claude Code may still run in bypass (`mayBypass`), since nothing would ask there (KERNEL-447).
 */
export function guardVerdict(command: string, rules: Rules): Verdict {
  const bypass = rules.mode === 'bypassPermissions'
  const branches = rules.permissions.protectedBranches ?? []
  if ((bypass || rules.mayBypass) && pushMightReach(command, branches)) return { behavior: 'deny', message: pushOwnBranch(branches, rules.branch) }
  const v = bashVerdict(command, rules.permissions, rules.roomAllow())
  if (bypass) return v === 'deny' ? { behavior: 'deny', message: neverAllowed(command) } : undefined
  if (v === 'deny') return { behavior: 'deny', message: neverAllowed(command) }
  if (v === 'allow') return ALLOW
  if (v === 'ask') return { behavior: 'ask', reason: ALWAYS_ASK }
  return undefined
}

/**
 * A step as Kernel decides it, in order: Kernel's own tools allow, Network off denies, then the Bash lists or the room's tool
 * rules, then the mode. Undefined leaves it to the user, since a runner only asks about a step its CLI would ask the user about.
 */
export function decide(step: Step, rules: Rules): Verdict {
  if (step.tool.startsWith('mcp__kernel__')) return ALLOW
  if (networkOff(step, rules)) return { behavior: 'deny', message: NETWORK_OFF }
  return (step.command ? guardVerdict(step.command, rules) : roomTool(step, rules)) ?? byMode(step, rules)
}

const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

const networkOff = (step: Step, rules: Rules) => rules.permissions.network === false && (WEB_TOOLS.has(step.tool) || !!step.network || (!!step.command && usesNetwork(step.command)))

/** The modes in which a room rule answers in Claude's PreToolUse hook. */
const HOOK_ALLOWS = new Set<RunMode>(['default', 'acceptEdits', 'auto'])

/**
 * Kernel's answer about a Claude step in its PreToolUse hook: the Bash lists for a command, else the room's tool rules
 * (KERNEL-454). A room rule allows there, so Auto mode's classifier can't refuse a step the user allowed, in Manual, Accept
 * edits and Auto. In plan mode it gives no opinion, since a hook's allow would run a step plan mode holds back, and canUseTool
 * still allows it if Claude Code asks. Bypass permissions reads no room rule. Network off denies before any rule.
 */
export function hookVerdict(step: Step, rules: Rules): Verdict {
  const v = step.command ? guardVerdict(step.command, rules)
    : networkOff(step, rules) ? { behavior: 'deny' as const, message: NETWORK_OFF } : roomTool(step, rules)
  return v?.behavior === 'allow' && !HOOK_ALLOWS.has(rules.mode) ? undefined : v
}

/** The tools a room's tool rule can cover: MCP tools and the web tools. Never a file tool, so a rule can't loosen the mode. */
const takesToolRule = (tool: string) => tool.startsWith('mcp__') || WEB_TOOLS.has(tool)

/** A room's Always allow rule for a step that isn't a command (KERNEL-454). Bypass permissions reads no room rule (KERNEL-447). */
function roomTool(step: Step, rules: Rules): Verdict {
  if (rules.mode === 'bypassPermissions' || !takesToolRule(step.tool)) return undefined
  return matchesToolRule(step.tool, step.input, rules.roomTools()) ? ALLOW : undefined
}

/** The host a WebFetch step fetches from, lowercase, or undefined when its input has no URL. */
function hostOf(input: unknown): string | undefined {
  const url = (input as { url?: unknown } | undefined)?.url
  if (typeof url !== 'string') return undefined
  try { return new URL(url).hostname || undefined } catch { return undefined }
}

/**
 * The rule Always allow saves on the room for a tool that isn't Bash, as Claude Code writes one (KERNEL-454): the MCP tool's
 * name, `WebSearch`, or `WebFetch(domain:<host>)`. Undefined for a tool no room rule covers, such as Edit.
 */
export function toolRule(tool: string, input: unknown): string | undefined {
  if (tool === 'WebFetch') { const host = hostOf(input); return host ? `WebFetch(domain:${host})` : undefined }
  return takesToolRule(tool) ? tool : undefined
}

/** `mcp__<server>` or `mcp__<server>__*`, a rule for every tool of one server. */
const SERVER_RULE = /^mcp__((?:[^_]|_(?!_))+)(?:__\*)?$/

/**
 * Whether one of the room's tool rules covers a step, as Claude Code reads the rule (KERNEL-454): the tool's own name,
 * `mcp__<server>` or `mcp__<server>__*` for every tool of that server, and `WebFetch(domain:<host>)` for a fetch from that
 * host. Only MCP and web tools: a rule naming any other tool covers nothing.
 */
export function matchesToolRule(tool: string, input: unknown, rules: string[]): boolean {
  if (!takesToolRule(tool)) return false
  return rules.some((raw) => {
    const r = raw.trim()
    if (r === tool) return true
    const server = SERVER_RULE.exec(r)?.[1]
    if (server && tool.startsWith(`mcp__${server}__`)) return true
    const domain = /^WebFetch\(domain:([^)]+)\)$/.exec(r)?.[1]
    return tool === 'WebFetch' && !!domain && hostOf(input) === domain.trim().toLowerCase()
  })
}

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
 * Always allow saves a rule for the room. On a command it is Claude Code's suggestion when that is one Bash rule that may be
 * saved, else the command itself. On an MCP or web tool it is `toolRule`'s, in `Room.allowTools`, unless Claude Code says the
 * ask mustn't offer one (KERNEL-454). True when it saved a rule, so canUseTool doesn't also hand Claude Code's suggestions
 * back, which would land in the worktree's own settings and go with it.
 */
export function saveAlwaysAllow(host: Pick<RunnerHost, 'allowInRoom' | 'allowToolInRoom'>, step: Step, decision: Decision | undefined, o: { suggestions?: PermissionUpdate[]; suppressAlwaysAllowRule?: boolean } = {}): boolean {
  if (decision?.behavior !== 'allow' || !decision.always) return false
  if (step.command) { host.allowInRoom(roomRule(step.command, o.suggestions, o.suppressAlwaysAllowRule)); return true }
  const rule = o.suppressAlwaysAllowRule ? undefined : toolRule(step.tool, step.input)
  if (rule) host.allowToolInRoom(rule)
  return !!rule
}
