import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Options, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, AgentStatus, BuiltinCommand, Chat, ChatItem, ChatPart, CodexPersonality, Decision, Provider, MessageFrom, QueuedMessage, QueueReason, RateLimit, TeamUpdate, Workspace } from '@shared/types'
import type { Retry } from '@shared/ipc'
import { linkText } from '@shared/links'
import { nearLimit } from '@shared/usage'
import { isKernelUpdate } from '@shared/teamUpdate'
import type { Store } from '../db'
import { bus } from '../bus'
import type { Approvals } from './approvals'
import { blockingLimit, limitedModels, WINDOW_MODEL, type Failure } from './health'
import { forProvider, Handoffs, HANDOFF_NOW, LEAD_RULE } from './handoff'
import { missingServers, type MissingServer } from './agentTools'
import type { McpReport } from './mcp'
import { revisedPlanFile, savePlan } from './plans'
import type { AppSettings } from './settings'
import { buildEnv, kernelVars } from './env'
import { ClaudeRunner, claudeCommands, probeClaudeUsage, TOOL_STOPPED } from './providers/claude'
import { limitKey, mergeLimit, type LimitPatch } from './providers/limits'
import { CodexRunner } from './providers/codex/runner'
import { chatProvider, limitProvider } from '@shared/providers'
import type { Ask, Proc, Runner, RunnerHost } from './providers/types'

// Moved behind the provider seam (KERNEL-406). Exported here too for what imports them from Sessions.
export { askedQuestions, packagedClaude, InputQueue, toUserMessage, builtinCommands, sessionEnv, AGENT_TEAMS, switchedOff, limitsFromEvent, limitsFromUsage, HOLD_TIMEOUT_SEC, SESSION_GONE, TOOL_STOPPED } from './providers/claude'
export { limitKey, mergeLimit, type LimitPatch } from './providers/limits'

interface Live {
  /** The chat's process on its provider (KERNEL-406). */
  runner: Runner
  running: boolean; interrupted: boolean
  /** Background tasks (shells, subagents, monitors) the process is running, from its latest background_tasks_changed. */
  tasks: Set<string>
  /** Set by sendNow: the interrupted turn is followed by the queue. A plain Stop is not. */
  sendNext?: boolean
  /** An api_retry is counting down. The next reply or result clears the banner. Kept for a window that loads meanwhile (KERNEL-340). */
  retry?: Retry
  /** Claude Code answered this turn with a usage limit, so the turn ended early. */
  limited?: boolean
  /** This turn was /clear. Its result row is left out, so the cleared chat starts empty. */
  cleared?: boolean
  /** Called once when the running turn ends. Set by `shutdown`, which waits for interrupted turns. */
  whenIdle?: () => void
  /**
   * Kernel's quit interrupted this turn. Claude Code answers a running tool with its own rejection text, which reads as the
   * user refusing it, so the row says Kernel quit instead (KERNEL-396).
   */
  quit?: boolean
  /** This turn carries on a chat a quit cut off (KERNEL-215): the nudge, or what was queued before it. */
  carrying?: boolean
  /** This turn hit a sign-out or a dropped connection. */
  failed?: 'auth' | 'network'
  /** The account the process runs on, which its usage windows belong to. Undefined is the CLI's own login (KERNEL-406). */
  account?: string
  /** The message that started the running turn, and its row, which a fresh session sends again when the resumed one is gone. */
  sent?: ChatPart[]
  sentItem?: ChatItem & { kind: 'user' }
}

/** A process as started: the binary, and its first argument (a script path when the SDK runs node or bun). */
interface Spawned { command: string; arg?: string }
interface SavedPid extends Spawned { pid: number }

/**
 * What Kernel knows about a chat's turns that outlives its process, so an idle stop changes no answer (KERNEL-183). Only
 * `stop()` forgets it.
 */
interface Turns {
  /** Who sent the message that started the running turn, or the last one: Kernel, the Lead, or the user when unset (KERNEL-116). */
  from?: MessageFrom
  /**
   * The hook event that refused a step, while the agent has not moved on. A new message ends it. After PreToolUse, so does a
   * later tool call that succeeds. After the hooks that refuse to let the agent finish (Stop and the task hooks), so does a turn
   * that ends successfully. A turn that ends any other way keeps it, since the agent gave up.
   * Known limit: with parallel tool calls, another call in the same message that succeeds ends a PreToolUse block at once.
   */
  blocked?: string
}

/** How many chats a usage limit cut off restart at once when it lifts. Each next one starts when one ends its turn (KERNEL-220). */
export const RESUME_AT_ONCE = 2

/** How long a chat with nothing to do keeps its Claude Code process before Kernel stops it. The next message resumes it (KERNEL-183). */
export const IDLE_STOP_MS = 10 * 60_000

export interface SessionDeps {
  store: Store
  approvals: Approvals
  settings: () => AppSettings
  agentFor: (ws: Workspace) => AgentDef | undefined
  /** In-process MCP servers this agent may use (Kernel's own tools for the lead). */
  mcpFor: (ws: Workspace, agent: AgentDef | undefined, chat: Chat) => Options['mcpServers']
  /**
   * What a Codex chat runs (KERNEL-406): the executable, the active account's CODEX_HOME, the personality, and Kernel's
   * own tools with their instructions, which Codex gets as dynamic tools. Without it a Codex chat can't start.
   */
  codexFor?: (ws: Workspace, agent: AgentDef | undefined, chat: Chat) => { bin?: string; home?: string; personality: CodexPersonality; tools: SdkMcpToolDefinition<any>[]; instructions?: string }
  /** The skills and MCP servers switched off for the workspace's room in Settings, Skills and MCP (KERNEL-226). */
  disabledFor?: (ws: Workspace) => { skills: string[]; mcp: string[] } | undefined
  /** The room's `[mcp.aliases]`, which the agent file's tools line reads through (KERNEL-464). */
  aliasesFor?: (ws: Workspace) => Record<string, string> | undefined
  /**
   * A session reported how its MCP servers are doing. Returns every report the room holds for that provider since, which
   * may name servers this session's report doesn't yet, such as claude.ai connectors that join late (KERNEL-464).
   */
  onMcp?: (ws: Workspace, provider: Provider, servers: McpReport[]) => McpReport[]
  /** Kernel's own rule for this workspace, appended to the agent's prompt, such as a reviewer's (KERNEL-130). */
  rulesFor?: (ws: Workspace, agent: AgentDef | undefined) => string | undefined
  /** Bash rules the user allowed for the whole room. */
  roomAllow: (roomId: string) => string[]
  /** The account a provider runs on now, undefined for the CLI's own login (KERNEL-406). */
  accountFor?: (provider: Provider) => string | undefined
  /** What a Claude chat's process adds to its environment for the active account, such as its token (KERNEL-406). */
  claudeEnv?: () => Record<string, string>
  /** The workspace's variables from `Kernel.envFor` (KERNEL-247). Without it a session gets the Mac's and Kernel's own. */
  envFor?: (ws: Workspace) => Record<string, string>
  allowInRoom: (roomId: string, rule: string) => void
  /** The agent sent a message, its subagents' included. Kernel looks for the session's title then. */
  onReply?: (ws: Workspace, chat: Chat) => void
  /** Claude's API answered: a message with no `error`, or a `success` result without `is_error`. The network works, whatever DNS says (KERNEL-231). */
  onReached?: () => void
  /** Claude Code started a fresh conversation in the chat. `trigger` is the SDK's: 'clear' for /clear, absent from older emitters (KERNEL-202). */
  onReset?: (ws: Workspace, chat: Chat, trigger?: string) => void
  /** A turn ended. `ok` is false for an error; `interrupted` is true when the user stopped it; `by` sent the message that started it. */
  onTurnDone?: (ws: Workspace, chat: Chat, turn: { ok: boolean; interrupted: boolean; by: TurnBy }) => void
  /**
   * The session's process ended without being stopped. `midTurn` is true when a turn was running, so the agent's work
   * stopped halfway; an idle process that went away harms nothing, since the next message starts a new one. Stop,
   * archive and quit don't call this. A chat a quit or a crash of Kernel cut off mid-turn is reported at the next launch,
   * with `resumed` true, since it carries on by itself (KERNEL-215).
   */
  onExit?: (ws: Workspace, chat: Chat, reason: string, midTurn: boolean, resumed: boolean) => void
  /** A session hit something the banners show: a sign-out, a dropped connection. Kernel checks it and tells the renderer. */
  onFailure?: (failure: Failure, ws: Workspace, provider: Provider) => void
  /** Usage windows changed. Kernel pauses rooms on an account-wide rejection and schedules the reset. */
  onLimits?: (limits: RateLimit[]) => void
  /** The chats a limit or a quit stopped changed. Kernel saves them, so they still carry on after a restart. */
  onCutOff?: (cutOff: Record<string, CutOffReason>) => void
  /** What chats held for setup are holding changed. Kernel saves it, so a brief survives a restart (KERNEL-128). */
  onHeld?: (held: Record<string, QueuedMessage[]>) => void
}

/** Who sent a message the user didn't type, and the Team update card it carries (KERNEL-116). */
export interface Sender { from?: MessageFrom; update?: TeamUpdate }

/** Who started a turn. */
export type TurnBy = MessageFrom | 'user'

/** What stopped a chat mid-turn that carries on by itself: a usage limit, or Kernel quitting or closing (KERNEL-215). */
export type CutOffReason = 'limit' | 'quit'

/** Moved to the shared contract (KERNEL-271). Exported here too for what imports it from Sessions. */
export type { QueueReason }

/** The sender fields to store on a chat item or queue entry, leaving out the ones that aren't set. */
const sender = (o: Sender): Sender => ({ ...(o.from ? { from: o.from } : {}), ...(o.update ? { update: o.update } : {}) })

/** Setup passed and the brief waits for PRs to merge (KERNEL-259). A chat held while its setup runs or failed waits for setup. */
const heldForMerge = (ws?: Workspace) => ws?.status === 'ready' && !!ws.waitsFor?.held

/** What a chat says once about a server its agent file lists that the session can't use (KERNEL-397, KERNEL-464). */
export function mcpNote(m: MissingServer): string {
  const lists = `This agent's file lists ${m.entry}, but`
  switch (m.status) {
    case 'failed': return `${lists} the MCP server ${m.name} failed to connect.`
    case 'needs-auth': return `${lists} the MCP server ${m.name} needs you to sign in. Sign in with /mcp in Claude Code.`
    case 'disabled': return `${lists} the MCP server ${m.name} is switched off in Claude Code. Turn it on with /mcp.`
    case 'off': return `${lists} the MCP server ${m.name} is switched off in this room. Turn it on in Settings, Skills and MCP.`
    default: return `${lists} no MCP server named ${m.server} is connected.${m.suggestion ? ` Did you mean mcp__${m.suggestion}?` : ''}`
  }
}

