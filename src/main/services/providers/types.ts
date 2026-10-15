import type { ChildProcess } from 'node:child_process'
import type { AgentDef, Approval, AskedQuestion, Chat, ChatItem, ChatPart, Decision, Effort, TokenCounts, Workspace } from '@shared/types'
import type { Retry } from '@shared/ipc'
import type { AppSettings } from '../settings'
import type { RunMode } from '../permissions'
import type { LimitPatch } from './limits'
import type { McpReport } from '../mcp'

// The seam between Sessions and the CLI a chat runs on (KERNEL-406). Sessions keeps the orchestration: queues, pauses,
// limits, cut-off, carry-on, the idle stop, pids and hand-offs. A runner speaks one CLI's protocol for one chat's process.

/** One chat's live process on its provider. Sessions calls these, and the runner reports back through its `RunnerHost`. */
export interface Runner {
  /** Start reading what the process writes. Sessions calls it once the chat's Live holds this runner. */
  start(): void
  /** Send a user turn into the session. */
  push(parts: ChatPart[]): void
  /** Stop the running turn. The turn's own end still arrives and goes to `RunnerHost.turnEnded`. */
  interrupt(): Promise<void>
  setModel(model: string): Promise<void>
  setEffort(effort: Effort): Promise<void>
  /**
   * Run the next steps in `mode` (KERNEL-447): plan mode on or off, or the chat's permission mode changed. Claude switches the
   * live session, and a switch it refuses leaves a note in the chat. Codex takes it from its next turn.
   */
  setMode(mode: RunMode): Promise<void>
  /** Ask the provider for the usage windows, which arrive through `RunnerHost.mergeLimits`. */
  usage(): Promise<void>
  /** Read the context window use again, which arrives through `RunnerHost.setContext`. */
  context(): Promise<void>
  /** Close the session's input and abort it. What the process writes after this is ignored. */
  close(): void
  /** End the process now, and the shells its tools started, when Kernel quits mid-step. */
  kill(): void
  /** True once `close` ran. */
  readonly closed: boolean
}

/** A process a runner started, and the end of what it wrote to stderr, for the note when it dies. */
export interface Proc { child?: ChildProcess; stderr: string }

/** What a runner asks of the user: a tool to allow, a question, or a plan. Sessions fills in where it comes from. */
export interface Ask {
  kind: Approval['kind']
  toolName?: string
  input?: unknown
  title: string
  detail?: string
  options?: string[]
  questions?: AskedQuestion[]
  /** Why Kernel asked, for the card's reason line (`Approval.reason`). */
  reason?: string
}