export class Sessions {
  private live = new Map<string, Live>()
  /** Per chat, whether or not its process is running. */
  private turns = new Map<string, Turns>()
  /** Idle clocks of live chats between turns. One that runs out stops the process (KERNEL-183). */
  private idle = new Map<string, ReturnType<typeof setTimeout>>()
  /** Chats whose agent changed during a turn or a background task. Their process ends once nothing runs (KERNEL-397). */
  private stale = new Set<string>()
  /** Lead chats with an approved plan and nothing handed off yet (KERNEL-67). The Lead tools end one when they create a workspace. */
  readonly handoffs = new Handoffs()
  private queues = new Map<string, QueuedMessage[]>()
  /** What each held queue last told the renderer it waits for. Computed, never saved with a held brief (KERNEL-271). */
  private reasons = new Map<string, QueueReason | undefined>()
  /** Chats whose queue or reason changed in the current step, sent together by `flushQueues`. */
  private unsent = new Set<string>()
  private managedIds = new Set<string>()
  private limits = new Map<string, RateLimit>()
  private billing = new Map<string, string>()
  /** Chats whose agent file's MCP servers were checked against a session's (once per chat). */
  private mcpChecked = new Set<string>()
  /** Rooms the user (or a limit) paused. Their agents finish the step they are on, then wait at the next tool call. */
  private paused = new Map<string, { open: Promise<void>; release: () => void }>()
  /**
   * Holds on every room at once: offline, or a provider signed out. Each reason holds one provider's chats, or every chat
   * when it names none, with the same rules as a pause, while it stands (KERNEL-406). `gates` are what a held provider's
   * tool calls wait on.
   */
  private holds = new Map<string, Provider | undefined>()
  private gates = new Map<Provider, { open: Promise<void>; release: () => void }>()
  /** Chats whose first prompt waits for the workspace's setup script to pass, or for the PRs it waits for to merge (KERNEL-259). */
  private waiting = new Set<string>()
  /** Chats a usage limit or a quit stopped mid-turn. They carry on by themselves once nothing holds them (`carryOn`). */
  private cutOff = new Map<string, CutOffReason>()
  /** Chats `carryOn` restarted after a usage limit and that haven't finished a turn since, so a lifted limit doesn't restart them all at once (KERNEL-220). */
  private resuming = new Set<string>()
  /** Chats with a running turn, saved under `working` at every turn start and end, so a crash leaves the right list (KERNEL-215). */
  private working = new Set<string>()
  /** Kernel is quitting: the journal is frozen and nothing new goes out (`shutdown`). */
  private closing = false
  /** Kernel's launch checks are running (`holdCarryOn`). Chats in `cutOff` wait for them. Nothing else does. */
  private launching = false
  /** Claude Code processes Kernel started that haven't exited, by pid, with what each was started as. Saved under `claudePids`. */
  private pids = new Map<number, Spawned>()
  /** Chats whose session died mid-turn. `post` leaves them alone until the user sends or restarts (KERNEL-124). */
  private crashed = new Set<string>()
  /** Chats Kernel gave a fresh session because the old one was gone, until a turn there ends well (KERNEL-286). */
  private renewed = new Set<string>()
  /** Claude Code's own slash commands. They come with the CLI, so one read lasts the whole run. */
  private builtins?: Promise<BuiltinCommand[]>
  constructor(private d: SessionDeps) {}

  /**
   * What Kernel saved before it last quit: the usage windows, the chats a limit stopped, and the queues of chats held for
   * setup (KERNEL-128). A rejection without a reset time is dropped, since nothing could tell when it ends, so it no longer
   * holds anything. A held queue comes back only while its workspace's setup still has to pass, or while a ready workspace's
   * brief waits for a PR to merge (KERNEL-259). One still in setup is left to Kernel's `recoverSetups`, which holds it once.
   * Before KERNEL-215 `cutOff` was a list of chats a limit stopped, which still loads.
   *
   * Then what Sessions saved itself (KERNEL-215): every other chat's queue, and the chats whose turn was running when
   * Kernel quit or closed unexpectedly (`clean` says which). Each of those that is still open gets its stuck tool rows
   * closed and a note, and carries on by itself through `carryOn`, after what was queued. Everything goes through the same
   * gate as a limit: a pause, an offline or signed-out hold, a limit and the agent limit all make it wait.
   */
  restore(limits: RateLimit[], cutOff: string[] | Record<string, CutOffReason>, held: Record<string, QueuedMessage[]> = {}, o: { clean?: boolean } = {}) {
    for (const l of limits) this.limits.set(limitKey(l), l.status === 'rejected' && !l.resetsAt ? { ...l, status: 'allowed' } : l)
    const saved: [string, CutOffReason][] = Array.isArray(cutOff) ? cutOff.map((id) => [id, 'limit']) : Object.entries(cutOff ?? {})
    for (const [id, reason] of saved) if (reason === 'limit' || reason === 'quit') this.cutOff.set(id, reason)
    // Chats whose setup failed before Kernel quit still hold their brief, and what was sent after it, for Run again.
    for (const [id, queue] of Object.entries(held)) {
      const chat = this.d.store.chat(id)
      const ws = chat && this.d.store.workspace(chat.workspaceId)
      const waiting = heldForMerge(ws)
      if ((ws?.status !== 'failed' && !waiting) || !Array.isArray(queue)) continue
      this.waiting.add(id)
      this.setQueue(id, queue)
    }
    // Entries left out above, as an archived workspace's, drop out of what Kernel saves.
    this.saveHeld()
    for (const [id, queue] of Object.entries(this.d.store.meta<Record<string, QueuedMessage[]>>(QUEUES) ?? {})) {
      if (this.waiting.has(id) || !this.open(id) || !Array.isArray(queue) || !queue.length) continue
      this.queues.set(id, queue)
      this.pushQueue(id)
    }
    for (const id of this.d.store.meta<string[]>(WORKING) ?? []) this.relaunched(id, o.clean === true)
    this.saveWorking()
    this.saveQueues()
    this.d.onCutOff?.(Object.fromEntries(this.cutOff))
    // Queues that waited for a slot or a hold go out now if nothing holds them any more, and the cut-off chats carry on.
    for (const id of [...this.queues.keys()]) if (!this.cutOff.has(id)) this.drain(id)
    this.pushLimits()
  }

  /** The chat is open and its workspace isn't archived. */
  private open(chatId: string): boolean {
    const chat = this.d.store.chat(chatId)
    const ws = chat && this.d.store.workspace(chat.workspaceId)
    return !!chat && !chat.closed && !!ws && ws.status !== 'archived'
  }

  /**
   * A chat whose turn was running when Kernel quit or closed: its tool rows still marked running fail, a note says what
   * happened, and it waits in `cutOff` to carry on. A queue it had keeps its order, and the nudge follows it.
   */
  private relaunched(chatId: string, clean: boolean) {
    if (this.waiting.has(chatId) || !this.open(chatId)) return
    const chat = this.mustChat(chatId)
    const ws = this.mustWorkspace(chat.workspaceId)
    for (const it of this.d.store.items(chatId)) {
      if (it.kind === 'tool' && it.status === 'running') this.item(chat, { ...it, status: 'failed', output: TOOL_STOPPED })
    }
    this.item(chat, { kind: 'note', id: randomUUID(), ts: Date.now(), text: clean ? QUIT_NOTE : CRASH_NOTE })
    const queue = this.queued(chatId)
    if (queue.length && !queue.some((q) => q.from === 'kernel' && isNudge(q.parts))) {
      this.queues.set(chatId, [...queue, { id: randomUUID(), chatId, parts: [{ type: 'text', text: RELAUNCH_NUDGE }], ts: Date.now(), from: 'kernel' }])
      this.pushQueue(chatId)
    }
    this.cutOff.set(chatId, 'quit')
    // A teammate that carries on rides along in the Lead's next update instead of waking it (KERNEL-215).
    this.d.onExit?.(ws, chat, clean ? QUIT_REASON : CRASH_REASON, true, true)
  }

  /**
   * Hold every room, the way a pause holds one: agents finish their step and wait, sends queue. With `provider`, only that
   * provider's chats wait, as when it is signed out (KERNEL-406).
   */
  holdAll(reason: string, o: { provider?: Provider } = {}) {
    if (this.holds.has(reason)) return
    this.holds.set(reason, o.provider)
    for (const p of PROVIDER_IDS) {
      if (this.gates.has(p) || !this.holding(p)) continue
      let release!: () => void
      const open = new Promise<void>((resolve) => { release = resolve })
      this.gates.set(p, { open, release })
    }
    this.pushReasons()
  }

  /** Drop one reason for the hold. A provider nothing holds any more goes on, and what queued for it meanwhile is sent. */
  releaseAll(reason: string) {
    if (!this.holds.delete(reason)) return
    const freed = PROVIDER_IDS.filter((p) => this.gates.has(p) && !this.holding(p))
    if (!freed.length) return
    for (const p of freed) { this.gates.get(p)!.release(); this.gates.delete(p) }
    // A cut-off chat's queue goes through `carryOn`, which restarts those a limit stopped two at a time.
    for (const chatId of [...this.queues.keys()]) {
      const chat = this.d.store.chat(chatId)
      if (chat && freed.includes(chatProvider(chat)) && !this.live.get(chatId)?.running && !this.cutOff.has(chatId)) this.drain(chatId)
    }
    this.carryOn()
    this.pushReasons()
  }

  /** The reasons holding `provider`'s chats, or every reason when it names none. */
  heldFor(provider?: Provider): string[] { return [...this.holds].filter(([, p]) => !provider || !p || p === provider).map(([r]) => r) }

  /** Something holds this provider's chats: offline, or the provider signed out. */
  private holding(provider: Provider): boolean { return [...this.holds.values()].some((p) => !p || p === provider) }

  /**
   * The provider's account changed (KERNEL-406). A process runs on the account it started with, so an idle one ends now and
   * a busy one when its turn ends. The next message resumes the conversation on the account that is active then.
   */
  restartProvider(provider: Provider) {
    for (const [id, live] of [...this.live]) {
      const chat = this.d.store.chat(id)
      if (!chat || chatProvider(chat) !== provider) continue
      if (live.running || live.tasks.size) this.stale.add(id)
      else this.end(id, live)
    }
  }

  /**
   * Kernel checks the network and the sign-in at launch before agents carry on (KERNEL-215). Until `releaseCarryOn`, chats
   * a quit or a limit cut off wait, queue included. Ordinary sends and every other queue go out as usual.
   */
  holdCarryOn() { this.launching = true }

  /** The launch checks are done. What waited carries on, unless a hold they found (offline, signed out) still stands. */
  releaseCarryOn() {
    if (!this.launching) return
    this.launching = false
    this.drainWaiting()
  }

  /**
   * Put a message in the chat's queue without sending it, until `release`. Used for the first prompt while setup fails. With no
   * message the chat only waits, as a forked workspace's does through its setup (KERNEL-346).
   */
  hold(chatId: string, parts?: ChatPart[], o: Sender = {}) {
    this.waiting.add(chatId)
    this.setQueue(chatId, parts ? [...this.queued(chatId), { id: randomUUID(), chatId, parts, ts: Date.now(), ...sender(o) }] : this.queued(chatId))
  }

  /** The chat is held for its workspace's setup or a merge (`hold`), whatever its queue holds. */
  isHeld(chatId: string): boolean { return this.waiting.has(chatId) }

  release(chatId: string) {
    this.waiting.delete(chatId)
    this.saveHeld()
    this.saveQueues()
    if (!this.live.get(chatId)?.running) this.drain(chatId)
    this.pushReasons()
  }

  /** Hands Kernel what every chat held for setup is holding, to save. */
  private saveHeld() {
    if (!this.d.onHeld) return
    const held: Record<string, QueuedMessage[]> = {}
    for (const id of this.waiting) held[id] = this.queued(id)
    this.d.onHeld(held)
  }

  /**
   * Mark a usage window as reset (its resetsAt passed) and tell the renderer. A window that was only close to its limit resets
   * too, so what it held goes out (KERNEL-220). One already at 0 changes nothing. `key` is its `limitKey`: a Claude window's type.
   */
  resetLimit(key: string) {
    const l = this.limits.get(key)
    if (!l || (l.status === 'allowed' && !l.utilization)) return
    this.limits.set(key, { ...l, status: 'allowed', utilization: 0 })
    this.pushLimits()
  }

  /**
   * /compact in the chat: the agent summarises the conversation and frees context. On Claude it queues behind a running
   * turn. Codex compacts its thread through its own call (KERNEL-406).
   */
  async compact(chatId: string): Promise<{ queued: boolean; why?: QueueReason }> {
    const chat = this.mustChat(chatId)
    if (chatProvider(chat) !== 'codex') return this.send(chatId, [{ type: 'text', text: '/compact' }])
    const live = this.live.get(chatId) ?? this.start(chat, this.mustWorkspace(chat.workspaceId))
    await (live.runner as CodexRunner).compact()
    return { queued: false }
  }

  isPaused(roomId: string) { return this.paused.has(roomId) }

  /**
   * Freeze a room after its agents' current steps. Nothing is interrupted: a running turn carries on until its next tool call,
   * where it waits. New sends are held in each chat's queue and go out, in order, on resume.
   */
  pause(roomId: string) {
    if (this.paused.has(roomId)) return
    let release!: () => void
    const open = new Promise<void>((resolve) => { release = resolve })
    this.paused.set(roomId, { open, release })
    this.pushReasons()
  }

  /** Let the room's agents go on and send what was held while it was paused. */
  resume(roomId: string) {
    const gate = this.paused.get(roomId)
    if (!gate) return
    this.paused.delete(roomId)
    gate.release()
    for (const ws of this.d.store.workspaces(roomId)) for (const c of this.d.store.chats(ws.id)) if (!this.live.get(c.id)?.running && !this.cutOff.has(c.id)) this.drain(c.id)
    this.carryOn()
    this.pushReasons()
  }

  private pausedChat(chat: Chat) {
    if (this.holding(chatProvider(chat)) || this.waiting.has(chat.id)) return true
    const ws = this.d.store.workspace(chat.workspaceId)
    return !!ws && this.paused.has(ws.roomId)
  }

  /** Session ids started by Kernel. The hook server ignores these because in-process hooks already report them. */
  isManaged(sessionId: string) { return this.managedIds.has(sessionId) }
  isRunning(chatId: string) { return this.live.get(chatId)?.running ?? false }

  /** The chat's process still runs background tasks it started: shells, subagents or monitors. */
  hasTasks(chatId: string) { return (this.live.get(chatId)?.tasks.size ?? 0) > 0 }
  /** The chats with a turn running, for a window that loads while they work (KERNEL-340). */
  runningIds(): string[] { return [...this.live].filter(([, l]) => l.running).map(([id]) => id) }
  /** The chats whose session is retrying an overloaded API, with the countdown their banner shows (KERNEL-340). */
  retries(): Record<string, Retry> { return Object.fromEntries([...this.live].flatMap(([id, l]) => (l.retry ? [[id, l.retry]] : []))) }
  /** apiKeySource from the chat's init message. 'none' means the Claude plan pays. */
  billingOf(chatId: string) { return this.billing.get(chatId) }

  /**
   * 5-hour and weekly windows, fetched only when asked. A live session of each provider answers its usage call. Without a
   * live Claude one, `probeIn` starts a short session there to ask; otherwise, or when the call fails, the last
   * rate_limit_event numbers stand. A Claude account Kernel added runs on a `setup-token` token, which the usage call
   * answers nothing for, so it is never asked: its numbers come from its turns' rate_limit_event (KERNEL-406).
   */
  async usage(o: { probeIn?: string } = {}): Promise<RateLimit[]> {
    const open = [...this.live.values()].filter((l) => !l.runner.closed)
    const other = open.find((l) => !(l.runner instanceof ClaudeRunner))
    if (other) await other.runner.usage()
    if (this.d.accountFor?.('claude') === undefined) {
      const claude = open.find((l) => l.runner instanceof ClaudeRunner && !l.account)
      if (claude) await claude.runner.usage()
      else if (o.probeIn) await probeClaudeUsage(o.probeIn, (p) => this.mergeLimits(p))
    }
    return [...this.limits.values()]
  }

  /**
   * Claude Code's own slash commands, for the composer's / menu. A live session answers; without one, Claude Code starts with
   * no prompt, no settings and no transcript, lists them and stops, which sends no message. A failed read is tried again next time.
   */
  commands(cwd: string): Promise<BuiltinCommand[]> {
    this.builtins ??= this.readCommands(cwd).catch((err) => { this.builtins = undefined; throw err })
    return this.builtins
  }

  private async readCommands(cwd: string): Promise<BuiltinCommand[]> {
    const live = [...this.live.values()].find((l) => !l.runner.closed && l.runner instanceof ClaudeRunner)
    if (live) return (live.runner as ClaudeRunner).commandList()
    return claudeCommands(cwd)
  }

  /**
   * Starts a turn, or holds the message when one is running. A held message shows in the composer
   * (edit or remove it until it goes) and is sent, in order, when the turn ends. `why` says what it waits for.
   * `from` marks a message the user didn't type, and it stays on the message while it waits (KERNEL-116).
   */
  async send(chatId: string, parts: ChatPart[], o: Sender = {}): Promise<{ queued: boolean; why?: QueueReason }> {
    const chat = this.mustChat(chatId)
    this.mustHaveFolder(chat)
    // The user is redirecting the Lead, even when the message waits in the queue, so no hand-off reminder follows.
    if (o.from !== 'kernel') this.handoffs.done(chatId)
    // Kernel is quitting, as when an interrupted Lead turn messages a teammate: the message is saved and goes at the next launch.
    if (this.closing) {
      this.setQueue(chatId, [...this.queued(chatId), { id: randomUUID(), chatId, parts, ts: Date.now(), ...sender(o) }])
      return { queued: true }
    }
    const why = this.waitsFor(chat.id)
    if (why) {
      this.setQueue(chatId, [...this.queued(chatId), { id: randomUUID(), chatId, parts, ts: Date.now(), ...sender(o) }])
      return { queued: true, why }
    }
    this.dispatch(chat, parts, o)
    return { queued: false }
  }

  /**
   * Several messages for a chat that has not had a turn, such as a brief and the Lead's notes sent while setup ran (KERNEL-393).
   * They join the queue in order and go out together as its first turn when nothing blocks the chat, otherwise they wait like
   * `send`'s message does, and `why` says what for.
   */
  async sendAll(chatId: string, messages: (Sender & { parts: ChatPart[] })[]): Promise<{ queued: boolean; why?: QueueReason }> {
    this.mustHaveFolder(this.mustChat(chatId))
    // One message with nothing ahead of it is an ordinary send.
    if (messages.length === 1 && !this.queued(chatId).length) return this.send(chatId, messages[0].parts, sender(messages[0]))
    if (messages.some((m) => m.from !== 'kernel')) this.handoffs.done(chatId)
    this.setQueue(chatId, [...this.queued(chatId), ...messages.map((m) => ({ id: randomUUID(), chatId, parts: m.parts, ts: Date.now(), ...sender(m) }))])
    if (this.closing) return { queued: true }
    const why = this.waitsFor(chatId)
    if (why) return { queued: true, why }
    this.drain(chatId)
    return { queued: false }
  }

  /** A workspace whose folder was deleted outside Kernel has nowhere to run a turn, so nothing is sent or queued there (KERNEL-291). */
  private mustHaveFolder(chat: Chat) {
    const ws = this.d.store.workspace(chat.workspaceId)
    if (ws?.folderGone) throw new Error(`${ws.name}'s folder is gone, so nothing can run there. Archive it, then restore it from History to make the folder again.`)
  }

  /** The row that started the chat's running turn, or its last one. With a batched first turn it is the first message's, not the last row's. */
  turnRow(chatId: string): (ChatItem & { kind: 'user' }) | undefined { return this.live.get(chatId)?.sentItem }

  /** What a message sent now would wait for, or nothing when it can go at once. */
  waitsFor(chatId: string): QueueReason | undefined {
    const chat = this.d.store.chat(chatId)
    if (!chat) return undefined
    if (this.live.get(chat.id)?.running) return 'running'
    if (this.waiting.has(chat.id)) return heldForMerge(this.d.store.workspace(chat.workspaceId)) ? 'merge' : 'setup'
    if (this.holding(chatProvider(chat))) return 'offline'
    if (this.pausedChat(chat)) return 'paused'
    if (this.nearLimitHolds(chat.id)) return 'limit'
    if (this.atCapacity(chat.id)) return 'capacity'
    return undefined
  }