/** What Sessions does for one chat's runner. Each method acts on that chat and its current process. */
export interface RunnerHost {
  readonly chatId: string
  chat(): Chat
  readonly workspace: Workspace
  readonly agent: AgentDef | undefined
  settings(): AppSettings
  /** The mode the chat runs in now (`effectiveMode`), read at every step, so a change applies at once (KERNEL-447). */
  mode(): RunMode
  /** Bash rules the user allowed for the project, and saving one ("Always allow in this project"). */
  projectAllow(): string[]
  allowInProject(rule: string): void
  /** The same for MCP and web tools, as Claude Code writes a rule: `mcp__linear__get_issue` (`Project.allowTools`, KERNEL-454). */
  projectTools(): string[]
  allowToolInProject(rule: string): void
  /** The pause or the hold on every project that a tool call waits on, while one stands. */
  held(): Promise<void> | undefined
  /** Starts the CLI as Kernel starts every agent process: its own process group, its pid saved until it exits. */
  spawn(command: string, args: string[], o: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal }, proc: Proc): ChildProcess
  /** The session id Kernel knows the session by, so the hook server never mistakes its hooks for an outside session's. */
  managed(sessionId: string): void

  /** Save a row in the chat's transcript and show it. */
  item(item: ChatItem): void
  /**
   * The session is up under `sessionId`, which the chat resumes by from now on. Starts the turn's working status.
   * `billedBy` is who pays, when the CLI says (Claude's `apiKeySource`, where 'none' means the plan). `mcpServers` are the
   * session's MCP servers with their status, which the project keeps, checked once per chat against the agent file's tools
   * line (KERNEL-464).
   */
  sessionStarted(sessionId: string, o?: { billedBy?: string; mcpServers?: McpReport[] }): void
  /** The provider reported how some of the session's MCP servers are doing, mid-session (Codex). The project keeps it (KERNEL-464). */
  mcpStatus(servers: McpReport[]): void
  /** A hook refused the step. */
  blocked(event: string, output: string): void
  /** A tool call went through, which ends a PreToolUse refusal. */
  toolSucceeded(): void
  /** The process's background work changed: shells, subagents, monitors. */
  setTasks(ids: string[]): void
  /** The provider is retrying an overloaded request. */
  retrying(retry: Retry): void
  /** A reply or the turn's end came, so a retry banner goes. */
  clearRetry(): void
  /** The provider's API answered without an error, so the network works, whatever DNS says (KERNEL-231). */
  reached(): void
  /** The agent sent a message. Ends a retry banner, and Kernel looks for the session's title. */
  replied(): void
  /** The turn hit a sign-out or a dropped connection. `notify` shows the banner now. */
  failed(failure: 'auth' | 'network', o?: { notify?: boolean }): void
  /** The running turn hit a usage limit, so it ends early. `always` marks it even before the turn shows as running. */
  limited(o?: { always?: boolean }): void
  mergeLimits(patches: LimitPatch[]): void
  /** The CLI started a fresh conversation in the chat (/clear and its kind). */
  reset(trigger?: string): void
  /** Context window use, 0 to 100, with the breakdown when the CLI gives one. */
  setContext(context: number, usage?: Chat['contextUsage']): void
  /**
   * What the running turn read and cached, reported just before it ends (KERNEL-842): the turn's counts, its first model
   * call's, and the chat's size in tokens after its last call when the provider says.
   */
  turnUsage(u: TurnUsage): void
  /** The running turn ended. `tooLong`: the chat no longer fits the model's context window, so the turn never ran (KERNEL-844). */
  turnEnded(t: { id: string; ok: boolean; durationMs?: number; error?: string; tooLong?: true }): void
  /** The provider's guess at the user's next message, after a turn ended (Claude's prompt suggestions, KERNEL-530). */
  suggested(text: string): void
  /** The session this process resumed is gone. True when Sessions moved the turn to a fresh session. */
  sessionGone(): boolean
  /** The process ended. `reason` is null when Kernel stopped it, else why it went away ('' when it said nothing). */
  ended(reason: string | null, o?: { error?: boolean }): void
  /** True once this process no longer owns the chat, or Kernel quit and ended it: what it still writes is dropped. */
  stale(): boolean
  /** Kernel's quit interrupted this turn, so a tool it stopped says so (KERNEL-396). */
  readonly quitting: boolean
  /** The user stopped this turn. */
  readonly interrupted: boolean

  /** Put a request in front of the user and wait for the answer. Undefined when nobody answered in time, or `timeoutMs` passed. */
  ask(a: Ask, o: { signal?: AbortSignal; timeoutMs?: number }): Promise<Decision | undefined>
  /**
   * Show a plan for approval and wait. An approved plan takes the chat out of plan mode and starts a Lead's hand-off.
   * `toolName` and `input` are the call that asked, when the plan came from a tool such as ExitPlanMode.
   */
  requestPlan(plan: string, o: { signal?: AbortSignal; toolName?: string; input?: unknown }): Promise<Decision | undefined>
  /** The approved plan's note, once, for Claude's ExitPlanMode answer. A Codex approval goes as a message instead. */
  afterPlan(): string | undefined
  /** A Lead's one reminder at a stop before anything was handed off. */
  handoffAtStop(): string | undefined
  /** Send Kernel's own message as the chat's next turn, after what is queued: a plan's approval, a hand-off reminder (Codex). */
  followUp(text: string): void
}

/** A turn's token counts as a runner reports them (`RunnerHost.turnUsage`, KERNEL-842). */
export interface TurnUsage extends TokenCounts { first?: TokenCounts; context?: number }