  /**
   * Kernel's own message into an idle chat, such as the Lead's teammate updates (KERNEL-72). It starts a turn like a user
   * message, but it isn't the user redirecting, so a pending hand-off reminder stays. It sends nothing and returns false
   * when the chat is running, has messages queued, is paused, is held near a usage limit or is over the agent limit; the caller
   * keeps it for later.
   */
  post(chatId: string, parts: ChatPart[], o: { update?: TeamUpdate } = {}): boolean {
    const chat = this.mustChat(chatId)
    // A chat that carries on after a quit waits for the launch checks too, or an update would take its turn without them.
    if (this.closing || this.waiting.has(chatId) || this.d.store.workspace(chat.workspaceId)?.folderGone || (this.launching && this.cutOff.has(chatId)) || this.live.get(chatId)?.running || this.queued(chatId).length || this.pausedChat(chat) || this.nearLimitHolds(chatId) || this.atCapacity(chatId) || this.crashed.has(chatId)) return false
    this.dispatch(chat, parts, { from: 'kernel', update: o.update })
    return true
  }

  /**
   * Who started this chat's running turn, or its last one once it is idle: Kernel, the Lead, or the user (undefined). A
   * limit or restart nudge's turn counts as the turn it carries on.
   */
  turnFrom(chatId: string): MessageFrom | undefined { return this.turns.get(chatId)?.from }

  /** This chat's running turn, or its last one once it is idle, was started by Kernel. */
  kernelTurn(chatId: string): boolean { return this.turnFrom(chatId) === 'kernel' }

  queued(chatId: string): QueuedMessage[] { return this.queues.get(chatId) ?? [] }

  /** What the chat's queue waits for, or nothing when it is empty or its next message is about to go (KERNEL-271). */
  queueReason(chatId: string): QueueReason | undefined { return this.queued(chatId).length ? this.waitsFor(chatId) : undefined }

  unqueue(chatId: string, id: string): QueuedMessage[] {
    return this.setQueue(chatId, this.queued(chatId).filter((q) => q.id !== id))
  }

  /**
   * Move a queued message to the front and stop the running turn, so it goes out as soon as that turn ends. An idle chat
   * held only by the agent limit, or by a usage window close to its limit, sends it at once. `pastPause` sends it from an idle
   * chat even though its room is paused, which Kernel asks for when a limit paused it.
   */
  async sendNow(chatId: string, id: string, o: { pastPause?: boolean } = {}): Promise<QueuedMessage[]> {
    const pick = this.queued(chatId).find((q) => q.id === id)
    if (!pick) return this.queued(chatId)
    const rest = this.queued(chatId).filter((q) => q.id !== id)
    this.setQueue(chatId, [pick, ...rest])
    const live = this.live.get(chatId)
    const why = this.waitsFor(chatId)
    if (this.closing) return this.queued(chatId)
    if (live?.running) { live.sendNext = true; await this.interrupt(chatId, true) }
    // Pressing Send now is the user choosing to go over the agent limit (KERNEL-271), or past the near-limit hold (KERNEL-220).
    else if (why === 'capacity' || why === 'limit' || (why === 'paused' && o.pastPause)) { this.setQueue(chatId, rest); this.dispatch(this.mustChat(chatId), pick.parts, pick) }
    else this.drain(chatId)
    return this.queued(chatId)
  }

  /**
   * Send the same message again: `itemId` itself when it is a user message, else the user message before it (a reply or a
   * turn's result). It keeps its sender, so a Kernel update sent again is still Kernel's and leaves a pending hand-off
   * reminder alone. Returns the copy when it waits in the queue, so Retry now can send it first.
   */
  async retry(chatId: string, itemId: string): Promise<QueuedMessage | undefined> {
    const items = this.d.store.items(chatId)
    const at = items.findIndex((i) => i.id === itemId)
    if (at < 0) throw new Error('That message is no longer in this chat.')
    const user = items.slice(0, at + 1).reverse().find((i) => i.kind === 'user')
    if (!user || user.kind !== 'user') throw new Error('There is no message to send again.')
    // An update from before KERNEL-116 carries no marker, only its header.
    const from = user.from ?? (isKernelUpdate(user) ? 'kernel' : undefined)
    const { queued } = await this.send(chatId, user.parts, { from, update: user.update })
    return queued ? this.queued(chatId).at(-1) : undefined
  }

  /**
   * Starts a turn with `parts`. `more` are the messages that waited for the same first turn (`drain`): each keeps its own row
   * and sender, right after the first, and Claude Code reads them all as one message, in order. The turn's row and sender
   * stay the first message's.
   */
  private dispatch(chat: Chat, parts: ChatPart[], o: Sender = {}, more: QueuedMessage[] = []) {
    const ws = this.mustWorkspace(chat.workspaceId)
    // A held message going out counts as the user taking over too. Kernel's own updates don't.
    if ([o, ...more].some((m) => m.from !== 'kernel')) { this.handoffs.done(chat.id); this.crashed.delete(chat.id) }
    // A nudge picks up a turn a limit or a crash cut short, so the turn is still the one whoever started it started.
    // Read before the nudge is saved, which would be the last message.
    const by = o.from === 'kernel' && isNudge(parts) ? this.startedBy(chat.id) : o.from
    const carrying = this.cutOff.get(chat.id) === 'quit'
    // Whatever goes out next picks the chat up again, so it no longer waits for the limit.
    this.setCutOff(chat.id, false)
    const row: ChatItem & { kind: 'user' } = { kind: 'user', id: randomUUID(), ts: Date.now(), parts, ...sender(o) }
    this.item(chat, row)
    for (const m of more) this.item(chat, { kind: 'user', id: randomUUID(), ts: Date.now(), parts: m.parts, ...sender(m) })
    const live = this.live.get(chat.id) ?? this.start(chat, ws)
    live.sentItem = row
    live.carrying = carrying
    live.failed = undefined
    const turns = this.turnsOf(chat.id)
    turns.from = by
    // A new message takes the agent past whatever a hook refused.
    turns.blocked = undefined
    live.sent = [...parts, ...more.flatMap((m) => m.parts)]
    live.runner.push(live.sent)
    this.setRunning(chat, ws, live, true)
  }

  private turnsOf(chatId: string): Turns {
    let turns = this.turns.get(chatId)
    if (!turns) this.turns.set(chatId, (turns = {}))
    return turns
  }

  /** Who sent the chat's last message that wasn't one of Kernel's nudges: the turn a nudge picks up. */
  private startedBy(chatId: string): MessageFrom | undefined {
    const items = this.d.store.items(chatId)
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'user' && !(it.from === 'kernel' && isNudge(it.parts))) return it.from
    }
    return undefined
  }

  /**
   * Send the oldest held message. The next one goes when this turn ends. A chat with no user message yet sends everything that
   * waited for its first turn together (`firstTurn`), so a note queued behind a brief that waited hours reaches the agent
   * before it starts. Read from the chat's rows, not a flag, so it holds after a restart and while the batch waits for a slot.
   */
  private drain(chatId: string) {
    const queue = this.queued(chatId)
    const [next] = queue
    const chat = this.d.store.chat(chatId)
    if (this.closing || (this.launching && this.cutOff.has(chatId)) || !next || !chat || this.pausedChat(chat) || this.nearLimitHolds(chatId) || this.atCapacity(chatId)) return
    const batch = queue.length > 1 && !this.d.store.items(chatId).some((i) => i.kind === 'user') ? firstTurn(queue) : [next]
    this.setQueue(chatId, queue.slice(batch.length))
    this.dispatch(chat, next.parts, next, batch.slice(1))
  }

  /**
   * Settings changed. The lists and the timeout are read per tool call; the mode is moved on live sessions now, and a higher
   * limit starts waiting work. The usage switches count too, so the limits go out again for Kernel to act on them (KERNEL-220).
   */
  applySettings(before?: AppSettings) {
    if (!before || before.permissions.mode !== this.d.settings().permissions.mode) {
      for (const [id, l] of this.live) {
        if (this.d.store.chat(id)?.plan) continue
        // Plan mode off puts the session on the mode Settings, Permissions now has.
        void l.runner.setPlan(false)
      }
    }
    this.pushLimits()
  }

  /**
   * Settings > Models: agents working at once, 0 for no limit. Read on every call, so a change applies to the next send. The Lead's chats
   * neither wait for a slot nor take one, so the Lead can plan in several chats while its teammates use the slots (D-094).
   */
  private atCapacity(chatId: string): boolean {
    const max = this.d.settings().models?.agentLimit
    if (!max || max < 1 || this.isLeadChat(chatId)) return false
    let running = 0
    for (const [id, l] of this.live) if (l.running && id !== chatId && !this.isLeadChat(id)) running++
    return running >= max
  }

  private isLeadChat(chatId: string): boolean {
    const chat = this.d.store.chat(chatId)
    const ws = chat && this.d.store.workspace(chat.workspaceId)
    return !!ws && !!this.d.agentFor(ws)?.lead
  }

  /**
   * Settings, Account: with "Pause new work when close to the limit" on, a teammate's chat starts no new turn while the 5-hour
   * window is at 90% or the weekly one at 95% (`nearLimit`). Turns that are running finish. The Lead's chats are never held,
   * so Rowan can still answer the user (D-094). What waits goes out when usage drops or the window resets (KERNEL-220).
   */
  private nearLimitHolds(chatId: string): boolean {
    if (!this.d.settings().usage?.pauseNearLimit || this.isLeadChat(chatId)) return false
    const chat = this.d.store.chat(chatId)
    return !!chat && !!nearLimit(this.limitsFor(chat))
  }

  /** A slot opened (a turn ended or the limit went up): start held messages of idle chats, oldest queue first, while there is room. */
  drainWaiting() {
    for (const id of [...this.queues.keys()]) if (!this.live.get(id)?.running && !this.cutOff.has(id)) this.drain(id)
    this.carryOn()
    // A lower limit in Settings, Models holds queues that waited for nothing a moment ago.
    this.pushReasons()
  }

  /**
   * Chats a usage limit or a quit stopped go on once nothing holds them: no limit on the account or on their model, no
   * pause, no offline or signed-out hold, and a free slot. What the user queued goes first; otherwise Kernel tells the
   * agent to pick up where it left off. After a quit, `restore` already put that nudge at the end of a queue.
   */
  private carryOn() {
    if (this.closing || this.launching) return
    // A chat that stopped running has finished the turn it was restarted for, so the next one may go.
    for (const id of this.resuming) if (!this.live.get(id)?.running) this.resuming.delete(id)
    for (const [id, reason] of [...this.cutOff]) {
      const chat = this.d.store.chat(id)
      if (!chat || !this.open(id)) { this.setCutOff(id, false); continue }
      if (this.live.get(id)?.running || this.pausedChat(chat) || this.atCapacity(id) || this.limitHolds(chat) || this.nearLimitHolds(id)) continue
      // A lifted limit restarts the chats it cut off two at a time. The next starts when one ends its turn, where `drainWaiting` comes back here (KERNEL-220).
      if (reason === 'limit') {
        if (this.resuming.size >= RESUME_AT_ONCE) continue
        this.resuming.add(id)
      }
      if (this.queued(id).length) this.drain(id)
      else this.dispatch(chat, [{ type: 'text', text: reason === 'quit' ? RELAUNCH_NUDGE : LIMIT_LIFTED }], { from: 'kernel' })
    }
  }

  /**
   * A known usage limit stops this chat: one on the whole account, or on the chat's model. Only the windows of its provider,
   * on the account that provider runs on now, count (KERNEL-406).
   */
  private limitHolds(chat: Chat) {
    const limits = this.limitsFor(chat)
    return !!blockingLimit(limits) || (limitedModels(limits) as string[]).includes(chat.model)
  }

  /** The usage windows that count for a chat: its own provider's, on the account in use (KERNEL-406). */
  private limitsFor(chat: Chat) {
    const provider = chatProvider(chat)
    const account = this.d.accountFor?.(provider)
    return [...this.limits.values()].filter((l) => limitProvider(l) === provider && l.accountId === account)
  }

  /** A usage limit or a quit stopped this chat mid-turn and it waits to carry on. */
  private isCutOff(chatId: string) { return this.cutOff.has(chatId) }

  private setCutOff(chatId: string, reason: CutOffReason | false) {
    if ((this.cutOff.get(chatId) ?? false) === reason) return
    if (reason) this.cutOff.set(chatId, reason)
    else this.cutOff.delete(chatId)
    this.d.onCutOff?.(Object.fromEntries(this.cutOff))
  }

  private setQueue(chatId: string, queue: QueuedMessage[]): QueuedMessage[] {
    if (queue.length) this.queues.set(chatId, queue)
    else this.queues.delete(chatId)
    // An idle chat's clock counts from its last change, so a message that waited and was removed buys it the full time.
    if (this.idle.has(chatId)) this.startIdle(chatId)
    this.pushQueue(chatId)
    // A held brief edited or removed in the composer is saved too, and so is every other queue, for a quit (KERNEL-215).
    if (this.waiting.has(chatId)) this.saveHeld()
    else this.saveQueues()
    return queue
  }

  /** Saves the queues of chats not held for setup (those go under `held`), so they survive a quit or a crash. */
  private saveQueues() {
    const queues: Record<string, QueuedMessage[]> = {}
    for (const [id, queue] of this.queues) if (!this.waiting.has(id)) queues[id] = queue
    this.d.store.saveMeta(QUEUES, queues)
  }

  private saveWorking() { this.d.store.saveMeta(WORKING, [...this.working]) }

  /**
   * Tell the renderer the chat's queue and what it waits for, once the current step is done. A held message going out
   * changes both the queue and the reason, and the renderer gets one event with where they ended up (KERNEL-271).
   */
  private pushQueue(chatId: string) {
    if (!this.unsent.size) queueMicrotask(() => this.flushQueues())
    this.unsent.add(chatId)
  }

  private flushQueues() {
    const ids = [...this.unsent]
    this.unsent.clear()
    for (const chatId of ids) {
      const queue = this.queued(chatId)
      const why = this.queueReason(chatId)
      if (queue.length) this.reasons.set(chatId, why)
      else this.reasons.delete(chatId)
      bus.push({ type: 'chat.queue', chatId, queue, ...(why ? { why } : {}) })
    }
  }

  /**
   * A turn started or ended, or a hold began or lifted: held queues whose reason changed tell the renderer. Kernel calls it
   * when a workspace changes too, since a held brief waits for setup or for a merge by its workspace's state (KERNEL-361).
   */
  pushReasons() {
    for (const chatId of this.queues.keys()) if (this.reasons.get(chatId) !== this.waitsFor(chatId)) this.pushQueue(chatId)
  }

  /** The turn's own result message ends it. Queued follow-ups still run afterwards, as in Claude Code. */
  async interrupt(chatId: string, sendNext = false) {
    const live = this.live.get(chatId)
    if (!live?.running) return
    // Stop is the user taking over. Send now isn't on its own: the message it sends first decides, so a Kernel update
    // sent again with Retry now leaves a pending hand-off reminder alone (KERNEL-116).
    if (!sendNext) this.handoffs.done(chatId)
    // A Stop while Send now is already interrupting wins: the queue is dropped.
    if (live.interrupted) { if (!sendNext) live.sendNext = false; return }
    live.interrupted = true
    await live.runner.interrupt()
    this.item(this.mustChat(chatId), { kind: 'interrupted', id: randomUUID(), ts: Date.now() })
  }

  async configure(chatId: string, patch: Partial<Pick<Chat, 'model' | 'effort' | 'plan'>>): Promise<Chat> {
    const chat = { ...this.mustChat(chatId), ...patch }
    this.d.store.saveChat(chat)
    // The composer follows changes Kernel makes too, like leaving plan mode when a plan is approved.
    bus.push({ type: 'chat', chat })
    const live = this.live.get(chatId)
    if (live) {
      if (patch.model) await live.runner.setModel(patch.model)
      // After the model, so a model switch keeps the effort picked with it (D-093).
      if (patch.effort) await live.runner.setEffort(patch.effort)
      if (patch.plan !== undefined) await live.runner.setPlan(patch.plan)
    }
    // "Switch to" on a model's limit: the new model picks up where the limit stopped the chat.
    if (patch.model) this.carryOn()
    return chat
  }

  /**
   * The user approved this chat's plan, from ExitPlanMode or the Lead's request_plan_approval. The chat leaves plan mode, so a
   * restart does not put it back (D-074), and a Lead chat owes the hand-off (KERNEL-67).
   */
  async planApproved(chatId: string) {
    await this.configure(chatId, { plan: false }).catch(() => undefined)
    if (this.isLeadChat(chatId)) this.handoffs.approved(chatId)
  }

  stop(chatId: string) {
    const live = this.live.get(chatId)
    // A chat stopped while idle has no process but is stopped all the same.
    if (!live && !this.turns.has(chatId)) return
    // Stopped by Kernel or the user: a hook's refusal no longer holds anyone up. A running turn's end says so on its own;
    // an idle chat that gave up blocked has no turn left to end, so the floor hears it here (Archive, Close chat).
    const shown = this.turns.get(chatId)?.blocked && !live?.running
    this.turns.delete(chatId)
    if (live) this.end(chatId, live)
    if (this.queued(chatId).length) this.setQueue(chatId, [])
    const ws = shown ? this.d.store.workspace(this.mustChat(chatId).workspaceId) : undefined
    if (ws) this.setStatus(ws, this.d.agentFor(ws), 'idle')
  }

  /** Close the process's input and abort it. `consume` sees the abort and reports nothing: no offline, no crash. */
  private end(chatId: string, live: Live) {
    this.stopIdle(chatId)
    this.stale.delete(chatId)
    live.runner.close()
    this.live.delete(chatId)
  }

  /**
   * Start the chat's idle clock over, between turns. When it runs out, the process stops unless something still needs it,
   * and the next message resumes the conversation from `chat.sessionId` (KERNEL-183). It changes no status and keeps
   * `turns`, so the chat looks and answers the same as before.
   */
  private startIdle(chatId: string) {
    this.stopIdle(chatId)
    const live = this.live.get(chatId)
    if (!live || live.running) return
    if (this.stale.has(chatId) && !live.tasks.size) { this.stale.delete(chatId); this.end(chatId, live); return }
    const clock = setTimeout(() => {
      this.idle.delete(chatId)
      if (this.live.get(chatId) !== live || live.running) return
      // Held for now: look again after another stretch, so a pause or a background task that ends starts no new wait.
      if (this.keepsProcess(chatId, live)) this.startIdle(chatId)
      else this.end(chatId, live)
    }, IDLE_STOP_MS)
    // An idle clock never keeps Kernel running.
    clock.unref?.()
    this.idle.set(chatId, clock)
  }

  private stopIdle(chatId: string) {
    clearTimeout(this.idle.get(chatId))
    this.idle.delete(chatId)
  }

  /**
   * Something still needs the idle chat's process: messages waiting to go, a brief held for setup, a paused room or a
   * hold on every room, a usage limit it waits out, or a background task it runs.
   */
  private keepsProcess(chatId: string, live: Live): boolean {
    const chat = this.d.store.chat(chatId)
    return !!chat && (this.queued(chatId).length > 0 || this.pausedChat(chat) || this.isCutOff(chatId) || live.tasks.size > 0)
  }

  /** Start a new session for a chat whose session ended, resuming its conversation with a nudge to carry on. */
  async restart(chatId: string): Promise<void> {
    this.mustChat(chatId)
    this.crashed.delete(chatId)
    // Messages held while the session was down or the room was paused still go out, first, and the nudge follows them.
    const held = this.queued(chatId)
    this.stop(chatId)
    if (!held.length) { await this.send(chatId, [{ type: 'text', text: RESTART_NUDGE }], { from: 'kernel' }); return }
    this.setQueue(chatId, [...held, { id: randomUUID(), chatId, parts: [{ type: 'text', text: RESTART_NUDGE }], ts: Date.now(), from: 'kernel' }])
    this.drain(chatId)
  }

  stopWorkspace(workspaceId: string) { for (const c of this.d.store.chats(workspaceId)) this.stop(c.id) }

  /**
   * The agent behind these workspaces changed: its file, its tools, or who leads (KERNEL-397). A process only reads its
   * agent when it starts, so an idle one ends now and a busy one when its turn and background tasks end. The next message
   * resumes the conversation with the agent as it is now, and nothing waiting in the queue is lost.
   */
  restartIdle(workspaceIds: string[]) {
    for (const id of workspaceIds) {
      for (const c of this.d.store.chats(id)) {
        const live = this.live.get(c.id)
        if (!live) continue
        if (live.running || live.tasks.size) this.stale.add(c.id)
        else this.end(c.id, live)
      }
    }
  }

  /** The workspace is archived. Chats held for its setup let go of what they held, so a restore doesn't find them still waiting. */
  dropHeld(workspaceId: string) {
    for (const c of this.d.store.chats(workspaceId)) if (this.waiting.delete(c.id)) { this.setQueue(c.id, []); this.saveHeld() }
  }
  stopAll() { for (const id of [...this.live.keys()]) this.stop(id) }

  /**
   * Kernel is quitting (KERNEL-215). The journal of working chats freezes, so turns that end now stay in it and carry on
   * at the next launch. Every running turn is interrupted at once and gets `budgetMs` to end; then every process is
   * ended, the ones still working too. Queues are kept and saved, and nothing new goes out. Close chat and archive use
   * `stop`, which drops the queue as before.
   */
  async shutdown(budgetMs = QUIT_BUDGET_MS) {
    this.closing = true
    const running = [...this.live.entries()].filter(([, l]) => l.running)
    // A Stop pressed just before the quit stands: that turn ends as a Stop, drops its queue and doesn't carry on.
    const stopping = (live: Live) => live.interrupted && !live.sendNext
    for (const [id, live] of running) if (stopping(live)) this.working.delete(id)
    this.saveWorking()
    let timer: ReturnType<typeof setTimeout> | undefined
    const ended = Promise.all(running.map(([, live]) => new Promise<void>((resolve) => {
      live.whenIdle = resolve
      if (stopping(live)) return
      // Like Send now, the turn ends without dropping the queue, and no interrupted row: the note at launch says it.
      live.interrupted = true
      live.sendNext = true
      live.quit = true
      void live.runner.interrupt()
    })))
    await Promise.race([ended, new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs) })])
    clearTimeout(timer)
    for (const [id, live] of [...this.live]) {
      this.end(id, live)
      // A process left mid-step would carry on alone, so it ends now, and so do the shells its tools started.
      live.runner.kill()
    }
  }

  /**
   * Claude Code processes from the last run that are still alive (KERNEL-215). A force quit or a crash leaves them running
   * the step they were on, in the same worktree a resumed session is about to use. Each saved pid that is still alive and
   * still the same binary gets SIGTERM, then SIGKILL if it hasn't gone within `waitMs`. Returns the pids it ended.
   */
  async endLeftovers(waitMs = 2000): Promise<number[]> {
    const saved = this.d.store.meta<SavedPid[]>(PIDS) ?? []
    const left: SavedPid[] = []
    for (const p of Array.isArray(saved) ? saved : []) if (typeof p?.pid === 'number' && !this.pids.has(p.pid) && (await runs(p))) left.push(p)
    for (const p of left) signal(p.pid, 'SIGTERM')
    const until = Date.now() + waitMs
    let alive = left
    while (alive.length && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100))
      alive = (await Promise.all(alive.map(async (p) => ((await runs(p)) ? p : undefined)))).filter((p): p is SavedPid => !!p)
    }
    for (const p of alive) signal(p.pid, 'SIGKILL')
    // Only now, so a crash during the wait still finds them at the next launch.
    this.savePids()
    return left.map((p) => p.pid)
  }

  /** Kernel quit or closed while a turn ran, or a chat waits to carry on: what `restore` will start, so Kernel checks the account first. */
  wasWorking(): boolean { return (this.d.store.meta<string[]>(WORKING) ?? []).length > 0 }

  /**
   * Starts Claude Code the way the SDK's own spawn does, and records its pid until it exits, so a launch after a crash can
   * end it (`endLeftovers`). The SDK reads no stderr from a custom spawn, so Kernel keeps the end of it for the error note.
   * Each process leads its own process group. In Kernel's group, a Ctrl+C or a closed tab in the terminal that ran `pnpm dev`
   * reached every agent at once and ended its turn before the quit could save it to carry on (KERNEL-340).
   */
  private spawn(command: string, args: string[], o: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal }, proc: Proc): ChildProcess {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true })
    proc.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => { proc.stderr = (proc.stderr + d).slice(-STDERR_KEPT) })
    child.stderr?.on('error', () => undefined)
    const pid = child.pid
    if (pid) {
      this.pids.set(pid, { command, ...(args[0] ? { arg: args[0] } : {}) })
      this.savePids()
      child.once('exit', () => { if (this.pids.delete(pid)) this.savePids() })
    }
    return child
  }

  private savePids() {
    // Written from the exit of a process that outlives a stopped Kernel too, whose database is closed by then.
    try { this.d.store.saveMeta<SavedPid[]>(PIDS, [...this.pids].map(([pid, p]) => ({ pid, ...p }))) } catch { /* Kernel stopped */ }
  }

  private start(chat: Chat, ws: Workspace): Live {
    const agent = this.d.agentFor(ws)
    const root = this.d.store.room(ws.roomId)?.path
    const live = { running: false, interrupted: false, tasks: new Set<string>(), account: this.d.accountFor?.(chatProvider(chat)) } as Live
    const host = this.hostFor(chat.id, ws, agent, live)
    const env = this.d.envFor?.(ws) ?? buildEnv({ base: process.env, kernel: kernelVars(ws, this.d.store.room(ws.roomId)) })
    const prompt = agentPrompt(agent, ws, this.d.rulesFor?.(ws, agent))
    if (chatProvider(chat) === 'codex') {
      const c = this.d.codexFor?.(ws, agent, chat)
      // Kernel's rules name its tools as Claude sees them, so Codex reads them under its own names.
      live.runner = new CodexRunner(host, { bin: c?.bin ?? '', home: c?.home, env, prompt: forProvider([prompt, c?.instructions].filter(Boolean).join('\n\n'), 'codex'), tools: c?.tools ?? [], personality: c?.personality ?? 'pragmatic', disabled: this.d.disabledFor?.(ws)?.mcp, aliases: this.d.aliasesFor?.(ws) })
    } else {
      live.runner = new ClaudeRunner(host, { mcpServers: this.d.mcpFor(ws, agent, chat), disabled: this.d.disabledFor?.(ws), prompt, env: { ...env, ...this.d.claudeEnv?.() }, root, aliases: this.d.aliasesFor?.(ws) })
    }
    this.live.set(chat.id, live)
    live.runner.start()
    return live
  }

  /** What the chat's runner calls back into (KERNEL-406). Each method acts on this chat and this process. */
  private hostFor(chatId: string, ws: Workspace, agent: AgentDef | undefined, live: Live): RunnerHost {
    return {
      chatId, workspace: ws, agent,
      chat: () => this.mustChat(chatId),
      settings: () => this.d.settings(),
      roomAllow: () => this.d.roomAllow(ws.roomId),
      allowInRoom: (rule) => this.d.allowInRoom(ws.roomId, rule),
      held: () => this.paused.get(ws.roomId)?.open ?? this.gates.get(chatProvider(this.mustChat(chatId)))?.open,
      spawn: (command, args, o, proc) => this.spawn(command, args, o, proc),
      managed: (sessionId) => { this.managedIds.add(sessionId) },
      item: (item) => this.item(this.mustChat(chatId), item),
      sessionStarted: (sessionId, o = {}) => {
        let chat = this.mustChat(chatId)
        this.managedIds.add(sessionId)
        if (chat.sessionId !== sessionId) { chat = { ...chat, sessionId }; this.d.store.saveChat(chat) }
        const source = o.billedBy
        if (source !== undefined) {
          if (!this.billing.has(chatId) && source !== 'none') {
            this.item(chat, { kind: 'note', id: randomUUID(), ts: Date.now(), text: `This session is billed through ${source}, not your Claude plan.` })
            bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, sessionId, text: `is billed through ${source}, not the Claude plan` })
          }
          this.billing.set(chatId, source)
        }
        const servers = o.mcpServers
        const room = servers && (this.d.onMcp?.(ws, chatProvider(chat), servers) ?? [])
        if (servers && room && !this.mcpChecked.has(chatId)) {
          this.mcpChecked.add(chatId)
          // claude.ai's connectors can join after the first init, so the room's word on those counts too. The room's
          // switched-off servers never start, so the room's settings alone know them. Every other server is as this session has it.
          const late = room.filter((r) => r.source === 'claudeai' && !servers.some((s) => s.name === r.name))
          const off = (this.d.disabledFor?.(ws)?.mcp ?? []).map((name) => ({ name, enabled: false }))
          const text = missingServers(this.d.agentFor(ws)?.tools, [...late, ...servers, ...off], this.d.aliasesFor?.(ws)).map(mcpNote).join(' ')
          if (text) this.item(chat, { kind: 'note', id: randomUUID(), ts: Date.now(), text })
        }
        this.setRunning(chat, ws, live, true)
      },
      mcpStatus: (servers) => { this.d.onMcp?.(ws, chatProvider(this.mustChat(chatId)), servers) },
      blocked: (event, output) => this.blocked(ws, chatId, event, output),
      toolSucceeded: () => { if (this.turns.get(chatId)?.blocked === 'PreToolUse') this.unblock(this.mustChat(chatId), ws) },
      setTasks: (ids) => { live.tasks = new Set(ids) },
      retrying: (retry) => { live.retry = retry; bus.push({ type: 'retry', chatId, retry }) },
      clearRetry: () => this.clearRetry(chatId, live),
      reached: () => this.d.onReached?.(),
      replied: () => this.d.onReply?.(ws, this.mustChat(chatId)),
      failed: (failure, o = {}) => { live.failed = failure; if (o.notify) this.d.onFailure?.(failure, ws, chatProvider(this.mustChat(chatId))) },
      limited: (o = {}) => { if (o.always || live.running) live.limited = true },
      // A window is the provider's and the account's the process runs on. Claude's on the CLI login stay as they always were.
      mergeLimits: (patches) => this.mergeLimits(patches.map((p) => ({ ...p, ...(live.account ? { accountId: live.account } : {}) }))),
      reset: (trigger) => {
        this.d.store.clearItems(chatId)
        if (trigger === 'clear') live.cleared = true
        bus.push({ type: 'chat.cleared', chatId })
        this.d.onReset?.(ws, this.mustChat(chatId), trigger)
      },
      setContext: (context, usage) => this.setContext(chatId, context, usage),
      turnEnded: (t) => this.turnEnded(chatId, ws, live, t),
      sessionGone: () => this.renew(this.mustChat(chatId), ws, live),
      ended: (reason, o = {}) => this.ended(chatId, ws, live, reason, o.error === true),
      // A stopped process can still deliver lines it had already written. Once a newer session owns the chat, or Kernel is
      // quitting and ended this process, they are dropped (KERNEL-396).
      stale: () => this.replaced(chatId, live) || (this.closing && live.runner.closed),
      get quitting() { return live.quit === true },
      get interrupted() { return live.interrupted },
      ask: (a, o) => this.ask(chatId, ws, agent, a, o),
      requestPlan: (plan, o) => this.requestPlan(chatId, ws, agent, plan, o),
      handoffAfterPlan: () => (this.handoffs.due(chatId) ? forProvider(HANDOFF_NOW, chatProvider(this.mustChat(chatId))) : undefined),
      handoffAtStop: () => { const t = this.handoffs.reminder(chatId); if (t) bus.track({ name: 'handoff.reminder' }); return t && forProvider(t, chatProvider(this.mustChat(chatId))) },
      followUp: (text) => { void this.send(chatId, [{ type: 'text', text }], { from: 'kernel' }).catch(() => undefined) }
    }
  }

  /**
   * The chat's process ended. `ended` is null when Kernel stopped it, else why it went away. A process that failed leaves a
   * note. Kernel is quitting and ended this process: the stream ends on its own time, often after Kernel has closed the
   * store, and nothing of it changes what carries on, since `shutdown` already froze the journal and kept the queue (KERNEL-396).
   */
  private ended(chatId: string, ws: Workspace, live: Live, ended: string | null, error: boolean) {
    if (error && ended !== null) this.item(this.mustChat(chatId), { kind: 'note', id: randomUUID(), ts: Date.now(), text: `Session stopped: ${ended}` })
    if (this.closing && live.runner.closed) return
    const replaced = this.replaced(chatId, live)
    const midTurn = live.running
    if (this.live.get(chatId) === live) { this.live.delete(chatId); this.stopIdle(chatId) }
    const chat = this.d.store.chat(chatId)
    if (chat && !replaced) this.setRunning(chat, ws, live, false)
    if (chat && !replaced) this.drainWaiting()
    if (chat && !replaced && ended !== null) {
      // A message that waited for this chat may have started a new session just now. Then it is working again.
      const resumed = !!this.live.get(chatId)?.running
      // Kernel's own messages wait until the user acts on a session that died mid-turn, so they can't loop a broken one.
      if (midTurn && !resumed) this.crashed.add(chatId)
      if (!resumed) this.offline(ws, ended)
      this.d.onExit?.(ws, chat, ended, midTurn, resumed)
    }
  }

  /**
   * Claude Code no longer has the conversation this process resumed: it pruned the transcript, or the user deleted
   * ~/.claude/projects (KERNEL-286). The chat forgets the id, so no later send resumes it. The running turn moves to a fresh
   * session with the chat's model, effort and plan mode, which gets the same message; the queue follows when it ends, as
   * usual. One of Kernel's nudges becomes the fresh-session nudge, in the transcript too, since the agent has nothing to
   * pick up. The turn never ends in between, so the journal, `turns` and a carry-on after a quit stay as they were, and
   * nobody hears of the old process. Returns false, and the turn ends the usual way, while Kernel quits (the next launch
   * tries again), when the fresh session this chat already got never finished a turn, so a broken setup can't loop, and
   * after a Stop or a Send now: Stop drops the queue, and Send now's message starts the fresh session itself.
   */
  private renew(chat: Chat, ws: Workspace, live: Live): boolean {
    if (this.closing || !live.sent) return false
    const fresh: Chat = { ...chat, sessionId: undefined }
    this.d.store.saveChat(fresh)
    if (this.renewed.has(chat.id)) return false
    this.renewed.add(chat.id)
    this.item(fresh, { kind: 'note', id: randomUUID(), ts: Date.now(), text: SESSION_GONE_NOTE })
    this.end(chat.id, live)
    if (live.interrupted) return false
    let sent = live.sent
    const row = live.sentItem
    const nudged = (m: { from?: MessageFrom; parts: ChatPart[] }) => m.from === 'kernel' && isNudge(m.parts)
    const parts: ChatPart[] = [{ type: 'text', text: freshNudge(this.brief(chat.id)) }]
    // The row keeps its place: the store saves it again where it was, before the note.
    if (row && nudged(row)) {
      this.item(fresh, { ...row, parts })
      sent = parts
    }
    // A nudge still waiting, as the one after a quit, would tell the agent to pick up where it left off too.
    const queue = this.queued(chat.id)
    if (queue.some(nudged)) this.setQueue(chat.id, queue.map((q) => (nudged(q) ? { ...q, parts } : q)))
    const next = this.start(fresh, ws)
    next.carrying = live.carrying
    next.sent = sent
    next.sentItem = row
    next.runner.push(sent)
    this.setRunning(fresh, ws, next, true)
    return true
  }

  /** The text of the chat's first message that isn't one of Kernel's nudges: the brief a fresh session starts from. */
  private brief(chatId: string): string | undefined {
    const first = this.d.store.items(chatId).find((i): i is ChatItem & { kind: 'user' } => i.kind === 'user' && !(i.from === 'kernel' && isNudge(i.parts)))
    const text = first?.parts.flatMap((p) => (p.type === 'text' ? [p.text] : p.type === 'issue' || p.type === 'workspace' ? [linkText(p)] : [])).join('\n').trim()
    return text || undefined
  }

  /** True once a send right after stop() has started a newer session under this chat. */
  private replaced(chatId: string, live: Live) {
    const current = this.live.get(chatId)
    return !!current && current !== live
  }

  /** The running turn ended. Its result row, then what waits for the chat goes out, or Stop drops it. */
  private turnEnded(chatId: string, ws: Workspace, live: Live, t: { id: string; ok: boolean; durationMs?: number; error?: string }) {
    const chat = this.mustChat(chatId)
    const ok = t.ok
    // An interrupted turn ends with error_during_execution; the interrupted row already says what happened.
    if ((ok || !live.interrupted) && !live.cleared) this.item(chat, { kind: 'result', id: t.id, ts: Date.now(), durationMs: t.durationMs ?? 0, ok, error: ok ? undefined : t.error })
    this.clearRetry(chatId, live)
    void live.runner.context()
    const stopped = live.interrupted && !live.sendNext
    const interrupted = live.interrupted
    // Cut off by a limit Kernel knows about, so it can tell when to carry on. An unknown one would loop.
    if (live.limited && !stopped && this.limitHolds(chat)) this.setCutOff(chatId, 'limit')
    // A carry-on after a quit that failed on a sign-out or a dropped connection waits for that hold to lift and tries
    // again, as at launch. Without a hold in place nothing would ever lift, so it stays stopped like any failed turn.
    if (!ok && !stopped && live.carrying && live.failed && this.holding(chatProvider(chat))) this.setCutOff(chatId, 'quit')
    live.carrying = false
    live.failed = undefined
    live.interrupted = false
    live.sendNext = false
    // The hook that refused to let the agent finish has now let it finish.
    const turns = this.turnsOf(chatId)
    if (ok && turns.blocked !== 'PreToolUse') turns.blocked = undefined
    // A session that just finished a turn isn't broken, whoever sent it, as after Retry on a Kernel update (KERNEL-124).
    if (ok) { this.crashed.delete(chatId); this.renewed.delete(chatId) }
    live.limited = false
    live.cleared = false
    this.setRunning(chat, ws, live, false)
    // A turn a quit interrupted isn't over: it carries on at the next launch, which reports it then.
    if (!this.closing) this.d.onTurnDone?.(ws, chat, { ok, interrupted, by: turns.from ?? 'user' })
    // Stop means stop: held messages are dropped, not sent. Send now keeps them.
    if (stopped) this.setQueue(chatId, [])
    else this.drain(chatId)
    this.drainWaiting()
  }

  /**
   * Put a runner's request in front of the user and wait: a tool to allow, a question, or a plan. The agent shows as
   * needing the user meanwhile. Order: Never allow, the room's rules, Always ask and Bypass were the runner's to apply first.
   */
  private async ask(chatId: string, ws: Workspace, agent: AgentDef | undefined, a: Ask, o: { signal?: AbortSignal }, plan?: string): Promise<Decision | undefined> {
    this.setStatus(ws, agent, 'needs', a.activity)
    const reuse = plan !== undefined ? revisedPlanFile(this.d.store.approvals({ roomId: ws.roomId }), chatId) : undefined
    const { approval, decision } = this.d.approvals.request({
      kind: a.kind, source: 'sdk', roomId: ws.roomId, workspaceId: ws.id, chatId, agentId: agent?.id,
      toolName: a.toolName, input: a.input, title: a.title, detail: a.detail, options: a.options, questions: a.questions
    } as Parameters<Approvals['request']>[0], { signal: o.signal })
    this.placeApproval(chatId, approval.id)
    if (plan?.trim() && existsSync(ws.path)) {
      void savePlan(ws.path, plan, { fallback: approval.title, reuse }).then((planFile) => this.d.approvals.update(approval.id, { planFile }), () => undefined)
    }
    const result = await decision
    // A Codex plan waits for approval after its turn ended, so the agent goes back to idle rather than working.
    if (!this.showBlocked(ws, chatId)) this.setStatus(ws, agent, this.live.get(chatId)?.running === false ? 'idle' : 'working')
    return result ?? undefined
  }

  /**
   * A plan for the user to approve, from either provider (KERNEL-406): Claude's ExitPlanMode, or a Codex plan-mode turn's
   * plan. Approval takes the chat out of plan mode and starts a Lead's hand-off (`planApproved`).
   */
  private async requestPlan(chatId: string, ws: Workspace, agent: AgentDef | undefined, plan: string, o: { signal?: AbortSignal; toolName?: string; input?: unknown; activity?: string }): Promise<Decision | undefined> {
    const result = await this.ask(chatId, ws, agent, { kind: 'plan', toolName: o.toolName, input: o.input, title: `Plan for ${ws.name}`, detail: plan, activity: o.activity ?? 'Plan' }, o, plan)
    if (result?.behavior === 'allow') await this.planApproved(chatId)
    return result
  }

  private setRunning(chat: Chat, ws: Workspace, live: Live, running: boolean) {
    if (live.running === running) return
    live.running = running
    if (!running) { live.whenIdle?.(); live.whenIdle = undefined }
    // The journal is written at every turn start and end, so a crash leaves the right list. A quit freezes it.
    if (!this.closing && this.working.has(chat.id) !== running) {
      if (running) this.working.add(chat.id)
      else this.working.delete(chat.id)
      this.saveWorking()
    }
    bus.push({ type: 'chat.running', chatId: chat.id, running })
    // A turn starting stops the idle clock, and one ending starts it.
    if (running) this.stopIdle(chat.id)
    else this.startIdle(chat.id)
    // This chat's queue now waits for something else, and a slot was taken or freed for the others.
    this.pushReasons()
    // An agent that gave up after a hook refused it still needs someone to look.
    if (!running && this.showBlocked(ws, chat.id)) return
    this.setStatus(ws, this.d.agentFor(ws), running ? (chat.plan ? 'planning' : 'working') : 'idle')
  }

  private mergeLimits(next: LimitPatch[]) {
    if (!next.length) return
    for (const l of next) {
      const key = limitKey(l)
      // Claude's per-model windows name their model. Codex's windows are the account's.
      const now = Date.now()
      this.limits.set(key, { ...mergeLimit(this.limits.get(key), limitProvider(l) === 'claude' ? { ...l, model: l.model ?? WINDOW_MODEL[l.type] } : l, now), readAt: now })
    }
    this.pushLimits()
  }

  private pushLimits() {
    const limits = [...this.limits.values()]
    bus.push({ type: 'usage', limits })
    this.d.onLimits?.(limits)
    // A model's own limit lifting pauses and resumes no room, so its chats carry on from here. So does what a usage window
    // close to its limit held: a drop in usage or a reset sends it, and a rise holds the queues again (KERNEL-220).
    this.drainWaiting()
  }

  private clearRetry(chatId: string, live: Live) {
    if (!live.retry) return
    live.retry = undefined
    bus.push({ type: 'retry', chatId, retry: null })
  }

  /** Context window use, saved on the chat for the composer and the banner. Nothing changes when the numbers are the same. */
  private setContext(chatId: string, context: number, contextUsage: Chat['contextUsage']) {
    const chat = this.d.store.chat(chatId)
    if (!chat) return
    if (chat.context === context && JSON.stringify(chat.contextUsage) === JSON.stringify(contextUsage)) return
    const next = { ...chat, context, contextUsage }
    this.d.store.saveChat(next)
    bus.push({ type: 'chat', chat: next })
  }

  /** A paused room shows everyone as paused, except an agent waiting on the user, blocked by a hook or offline. */
  private setStatus(ws: Workspace, agent: AgentDef | undefined, status: AgentStatus, activity?: string) {
    const shown = this.paused.has(ws.roomId) && !PAUSE_KEEPS.has(status) ? 'paused' : status
    if (agent) bus.push({ type: 'agent.status', roomId: ws.roomId, agentId: agent.id, status: shown, activity })
  }

  /** The session ended without being stopped: the agent goes offline and the logs say where and why. */
  private offline(ws: Workspace, reason: string) {
    const detail = `Claude Code exited in ${ws.name}${reason ? ` (${reason.slice(0, 120)})` : ''}. The worktree and chat are saved.`
    this.setStatus(ws, this.d.agentFor(ws), 'offline', `Session ended in ${ws.name}`)
    bus.activity({ kind: 'session.end', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: 'went offline in', object: ws.name, warn: true, data: { detail, crashed: true } })
  }

  /** A hook exited with code 2: it refused the step. The agent shows as blocked with the hook's own words. */
  private blocked(ws: Workspace, chatId: string, event: string, output: string) {
    this.turnsOf(chatId).blocked = event
    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4)
    this.showBlocked(ws, chatId)
    bus.activity({
      kind: 'agent.status', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: 'was blocked on', object: ws.name, warn: true,
      data: { status: 'blocked', detail: `The ${event} hook refused the last step. Read its output, then fix it or ask the agent to.`, output: lines.length ? lines : undefined }
    })
  }

  /**
   * Shows the agent as blocked while a hook's refusal stands. False when nothing blocks it.
   * Blocked is kept per chat but shown per agent, so an agent with a blocked chat and a working one shows whichever pushed last.
   */
  private showBlocked(ws: Workspace, chatId: string): boolean {
    const blocked = this.turns.get(chatId)?.blocked
    if (!blocked) return false
    this.setStatus(ws, this.d.agentFor(ws), 'blocked', `Blocked by the ${blocked} hook`)
    return true
  }

  private unblock(chat: Chat, ws: Workspace) {
    this.turnsOf(chat.id).blocked = undefined
    this.setStatus(ws, this.d.agentFor(ws), chat.plan ? 'planning' : 'working')
  }

  private item(chat: Chat, item: ChatItem) {
    this.d.store.saveItem(chat.id, item)
    bus.push({ type: 'chat.item', chatId: chat.id, item })
  }

  /** Put an approval card in the chat's transcript, so it stays there after it is answered and across restarts. */
  placeApproval(chatId: string, approvalId: string) {
    this.item(this.mustChat(chatId), { kind: 'approval', id: `approval-${approvalId}`, ts: Date.now(), approvalId })
  }

  /** Where a shared file's card sits in the chat that shared it, one per version (KERNEL-302). */
  placeShared(chatId: string, sharedId: string, version: number) {
    this.item(this.mustChat(chatId), { kind: 'shared', id: `shared-${sharedId}-v${version}`, ts: Date.now(), sharedId, version })
  }

  private mustChat(id: string) { const c = this.d.store.chat(id); if (!c) throw new Error(`Unknown chat ${id}`); return c }
  private mustWorkspace(id: string) { const w = this.d.store.workspace(id); if (!w) throw new Error(`Unknown workspace ${id}`); return w }
}

export function agentPrompt(agent: AgentDef | undefined, ws: Workspace, rule?: string): string {
  // Before KERNEL-405 the Lead's shared worktree was detached, on no branch. Each chat with Rowan now has a branch of its own.
  const where = ws.lead && ws.mode === 'worktree' && ws.branch === 'HEAD'
    ? `You are working in your own git worktree at ${ws.path}, detached at ${ws.baseRef}, not on a branch. It is not the main checkout, which the user may be running. Stay inside it.`
    : ws.mode === 'worktree'
    ? `You are working in a git worktree at ${ws.path} on branch ${ws.branch}, created from ${ws.baseRef}.${ws.lead ? ' It is not the main checkout, which the user may be running.' : ''} Stay inside it.`
    : `You are working directly in the main checkout at ${ws.path} on ${ws.branch}. Some files already had changes before you started; never commit those unless asked.`
  const port = `If you start a dev server, use port ${ws.port} ($KERNEL_PORT).`
  return [agent?.prompt, agent?.lead && LEAD_RULE, rule, where, port].filter(Boolean).join('\n\n')
}

/** What Restart session sends, after any messages held for the chat. */
export const RESTART_NUDGE = 'Your session ended unexpectedly. Check the worktree and pick up where you left off.'

/** Statuses a pause leaves showing: the user still has to act on them. */
export const PAUSE_KEEPS = new Set<AgentStatus>(['needs', 'blocked', 'offline'])

/** What Kernel sends a chat a usage limit stopped, once the limit lifts. */
export const LIMIT_LIFTED = 'The usage limit that stopped you no longer applies. Pick up where you left off.'

/** What Kernel sends a chat whose turn was running when Kernel quit or closed, once it opens again (KERNEL-215). */
export const RELAUNCH_NUDGE = 'Kernel closed while you were working, so your last step may not have finished. Check the worktree and what you already did (git status, open PRs, workspaces you handed off) before you redo anything, then carry on.'

/** Why a chat that carries on after a relaunch stopped, as `onExit` reports it: a quit, or a crash or a force quit. */
export const QUIT_REASON = 'Kernel quit'
export const CRASH_REASON = 'Kernel closed unexpectedly'

/** The note in a chat whose turn a quit cut off, and the one after a crash or a force quit. */
export const QUIT_NOTE = 'Kernel quit while this agent was working.'
export const CRASH_NOTE = 'Kernel closed unexpectedly while this agent was working.'

/** The note in a chat whose session was gone, so Kernel started a new one. */
export const SESSION_GONE_NOTE = "Kernel started a new session because the old one is gone. The agent doesn't remember earlier turns in this chat."

/** How the nudge a fresh session gets in place of a restart, limit or relaunch nudge starts (KERNEL-286). */
export const FRESH_NUDGE = "Your earlier session in this chat is gone, so you don't remember anything from it."

/** The fresh-session nudge: what the agent lost, the chat's brief when there is one, and where to look before carrying on. */
export function freshNudge(brief?: string): string {
  return [
    FRESH_NUDGE,
    ...(brief ? [`The chat started with this message:\n\n${brief}`] : []),
    'Before you carry on, check the worktree to see what you already did: git status, git log and any open PR.'
  ].join('\n\n')
}

/** How long a quit waits for interrupted turns to end before it stops their processes. */
export const QUIT_BUDGET_MS = 3000

/** Every provider, for the holds that name one. */
const PROVIDER_IDS: Provider[] = ['claude', 'codex']

/** Meta keys Sessions saves itself: the working journal, every queue not held for setup, and the pids of live processes. */
const WORKING = 'working'
const QUEUES = 'queues'
const PIDS = 'claudePids'

/** How much of a process's stderr Kernel keeps for the error note. */
const STDERR_KEPT = 4000

/** Kernel's restart, limit, relaunch and fresh-session nudges, which carry on a turn rather than start one. */
export const isNudge = (parts: ChatPart[]) => parts.length === 1 && parts[0].type === 'text' && (parts[0].text === RESTART_NUDGE || parts[0].text === LIMIT_LIFTED || parts[0].text === RELAUNCH_NUDGE || parts[0].text.startsWith(FRESH_NUDGE))

/**
 * The leading run of a queue that goes out as a chat's first turn. A message with a skill chip goes alone, since Claude Code
 * reads a slash command only at the start of a message (D-030), and so does a Kernel nudge. Either ends the run, and the rest
 * go in the turns after it. When the first message is one of them, it is the whole run.
 */
const firstTurn = (queue: QueuedMessage[]): QueuedMessage[] => {
  const alone = (m: QueuedMessage) => m.parts.some((p) => p.type === 'skill') || (m.from === 'kernel' && isNudge(m.parts))
  if (alone(queue[0])) return queue.slice(0, 1)
  const end = queue.findIndex((m, at) => at > 0 && alone(m))
  return end < 0 ? queue : queue.slice(0, end)
}

/**
 * The process is alive and was started the way Kernel saved: its binary and first argument. Matching the first argument
 * too keeps a reused pid running `node something-else` from passing for `node cli.js`. An exited one (`(claude)`) is not.
 */
function runs(p: SavedPid): Promise<boolean> {
  const started = [p.command, p.arg].filter(Boolean).join(' ')
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-p', String(p.pid), '-o', 'command='], (err, out) => {
      const line = out.trim()
      resolve(!err && !!p.command && (line === started || line.startsWith(`${started} `)))
    })
  })
}

function signal(pid: number, sig: NodeJS.Signals) { try { process.kill(pid, sig) } catch { /* already gone */ } }
