import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { query, type CanUseTool, type HookCallback, type HookCallbackMatcher, type HookEvent, type Options, type PermissionResult, type PermissionUpdate, type PreToolUseHookInput, type Query, type SDKControlGetUsageResponse, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, AgentStatus, AskedQuestion, BuiltinCommand, Chat, ChatItem, ChatPart, MessageFrom, QueuedMessage, QueueReason, RateLimit, TeamUpdate, Workspace } from '@shared/types'
import { MODELS } from '@shared/types'
import type { HookPayload } from '@shared/hookSchemas'
import { linkText } from '@shared/links'
import { isKernelUpdate } from '@shared/teamUpdate'
import type { Store } from '../db'
import { bus } from '../bus'
import { describeTool, matchesRule, needsUser, type Approvals } from './approvals'
import { toActivity } from './hookServer'
import { blockingLimit, failureOf, limitedModels, WINDOW_MODEL, type Failure } from './health'
import { Handoffs, HANDOFF_NOW, LEAD_RULE } from './handoff'
import { IMAGE_DATA_URL, savePlan } from './plans'
import type { AppSettings } from './settings'

/**
 * The SDK's `claude` binary in a packaged app. The SDK finds it with require.resolve, which points inside app.asar,
 * and a binary there can't be spawned. electron-builder unpacks it to app.asar.unpacked (electron-builder.yml).
 * Outside a packaged app this is undefined and the SDK finds its own.
 */
export function packagedClaude(resources = (process as { resourcesPath?: string }).resourcesPath): string | undefined {
  if (!resources) return undefined
  const path = join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude')
  return existsSync(path) ? path : undefined
}

/** An async queue the SDK reads user turns from. Pushing a message sends it into the running session. */
export class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false
  push(item: T) { const w = this.waiters.shift(); if (w) w({ value: item, done: false }); else this.items.push(item) }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true }) }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

interface Live {
  query: Query; input: InputQueue<SDKUserMessage>; abort: AbortController; running: boolean; interrupted: boolean
  /** Background tasks (shells, subagents, monitors) the process is running, from its latest background_tasks_changed. */
  tasks: Set<string>
  /** Set by sendNow: the interrupted turn is followed by the queue. A plain Stop is not. */
  sendNext?: boolean
  /** An api_retry is counting down. The next reply or result clears the banner. */
  retrying?: boolean
  /** Claude Code answered this turn with a usage limit, so the turn ended early. */
  limited?: boolean
  /** This turn was /clear. Its result row is left out, so the cleared chat starts empty. */
  cleared?: boolean
  toolItems: Map<string, ChatItem & { kind: 'tool' }>
  /** Agent rows whose label already names the subagent's model, by tool use id. The call's own `model` is final (KERNEL-158). */
  agentModels: Set<string>
  /** Bash commands by tool use id, as the model wrote them. Other hooks may rewrite the input canUseTool sees. */
  commands: Map<string, string>
}

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

/** How long a chat with nothing to do keeps its Claude Code process before Kernel stops it. The next message resumes it (KERNEL-183). */
export const IDLE_STOP_MS = 10 * 60_000

export interface SessionDeps {
  store: Store
  approvals: Approvals
  settings: () => AppSettings
  agentFor: (ws: Workspace) => AgentDef | undefined
  /** In-process MCP servers this agent may use (Kernel's own tools for the lead). */
  mcpFor: (ws: Workspace, agent: AgentDef | undefined, chat: Chat) => Options['mcpServers']
  /** Kernel's own rule for this workspace, appended to the agent's prompt, such as a reviewer's (KERNEL-130). */
  rulesFor?: (ws: Workspace, agent: AgentDef | undefined) => string | undefined
  /** Bash rules the user allowed for the whole room. */
  roomAllow: (roomId: string) => string[]
  allowInRoom: (roomId: string, rule: string) => void
  /** The agent sent a message, its subagents' included. Kernel looks for the session's title then. */
  onReply?: (ws: Workspace, chat: Chat) => void
  /** Claude Code started a fresh conversation in the chat. `trigger` is the SDK's: 'clear' for /clear, absent from older emitters (KERNEL-202). */
  onReset?: (ws: Workspace, chat: Chat, trigger?: string) => void
  /** A turn ended. `ok` is false for an error; `interrupted` is true when the user stopped it; `by` sent the message that started it. */
  onTurnDone?: (ws: Workspace, chat: Chat, turn: { ok: boolean; interrupted: boolean; by: TurnBy }) => void
  /**
   * The session's process ended without being stopped. `midTurn` is true when a turn was running, so the agent's work
   * stopped halfway; an idle process that went away harms nothing, since the next message starts a new one. Stop,
   * archive and quit don't call this.
   */
  onExit?: (ws: Workspace, chat: Chat, reason: string, midTurn: boolean, resumed: boolean) => void
  /** A session hit something the banners show: a sign-out, a dropped connection. Kernel checks it and tells the renderer. */
  onFailure?: (failure: Failure, ws: Workspace) => void
  /** Usage windows changed. Kernel pauses rooms on an account-wide rejection and schedules the reset. */
  onLimits?: (limits: RateLimit[]) => void
  /** The chats a limit stopped changed. Kernel saves them, so they still carry on after a restart. */
  onCutOff?: (chatIds: string[]) => void
  /** What chats held for setup are holding changed. Kernel saves it, so a brief survives a restart (KERNEL-128). */
  onHeld?: (held: Record<string, QueuedMessage[]>) => void
}

/** Who sent a message the user didn't type, and the Team update card it carries (KERNEL-116). */
export interface Sender { from?: MessageFrom; update?: TeamUpdate }

/** Who started a turn. */
export type TurnBy = MessageFrom | 'user'

/** Moved to the shared contract (KERNEL-271). Exported here too for what imports it from Sessions. */
export type { QueueReason }

/** The sender fields to store on a chat item or queue entry, leaving out the ones that aren't set. */
const sender = (o: Sender): Sender => ({ ...(o.from ? { from: o.from } : {}), ...(o.update ? { update: o.update } : {}) })

export class Sessions {
  private live = new Map<string, Live>()
  /** Per chat, whether or not its process is running. */
  private turns = new Map<string, Turns>()
  /** Idle clocks of live chats between turns. One that runs out stops the process (KERNEL-183). */
  private idle = new Map<string, ReturnType<typeof setTimeout>>()
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
  /** Rooms the user (or a limit) paused. Their agents finish the step they are on, then wait at the next tool call. */
  private paused = new Map<string, { open: Promise<void>; release: () => void }>()
  /** Every room at once: offline or signed out. Same rules as a pause, and it lasts while any reason stands. */
  private global?: { open: Promise<void>; release: () => void; reasons: Set<string> }
  /** Chats whose first prompt waits for the workspace's setup script to pass. */
  private waiting = new Set<string>()
  /** Chats a usage limit stopped mid-turn. They carry on by themselves once the limit lifts (`carryOn`). */
  private cutOff = new Set<string>()
  /** Chats whose session died mid-turn. `post` leaves them alone until the user sends or restarts (KERNEL-124). */
  private crashed = new Set<string>()
  /** Claude Code's own slash commands. They come with the CLI, so one read lasts the whole run. */
  private builtins?: Promise<BuiltinCommand[]>
  constructor(private d: SessionDeps) {}

  /**
   * What Kernel saved before it last quit: the usage windows, the chats a limit stopped, and the queues of chats held for
   * setup (KERNEL-128). A rejection without a reset time is dropped, since nothing could tell when it ends, so it no longer
   * holds anything. A held queue comes back only while its workspace's setup still has to pass, or while a ready workspace's
   * brief waits for a PR to merge (KERNEL-259). One still in setup is left to Kernel's `recoverSetups`, which holds it once.
   */
  restore(limits: RateLimit[], cutOff: string[], held: Record<string, QueuedMessage[]> = {}) {
    for (const l of limits) this.limits.set(l.type, l.status === 'rejected' && !l.resetsAt ? { ...l, status: 'allowed' } : l)
    for (const id of cutOff) this.cutOff.add(id)
    // Chats whose setup failed before Kernel quit still hold their brief, and what was sent after it, for Run again.
    for (const [id, queue] of Object.entries(held)) {
      const chat = this.d.store.chat(id)
      const ws = chat && this.d.store.workspace(chat.workspaceId)
      const waiting = ws?.status === 'ready' && !!ws.waitsFor?.held
      if ((ws?.status !== 'failed' && !waiting) || !Array.isArray(queue)) continue
      this.waiting.add(id)
      this.setQueue(id, queue)
    }
    // Entries left out above, as an archived workspace's, drop out of what Kernel saves.
    this.saveHeld()
    this.pushLimits()
  }

  /** Hold every room, the way a pause holds one: agents finish their step and wait, sends queue. */
  holdAll(reason: string) {
    if (this.global) { this.global.reasons.add(reason); return }
    let release!: () => void
    const open = new Promise<void>((resolve) => { release = resolve })
    this.global = { open, release, reasons: new Set([reason]) }
    this.pushReasons()
  }

  /** Drop one reason for the hold. When none is left, agents go on and what queued meanwhile is sent. */
  releaseAll(reason: string) {
    const g = this.global
    if (!g?.reasons.delete(reason) || g.reasons.size) return
    this.global = undefined
    g.release()
    for (const chatId of [...this.queues.keys()]) if (!this.live.get(chatId)?.running) this.drain(chatId)
    this.carryOn()
    this.pushReasons()
  }

  heldFor(): string[] { return [...(this.global?.reasons ?? [])] }

  /** Put a message in the chat's queue without sending it, until `release`. Used for the first prompt while setup fails. */
  hold(chatId: string, parts: ChatPart[], o: Sender = {}) {
    this.waiting.add(chatId)
    this.setQueue(chatId, [...this.queued(chatId), { id: randomUUID(), chatId, parts, ts: Date.now(), ...sender(o) }])
  }

  release(chatId: string) {
    this.waiting.delete(chatId)
    this.saveHeld()
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

  /** Mark a usage window as reset (its resetsAt passed) and tell the renderer. */
  resetLimit(type: RateLimit['type']) {
    const l = this.limits.get(type)
    if (!l || l.status === 'allowed') return
    this.limits.set(type, { ...l, status: 'allowed', utilization: 0 })
    this.pushLimits()
  }

  /** /compact in the chat: Claude Code summarises the conversation and frees context. Queues behind a running turn. */
  compact(chatId: string) { return this.send(chatId, [{ type: 'text', text: '/compact' }]) }

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
    for (const ws of this.d.store.workspaces(roomId)) for (const c of this.d.store.chats(ws.id)) if (!this.live.get(c.id)?.running) this.drain(c.id)
    this.carryOn()
    this.pushReasons()
  }

  private pausedChat(chat: Chat) {
    if (this.global || this.waiting.has(chat.id)) return true
    const ws = this.d.store.workspace(chat.workspaceId)
    return !!ws && this.paused.has(ws.roomId)
  }

  /** Session ids started by Kernel. The hook server ignores these because in-process hooks already report them. */
  isManaged(sessionId: string) { return this.managedIds.has(sessionId) }
  isRunning(chatId: string) { return this.live.get(chatId)?.running ?? false }
  /** apiKeySource from the chat's init message. 'none' means the Claude plan pays. */
  billingOf(chatId: string) { return this.billing.get(chatId) }

  /**
   * 5-hour and weekly windows, fetched only when asked. A live session answers the experimental usage call.
   * Without one, `probeIn` starts a short session there to ask; otherwise, or when the call fails, the last rate_limit_event numbers stand.
   */
  async usage(o: { probeIn?: string } = {}): Promise<RateLimit[]> {
    const live = [...this.live.values()].find((l) => !l.abort.signal.aborted)
    if (live) await this.readUsage(live.query)
    else if (o.probeIn) await this.probeUsage(o.probeIn)
    return [...this.limits.values()]
  }

  private async readUsage(q: Query) {
    const ask = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof ask !== 'function') return
    try { this.mergeLimits(limitsFromUsage(await withTimeout(ask.call(q, { skipBehaviors: true }), 10_000))) } catch { /* keep rate_limit_event data */ }
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
    const live = [...this.live.values()].find((l) => !l.abort.signal.aborted)
    if (live) return builtinCommands(await withTimeout(live.query.supportedCommands(), 15_000))
    const input = new InputQueue<SDKUserMessage>()
    const abort = new AbortController()
    try {
      const q = query({ prompt: input, options: { cwd, settingSources: [], persistSession: false, abortController: abort, env: sessionEnv(process.env, {}), pathToClaudeCodeExecutable: packagedClaude() } })
      return builtinCommands(await withTimeout(q.supportedCommands(), 15_000))
    } finally {
      input.close()
      abort.abort()
    }
  }

  /** Claude Code started with no prompt, no settings and no transcript, asked for usage and stopped. It sends no message, so it uses none of the plan. */
  private async probeUsage(cwd: string) {
    const input = new InputQueue<SDKUserMessage>()
    const abort = new AbortController()
    try {
      const q = query({ prompt: input, options: { cwd, settingSources: [], persistSession: false, abortController: abort, env: sessionEnv(process.env, {}), pathToClaudeCodeExecutable: packagedClaude() } })
      await this.readUsage(q)
    } catch { /* keep rate_limit_event data */ } finally {
      input.close()
      abort.abort()
    }
  }

  /**
   * Starts a turn, or holds the message when one is running. A held message shows in the composer
   * (edit or remove it until it goes) and is sent, in order, when the turn ends. `why` says what it waits for.
   * `from` marks a message the user didn't type, and it stays on the message while it waits (KERNEL-116).
   */
  async send(chatId: string, parts: ChatPart[], o: Sender = {}): Promise<{ queued: boolean; why?: QueueReason }> {
    const chat = this.mustChat(chatId)
    // The user is redirecting the Lead, even when the message waits in the queue, so no hand-off reminder follows.
    if (o.from !== 'kernel') this.handoffs.done(chatId)
    const why = this.waitsFor(chat.id)
    if (why) {
      this.setQueue(chatId, [...this.queued(chatId), { id: randomUUID(), chatId, parts, ts: Date.now(), ...sender(o) }])
      return { queued: true, why }
    }
    this.dispatch(chat, parts, o)
    return { queued: false }
  }

  /** What a message sent now would wait for, or nothing when it can go at once. */
  waitsFor(chatId: string): QueueReason | undefined {
    const chat = this.d.store.chat(chatId)
    if (!chat) return undefined
    if (this.live.get(chat.id)?.running) return 'running'
    if (this.waiting.has(chat.id)) return 'setup'
    if (this.global) return 'offline'
    if (this.pausedChat(chat)) return 'paused'
    if (this.atCapacity(chat.id)) return 'capacity'
    return undefined
  }

  /**
   * Kernel's own message into an idle chat, such as the Lead's teammate updates (KERNEL-72). It starts a turn like a user
   * message, but it isn't the user redirecting, so a pending hand-off reminder stays. It sends nothing and returns false
   * when the chat is running, has messages queued, is paused or is over the agent limit; the caller keeps it for later.
   */
  post(chatId: string, parts: ChatPart[], o: { update?: TeamUpdate } = {}): boolean {
    const chat = this.mustChat(chatId)
    if (this.live.get(chatId)?.running || this.queued(chatId).length || this.pausedChat(chat) || this.atCapacity(chatId) || this.crashed.has(chatId)) return false
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
   * held only by the agent limit sends it at once. `pastPause` sends it from an idle chat even though its room is paused,
   * which Kernel asks for when a limit paused it.
   */
  async sendNow(chatId: string, id: string, o: { pastPause?: boolean } = {}): Promise<QueuedMessage[]> {
    const pick = this.queued(chatId).find((q) => q.id === id)
    if (!pick) return this.queued(chatId)
    const rest = this.queued(chatId).filter((q) => q.id !== id)
    this.setQueue(chatId, [pick, ...rest])
    const live = this.live.get(chatId)
    const why = this.waitsFor(chatId)
    if (live?.running) { live.sendNext = true; await this.interrupt(chatId, true) }
    // Pressing Send now is the user choosing to go over the agent limit (KERNEL-271).
    else if (why === 'capacity' || (why === 'paused' && o.pastPause)) { this.setQueue(chatId, rest); this.dispatch(this.mustChat(chatId), pick.parts, pick) }
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

  private dispatch(chat: Chat, parts: ChatPart[], o: Sender = {}) {
    const ws = this.mustWorkspace(chat.workspaceId)
    // A held message going out counts as the user taking over too. Kernel's own updates don't.
    if (o.from !== 'kernel') { this.handoffs.done(chat.id); this.crashed.delete(chat.id) }
    // A nudge picks up a turn a limit or a crash cut short, so the turn is still the one whoever started it started.
    // Read before the nudge is saved, which would be the last message.
    const by = o.from === 'kernel' && isNudge(parts) ? this.startedBy(chat.id) : o.from
    // Whatever goes out next picks the chat up again, so it no longer waits for the limit.
    this.setCutOff(chat.id, false)
    this.item(chat, { kind: 'user', id: randomUUID(), ts: Date.now(), parts, ...sender(o) })
    const live = this.live.get(chat.id) ?? this.start(chat, ws)
    const turns = this.turnsOf(chat.id)
    turns.from = by
    // A new message takes the agent past whatever a hook refused.
    turns.blocked = undefined
    live.input.push(toUserMessage(parts))
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

  /** Send the oldest held message. The next one goes when this turn ends. */
  private drain(chatId: string) {
    const [next, ...rest] = this.queued(chatId)
    const chat = this.d.store.chat(chatId)
    if (!next || !chat || this.pausedChat(chat) || this.atCapacity(chatId)) return
    this.setQueue(chatId, rest)
    this.dispatch(chat, next.parts, next)
  }

  /** Settings changed. The lists and the timeout are read per tool call; the mode is moved on live sessions now, and a higher limit starts waiting work. */
  applySettings(before?: AppSettings) {
    if (!before || before.permissions.mode !== this.d.settings().permissions.mode) {
      for (const [id, l] of this.live) {
        if (this.d.store.chat(id)?.plan) continue
        void l.query.setPermissionMode(this.baseMode()).catch(() => undefined)
      }
    }
    this.drainWaiting()
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

  /** A slot opened (a turn ended or the limit went up): start held messages of idle chats, oldest queue first, while there is room. */
  drainWaiting() {
    for (const id of [...this.queues.keys()]) if (!this.live.get(id)?.running) this.drain(id)
    this.carryOn()
    // A lower limit in Settings, Models holds queues that waited for nothing a moment ago.
    this.pushReasons()
  }

  /**
   * Chats a usage limit stopped go on once nothing holds them: no limit on the account or on their model, no pause, and a
   * free slot. What the user queued goes first; otherwise Kernel tells the agent to pick up where it left off.
   */
  private carryOn() {
    for (const id of [...this.cutOff]) {
      const chat = this.d.store.chat(id)
      const ws = chat && this.d.store.workspace(chat.workspaceId)
      if (!chat || chat.closed || !ws || ws.status === 'archived') { this.setCutOff(id, false); continue }
      if (this.live.get(id)?.running || this.pausedChat(chat) || this.atCapacity(id) || this.limitHolds(chat)) continue
      if (this.queued(id).length) this.drain(id)
      else this.dispatch(chat, [{ type: 'text', text: LIMIT_LIFTED }], { from: 'kernel' })
    }
  }

  /** A known usage limit stops this chat: one on the whole account, or on the chat's model. */
  private limitHolds(chat: Chat) {
    const limits = [...this.limits.values()]
    return !!blockingLimit(limits) || limitedModels(limits).includes(chat.model)
  }

  /** A usage limit stopped this chat mid-turn and it waits to carry on. */
  private isCutOff(chatId: string) { return this.cutOff.has(chatId) }

  private setCutOff(chatId: string, on: boolean) {
    if (this.isCutOff(chatId) === on) return
    if (on) this.cutOff.add(chatId)
    else this.cutOff.delete(chatId)
    this.d.onCutOff?.([...this.cutOff])
  }

  private setQueue(chatId: string, queue: QueuedMessage[]): QueuedMessage[] {
    if (queue.length) this.queues.set(chatId, queue)
    else this.queues.delete(chatId)
    // An idle chat's clock counts from its last change, so a message that waited and was removed buys it the full time.
    if (this.idle.has(chatId)) this.startIdle(chatId)
    this.pushQueue(chatId)
    // A held brief edited or removed in the composer is saved too.
    if (this.waiting.has(chatId)) this.saveHeld()
    return queue
  }

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

  /** A turn started or ended, or a hold began or lifted: held queues whose reason changed tell the renderer. */
  private pushReasons() {
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
    await live.query.interrupt().catch(() => undefined)
    this.item(this.mustChat(chatId), { kind: 'interrupted', id: randomUUID(), ts: Date.now() })
  }

  async configure(chatId: string, patch: Partial<Pick<Chat, 'model' | 'effort' | 'plan'>>): Promise<Chat> {
    const chat = { ...this.mustChat(chatId), ...patch }
    this.d.store.saveChat(chat)
    const live = this.live.get(chatId)
    if (live) {
      if (patch.model) await live.query.setModel(patch.model).catch(() => undefined)
      // After the model, so a model switch keeps the effort picked with it (D-093).
      if (patch.effort) await live.query.applyFlagSettings({ effortLevel: patch.effort }).catch(() => undefined)
      if (patch.plan !== undefined) await live.query.setPermissionMode(patch.plan ? 'plan' : this.baseMode()).catch(() => undefined)
    }
    // "Switch to" on a model's limit: the new model picks up where the limit stopped the chat.
    if (patch.model) this.carryOn()
    return chat
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
    live.input.close()
    live.abort.abort()
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

  /** The workspace is archived. Chats held for its setup let go of what they held, so a restore doesn't find them still waiting. */
  dropHeld(workspaceId: string) {
    for (const c of this.d.store.chats(workspaceId)) if (this.waiting.delete(c.id)) { this.setQueue(c.id, []); this.saveHeld() }
  }
  stopAll() { for (const id of [...this.live.keys()]) this.stop(id) }

  private baseMode(): NonNullable<Options['permissionMode']> { return this.d.settings().permissions.mode === 'ask' ? 'default' : 'acceptEdits' }

  private start(chat: Chat, ws: Workspace): Live {
    const agent = this.d.agentFor(ws)
    const input = new InputQueue<SDKUserMessage>()
    const abort = new AbortController()
    const commands = new Map<string, string>()
    const ctx = { roomId: ws.roomId, workspaceId: ws.id, agentId: agent?.id }
    // Known before the process starts, so the hook server never mistakes this session's first hooks for an outside one.
    const sessionId = chat.sessionId ?? randomUUID()
    this.managedIds.add(sessionId)
    const options: Options = {
      cwd: ws.path,
      model: chat.model,
      effort: chat.effort,
      // Without display: 'summarized' the CLI sends thinking blocks with empty text.
      thinking: { type: 'adaptive', display: 'summarized' },
      permissionMode: chat.plan ? 'plan' : this.baseMode(),
      canUseTool: this.canUseTool(chat, ws, agent, commands),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: agentPrompt(agent, ws, this.d.rulesFor?.(ws, agent)) },
      mcpServers: this.d.mcpFor(ws, agent, chat),
      hooks: kernelHooks(ctx, commands, (command) => bashVerdict(command, this.d.settings().permissions, this.d.roomAllow(ws.roomId)), () => this.paused.get(ws.roomId)?.open ?? this.global?.open, () => this.d.settings().permissions.network !== false,
        agent?.lead ? { afterPlan: () => (this.handoffs.due(chat.id) ? HANDOFF_NOW : undefined), atStop: () => this.handoffs.reminder(chat.id) } : undefined),
      includeHookEvents: true,
      ...(chat.sessionId ? { resume: chat.sessionId } : { sessionId }),
      abortController: abort,
      env: sessionEnv(process.env, { KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE_ID: ws.id }, { agentTeams: this.d.settings().models?.agentTeams }),
      pathToClaudeCodeExecutable: packagedClaude()
    }
    const q = query({ prompt: input, options })
    const live: Live = { query: q, input, abort, running: false, interrupted: false, tasks: new Set(), toolItems: new Map(), agentModels: new Set(), commands }
    this.live.set(chat.id, live)
    void this.consume(chat.id, ws, live)
    return live
  }

  private async consume(chatId: string, ws: Workspace, live: Live) {
    let ended: string | null = null
    try {
      // A stopped process can still deliver lines it had already written. Once a newer session owns the chat, they are dropped.
      for await (const msg of live.query) if (!this.replaced(chatId, live)) this.handle(chatId, ws, live, msg)
      // Nobody asked it to stop, so the process went away on its own.
      if (!live.abort.signal.aborted) ended = ''
    } catch (err) {
      if (!live.abort.signal.aborted) {
        ended = String((err as Error).message ?? err)
        this.item(this.mustChat(chatId), { kind: 'note', id: randomUUID(), ts: Date.now(), text: `Session stopped: ${ended}` })
      }
    } finally {
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
  }

  /** True once a send right after stop() has started a newer session under this chat. */
  private replaced(chatId: string, live: Live) {
    const current = this.live.get(chatId)
    return !!current && current !== live
  }

  private handle(chatId: string, ws: Workspace, live: Live, msg: SDKMessage) {
    let chat = this.mustChat(chatId)
    const now = Date.now()
    switch (msg.type) {
      case 'system': {
        // The CLI sends init at the start of every turn, including queued follow-ups after an interrupt.
        if (msg.subtype === 'init') {
          this.managedIds.add(msg.session_id)
          if (chat.sessionId !== msg.session_id) { chat = { ...chat, sessionId: msg.session_id }; this.d.store.saveChat(chat) }
          if (!this.billing.has(chatId) && msg.apiKeySource !== 'none') {
            this.item(chat, { kind: 'note', id: randomUUID(), ts: now, text: `This session is billed through ${msg.apiKeySource}, not your Claude plan.` })
            bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, sessionId: msg.session_id, text: `is billed through ${msg.apiKeySource}, not the Claude plan` })
          }
          this.billing.set(chatId, msg.apiKeySource)
          this.setRunning(chat, ws, live, true)
        }
        if (msg.subtype === 'hook_response' && msg.exit_code === 2 && BLOCKING_HOOKS.has(msg.hook_event)) this.blocked(ws, chatId, msg.hook_event, msg.stderr || msg.output || msg.stdout)
        // The SDK's level signal for background work, which replaces the whole set. Ambient tasks are housekeeping, not work.
        if (msg.subtype === 'background_tasks_changed') live.tasks = new Set(msg.tasks.filter((t) => !t.ambient).map((t) => t.task_id))
        if (msg.subtype === 'api_retry') {
          const failure = failureOf(msg.error, msg.error_status)
          // A connection error is the network's banner, not the overloaded one.
          if (failure === 'network' || failure === 'auth') this.d.onFailure?.(failure, ws)
          else { live.retrying = true; bus.push({ type: 'retry', chatId, retry: { attempt: msg.attempt, of: msg.max_retries, nextAt: now + msg.retry_delay_ms } }) }
        }
        if (msg.subtype === 'compact_boundary') void this.refreshContext(chatId, live)
        // Most commands answer with an assistant message; some print here instead.
        if (msg.subtype === 'local_command_output' && msg.content.trim()) this.item(chat, { kind: 'text', id: msg.uuid, ts: now, text: msg.content })
        return
      }
      case 'conversation_reset': {
        // /clear (or /reset, /new): Claude Code starts a fresh conversation under a new session id, which the next init
        // saves. The transcript starts over too, as the CLI's screen does. The old conversation stays in Claude Code's own history.
        this.d.store.clearItems(chatId)
        live.toolItems.clear()
        live.agentModels.clear()
        if (msg.trigger === 'clear') live.cleared = true
        bus.push({ type: 'chat.cleared', chatId })
        this.d.onReset?.(ws, chat, msg.trigger)
        return
      }
      case 'assistant': {
        this.clearRetry(chatId, live)
        const failure = failureOf(msg.error)
        if (failure === 'auth') this.d.onFailure?.(failure, ws)
        if (failure === 'limit') live.limited = true
        this.d.onReply?.(ws, chat)
        // Subagent chatter stays inside the tool row. Only the model it runs on reaches the row's label.
        if (msg.parent_tool_use_id) { this.subagentModel(chat, live, msg.parent_tool_use_id, msg.message.model); return }
        msg.message.content.forEach((block: any, i: number) => {
          const id = `${msg.uuid}:${i}`
          if (block.type === 'text' && block.text?.trim()) this.item(chat, { kind: 'text', id, ts: now, text: block.text })
          else if (block.type === 'thinking' && block.thinking?.trim()) this.item(chat, { kind: 'thinking', id, ts: now, text: block.thinking })
          else if (block.type === 'tool_use') {
            const d = describeTool(block.name, block.input)
            // A fork ignores `model` and runs on the parent's, so its first message names it instead.
            const model = SUBAGENT_TOOLS.has(block.name) && block.input?.model && block.input.subagent_type !== 'fork' ? String(block.input.model) : undefined
            if (model) live.agentModels.add(block.id)
            const label = model ? `${d.title} · ${modelName(model)}` : d.title
            const item: ChatItem & { kind: 'tool' } = { kind: 'tool', id, ts: now, toolUseId: block.id, name: block.name, label, detail: toolDetail(block.name, block.input), status: 'running', input: clipInput(block.input) }
            live.toolItems.set(block.id, item)
            this.item(chat, item)
          }
        })
        return
      }
      case 'user': {
        const content = (msg.message as any).content
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (block?.type !== 'tool_result') continue
          const item = live.toolItems.get(block.tool_use_id)
          live.commands.delete(block.tool_use_id)
          // A step that went through after a PreToolUse refusal: the agent found its way past it.
          if (item && !block.is_error && this.turns.get(chatId)?.blocked === 'PreToolUse') this.unblock(chat, ws)
          if (!item) continue
          const output = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c.text ?? '').join('\n')
          const cut = output.length > TOOL_TEXT_MAX
          const done = { ...item, status: block.is_error ? 'failed' : 'done', output: output.slice(0, TOOL_TEXT_MAX), outputCut: cut || undefined, ts: item.ts } as ChatItem & { kind: 'tool' }
          live.toolItems.set(block.tool_use_id, done)
          this.item(chat, done)
        }
        return
      }
      case 'result': {
        const ok = msg.subtype === 'success'
        // An interrupted turn ends with error_during_execution; the interrupted row already says what happened.
        if ((ok || !live.interrupted) && !live.cleared) this.item(chat, { kind: 'result', id: msg.uuid, ts: now, durationMs: msg.duration_ms, ok, error: ok ? undefined : msg.subtype })
        this.clearRetry(chatId, live)
        void this.refreshContext(chatId, live)
        const stopped = live.interrupted && !live.sendNext
        const interrupted = live.interrupted
        // Cut off by a limit Kernel knows about, so it can tell when to carry on. An unknown one would loop.
        if (live.limited && !stopped && this.limitHolds(chat)) this.setCutOff(chatId, true)
        live.interrupted = false
        live.sendNext = false
        // The hook that refused to let the agent finish has now let it finish.
        const turns = this.turnsOf(chatId)
        if (ok && turns.blocked !== 'PreToolUse') turns.blocked = undefined
        // A session that just finished a turn isn't broken, whoever sent it, as after Retry on a Kernel update (KERNEL-124).
        if (ok) this.crashed.delete(chatId)
        live.limited = false
        live.cleared = false
        this.setRunning(chat, ws, live, false)
        this.d.onTurnDone?.(ws, chat, { ok, interrupted, by: turns.from ?? 'user' })
        // Stop means stop: held messages are dropped, not sent. Send now keeps them.
        if (stopped) this.setQueue(chatId, [])
        else this.drain(chatId)
        this.drainWaiting()
        return
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info
        if (info.status === 'rejected' && live.running) live.limited = true
        this.mergeLimits(limitsFromEvent(info))
        if (info.status === 'rejected' && info.rateLimitType) bus.activity({ kind: 'limit', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: `hit the ${info.rateLimitType.replace(/_/g, ' ')} limit`, data: { resetsAt: info.resetsAt } })
        return
      }
      default: return
    }
  }

  /**
   * Called for whatever Claude Code would prompt for, including Bash the PreToolUse hook marked Always ask.
   * Order: Never allow, the room's Always allow rules, Always ask, Bypass in worktrees, then the user decides.
   */
  private canUseTool(chat: Chat, ws: Workspace, agent: AgentDef | undefined, commands: Map<string, string>): CanUseTool {
    return async (toolName, input, { signal, suggestions, suppressAlwaysAllowRule, toolUseID }): Promise<PermissionResult> => {
      const p = this.d.settings().permissions
      if (toolName.startsWith('mcp__kernel__')) return { behavior: 'allow', updatedInput: input }
      if (p.network === false && (toolName === 'WebFetch' || toolName === 'WebSearch')) return { behavior: 'deny', message: NETWORK_OFF }
      const command = toolName === 'Bash' ? commands.get(toolUseID) ?? String((input as any).command ?? '') : ''
      if (command && p.network === false && usesNetwork(command)) return { behavior: 'deny', message: NETWORK_OFF }
      const verdict = command ? bashVerdict(command, p, this.d.roomAllow(ws.roomId)) : undefined
      if (verdict === 'deny') return { behavior: 'deny', message: `Kernel blocks "${command}" in every room.` }
      if (verdict === 'allow') return { behavior: 'allow', updatedInput: input }
      if (verdict !== 'ask' && !needsUser(toolName) && p.mode === 'bypassInWorktrees' && ws.mode === 'worktree') return { behavior: 'allow', updatedInput: input }

      const isQuestion = toolName === 'AskUserQuestion'
      const shown = command ? { ...input, command } : input
      const d = describeTool(toolName, shown)
      const questions = isQuestion ? askedQuestions(input) : undefined
      const options = questions?.[0]?.options.map((o) => o.label) ?? (isQuestion ? [] : undefined)
      this.setStatus(ws, agent, 'needs', d.title)
      const isPlan = toolName === 'ExitPlanMode'
      const plan = isPlan ? String((input as any).plan ?? '') : ''
      const reuse = isPlan ? this.lastPlanFile(chat, ws) : undefined
      const { approval, decision } = this.d.approvals.request({
        kind: isQuestion ? 'question' : isPlan ? 'plan' : 'tool', source: 'sdk', roomId: ws.roomId, workspaceId: ws.id, chatId: chat.id, agentId: agent?.id,
        toolName, input: shown, title: isQuestion ? questions?.[0]?.question ?? 'Question' : isPlan ? `Plan for ${ws.name}` : d.title,
        detail: isPlan ? plan : d.detail, options, questions
      }, { signal })
      this.placeApproval(chat.id, approval.id)
      if (isPlan && plan.trim() && existsSync(ws.path)) {
        void savePlan(ws.path, plan, { fallback: approval.title, reuse }).then((planFile) => this.d.approvals.update(approval.id, { planFile }), () => undefined)
      }
      const result = await decision
      if (!this.showBlocked(ws, chat.id)) this.setStatus(ws, agent, 'working')
      if (!result) return { behavior: 'deny', message: 'No decision was made in time.' }
      // Once the plan is approved the chat leaves plan mode, so a restart does not put it back.
      if (isPlan && result.behavior === 'allow') await this.configure(chat.id, { plan: false }).catch(() => undefined)
      if (isPlan && result.behavior === 'allow' && agent?.lead) this.handoffs.approved(chat.id)
      if (result.behavior === 'allow' && result.always && command) this.d.allowInRoom(ws.roomId, roomRule(command, suggestions, suppressAlwaysAllowRule))
      if (result.behavior === 'allow') return { behavior: 'allow', updatedInput: input, updatedPermissions: result.always && !command ? suggestions : undefined }
      // Answers go back in the tool's own `answers` field, one per question. A text-only answer fills a lone question.
      // With several, the tool's result would drop the unanswered ones without a word, so a denial says what happened.
      if (result.behavior === 'answer') {
        const given = result.answers && Object.keys(result.answers).length ? result.answers : undefined
        const answers = given ?? (questions?.length === 1 ? { [questions[0].question]: result.text } : undefined)
        if (isQuestion && answers) return { behavior: 'allow', updatedInput: { ...input, answers } }
        if (questions && questions.length > 1) return { behavior: 'deny', message: `The user saw and answered only your first question, "${questions[0].question}": ${result.text}. Ask the other ${questions.length - 1} again.` }
        return { behavior: 'deny', message: `The user answered: ${result.text}` }
      }
      return { behavior: 'deny', message: result.message ?? 'Denied in Kernel.' }
    }
  }

  private setRunning(chat: Chat, ws: Workspace, live: Live, running: boolean) {
    if (live.running === running) return
    live.running = running
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
    for (const l of next) this.limits.set(l.type, mergeLimit(this.limits.get(l.type), { ...l, model: l.model ?? WINDOW_MODEL[l.type] }, Date.now()))
    this.pushLimits()
  }

  private pushLimits() {
    const limits = [...this.limits.values()]
    bus.push({ type: 'usage', limits })
    this.d.onLimits?.(limits)
    // A model's own limit lifting pauses and resumes no room, so its chats carry on from here.
    this.carryOn()
  }

  private clearRetry(chatId: string, live: Live) {
    if (!live.retrying) return
    live.retrying = false
    bus.push({ type: 'retry', chatId, retry: null })
  }

  /** Context window use from Claude Code's own /context numbers, saved on the chat for the composer and the banner. */
  private async refreshContext(chatId: string, live: Live) {
    const ask = (live.query as Partial<Query>).getContextUsage
    if (typeof ask !== 'function') return
    try {
      const usage = await withTimeout(ask.call(live.query), 10_000)
      const context = Math.max(0, Math.round(usage.percentage))
      const chat = this.d.store.chat(chatId)
      if (!chat) return
      // Deferred tool schemas sit outside the window, so they are not part of the breakdown.
      const contextUsage: Chat['contextUsage'] = typeof usage.totalTokens === 'number' && typeof usage.maxTokens === 'number'
        ? { used: usage.totalTokens, max: usage.maxTokens, rows: (usage.categories ?? []).flatMap(({ name, tokens, kind }) => (kind === 'deferred' ? [] : [{ name, tokens, kind }])) }
        : undefined
      if (chat.context === context && JSON.stringify(chat.contextUsage) === JSON.stringify(contextUsage)) return
      const next = { ...chat, context, contextUsage }
      this.d.store.saveChat(next)
      bus.push({ type: 'chat', chat: next })
    } catch { /* the composer keeps the last number */ }
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

  /**
   * A subagent's messages carry the model it runs on. The first one names its Agent row, which is saved again so the
   * name survives a restart. A row that is already done keeps its status. With no message and no `model` in the call,
   * the row stays "Agent": the model is never guessed.
   */
  private subagentModel(chat: Chat, live: Live, toolUseId: string, model: string | undefined) {
    const row = live.toolItems.get(toolUseId)
    // "<synthetic>" marks the CLI's own messages, which no model wrote.
    if (!row || !model || model.startsWith('<') || !SUBAGENT_TOOLS.has(row.name) || live.agentModels.has(toolUseId)) return
    live.agentModels.add(toolUseId)
    const named = { ...row, label: `${row.label} · ${modelName(model)}` }
    live.toolItems.set(toolUseId, named)
    this.item(chat, named)
  }

  /**
   * Where a new plan-mode plan in this chat is saved (D-092). After "Request changes" the revision overwrites the last
   * plan's file. Once a plan here was approved, the next one gets a file of its own.
   */
  private lastPlanFile(chat: Chat, ws: Workspace): string | undefined {
    const last = this.d.store.approvals({ roomId: ws.roomId }).find((a) => a.chatId === chat.id && a.kind === 'plan')
    return last && last.status !== 'allowed' ? last.planFile : undefined
  }

  /** Put an approval card in the chat's transcript, so it stays there after it is answered and across restarts. */
  placeApproval(chatId: string, approvalId: string) {
    this.item(this.mustChat(chatId), { kind: 'approval', id: `approval-${approvalId}`, ts: Date.now(), approvalId })
  }

  private mustChat(id: string) { const c = this.d.store.chat(id); if (!c) throw new Error(`Unknown chat ${id}`); return c }
  private mustWorkspace(id: string) { const w = this.d.store.workspace(id); if (!w) throw new Error(`Unknown workspace ${id}`); return w }
}

/** Turn composer parts into one SDK user message. Pasted text is inlined, images become image blocks. */
export function toUserMessage(parts: ChatPart[]): SDKUserMessage {
  const content: any[] = []
  // A skill chip is a slash command, and Claude Code only reads one at the start of a text block, so the text after it joins it.
  let lead = ''
  const text = (t: string) => { content.push({ type: 'text', text: [lead, t].filter(Boolean).join(' ') }); lead = '' }
  for (const p of parts) {
    if (p.type === 'text' && p.text.trim()) text(p.text)
    else if (p.type === 'skill') { if (lead) text(''); lead = `/${p.name}` }
    else if (p.type === 'file') text(p.text ? `<pasted name="${p.name}">\n${p.text}\n</pasted>` : `@${p.path ?? p.name}`)
    else if (p.type === 'issue' || p.type === 'workspace') text(linkText(p))
    else if (p.type === 'image' && p.dataUrl) {
      const m = IMAGE_DATA_URL.exec(p.dataUrl)
      if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
    }
  }
  if (lead) text('')
  return { type: 'user', message: { role: 'user', content: content.length ? content : [{ type: 'text', text: '' }] }, parent_tool_use_id: null } as SDKUserMessage
}

/** The commands the / menu offers: Claude Code's own, without its internal ones (named with a leading underscore). */
export function builtinCommands(list: SlashCommand[]): BuiltinCommand[] {
  return list.filter((c) => c.builtin && !c.name.startsWith('_')).map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint ?? '', aliases: c.aliases?.length ? c.aliases : undefined }))
}

/** Every question of an AskUserQuestion call, with what the card needs from each. */
function askedQuestions(input: Record<string, unknown>): AskedQuestion[] {
  const list = Array.isArray(input.questions) ? input.questions : []
  return list.filter((q: any) => q && typeof q.question === 'string').map((q: any) => ({
    question: q.question,
    ...(typeof q.header === 'string' ? { header: q.header } : {}),
    options: (Array.isArray(q.options) ? q.options : []).map((o: any) => ({
      label: String(o?.label ?? o),
      ...(typeof o?.description === 'string' ? { description: o.description } : {})
    })),
    ...(typeof q.multiSelect === 'boolean' ? { multiSelect: q.multiSelect } : {})
  }))
}

/** The tool that starts a subagent. Task is its old name. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

/** "Haiku 4.5" for a model id or alias, matched the way the team screens match (sameModel). An unknown model stays as it is. */
function modelName(model: string): string {
  const m = model.toLowerCase()
  return MODELS.find(({ id }) => m === id || m === id.split('-')[1] || id.includes(`-${m}-`))?.label ?? model
}

/** How much of a tool's output, and of each string in its input, a chat row keeps, so a big Write or log can't bloat chat_items. */
const TOOL_TEXT_MAX = 20_000

/** The tool's input for its row, with every string longer than TOOL_TEXT_MAX clipped, nested ones too. */
function clipInput(input: unknown): Record<string, unknown> | undefined {
  const clip = (v: unknown): unknown =>
    typeof v === 'string' ? v.slice(0, TOOL_TEXT_MAX)
      : Array.isArray(v) ? v.map(clip)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]))
          : v
  return input && typeof input === 'object' && !Array.isArray(input) ? clip(input) as Record<string, unknown> : undefined
}

function toolDetail(name: string, input: any): string {
  if (name === 'Bash') return String(input?.command ?? '').split('\n')[0]
  if (SUBAGENT_TOOLS.has(name) && input?.description) return String(input.description)
  if (input?.file_path) return String(input.file_path)
  if (input?.pattern) return String(input.pattern)
  return JSON.stringify(input ?? {}).slice(0, 120)
}

function agentPrompt(agent: AgentDef | undefined, ws: Workspace, rule?: string): string {
  const where = ws.mode === 'worktree'
    ? `You are working in a git worktree at ${ws.path} on branch ${ws.branch}, created from ${ws.baseRef}. Stay inside it.`
    : `You are working directly in the main checkout at ${ws.path} on ${ws.branch}. Some files already had changes before you started; never commit those unless asked.`
  const port = `If you start a dev server, use port ${ws.port} ($KERNEL_PORT).`
  return [agent?.prompt, agent?.lead && LEAD_RULE, rule, where, port].filter(Boolean).join('\n\n')
}

/**
 * In-process hooks. Every event feeds the room log the same way the installed hooks do for outside sessions.
 * A Bash guard applies Kernel's Never allow and Always ask lists on top of the user's own Claude Code settings.
 */
function kernelHooks(ctx: { roomId: string; workspaceId: string; agentId?: string }, commands: Map<string, string>, verdict: (command: string) => BashVerdict, held: () => Promise<void> | undefined, networkAllowed: () => boolean = () => true, handoff?: LeadHandoff): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const report: HookCallback = async (input) => {
    const a = toActivity(input as HookPayload, ctx)
    if (a) bus.activity(a)
    return {}
  }
  const guard: HookCallback = async (input) => {
    const { tool_use_id, tool_input } = input as PreToolUseHookInput
    const command = String((tool_input as any)?.command ?? '')
    commands.set(tool_use_id, command)
    const v = verdict(command)
    if (v === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Kernel blocks "${command}" in every room.` } }
    if (v === 'ask') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'On the Always ask list in Kernel.' } }
    return {}
  }
  // A paused room's agents wait here, so they stop at the next tool call and not in the middle of one.
  const hold: HookCallback = async (_input, _id, { signal }) => {
    const open = held()
    // A Stop ends the wait too, so no promise is left pending. A Resume takes the abort listener off again.
    if (open && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => { signal.removeEventListener('abort', done); resolve() }
        signal.addEventListener('abort', done, { once: true })
        void open.then(done)
      })
    }
    return {}
  }
  const events: HookEvent[] = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle']
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = Object.fromEntries(events.map((e) => [e, [{ hooks: [report] }]]))
  const web: HookCallback = async () => (networkAllowed() ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NETWORK_OFF } })
  hooks.PreToolUse!.push({ hooks: [hold], timeout: HOLD_TIMEOUT_SEC }, { matcher: 'Bash', hooks: [guard] }, { matcher: 'WebFetch|WebSearch', hooks: [web] })
  if (handoff) {
    // The approval reaches the Lead as "hand it off now", and a Stop before any workspace exists gets one reminder.
    const afterPlan: HookCallback = async () => { const t = handoff.afterPlan(); return t ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: t } } : {} }
    const atStop: HookCallback = async () => { const t = handoff.atStop(); return t ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: t } } : {} }
    hooks.PostToolUse!.push({ matcher: 'ExitPlanMode', hooks: [afterPlan] })
    hooks.Stop!.push({ hooks: [atStop] })
  }
  return hooks
}

/** A Lead's hand-off hooks: context right after an approved ExitPlanMode, and the Stop reminder. Each returns the text to send, or nothing. */
interface LeadHandoff { afterPlan: () => string | undefined; atStop: () => string | undefined }

/** What Restart session sends, after any messages held for the chat. */
export const RESTART_NUDGE = 'Your session ended unexpectedly. Check the worktree and pick up where you left off.'

/** Statuses a pause leaves showing: the user still has to act on them. */
export const PAUSE_KEEPS = new Set<AgentStatus>(['needs', 'blocked', 'offline'])

/** What Kernel sends a chat a usage limit stopped, once the limit lifts. */
export const LIMIT_LIFTED = 'The usage limit that stopped you no longer applies. Pick up where you left off.'

/** Kernel's restart and limit nudges, which carry on a turn rather than start one. */
export const isNudge = (parts: ChatPart[]) => parts.length === 1 && parts[0].type === 'text' && (parts[0].text === RESTART_NUDGE || parts[0].text === LIMIT_LIFTED)

/** How long a paused room's tool call may wait. The CLI gives a callback hook 600 seconds unless told otherwise, and a timed-out PreToolUse hook lets the call go. In seconds. */
export const HOLD_TIMEOUT_SEC = 7 * 24 * 3600

/** Hooks whose exit code 2 stops the agent from going on, which the floor shows as blocked. */
const BLOCKING_HOOKS = new Set(['TaskCreated', 'TaskCompleted', 'TeammateIdle', 'Stop', 'PreToolUse'])

export type BashVerdict = 'deny' | 'allow' | 'ask' | undefined

/**
 * Kernel's say on one Bash command: Never allow, then the room's Always allow rules, then Always ask.
 * Undefined leaves it to Claude Code's own settings, so the user's allow list still covers everyday commands.
 */
export function bashVerdict(command: string, p: { neverAllow: string[]; alwaysAsk: string[]; protectedBranches?: string[]; network?: boolean }, roomAllow: string[]): BashVerdict {
  if (matchesRule(command, p.neverAllow) || pushesTo(command, p.protectedBranches ?? []) || (p.network === false && usesNetwork(command))) return 'deny'
  if (roomAllow.some((r) => matchesRoomRule(command, r))) return 'allow'
  if (matchesRule(command, p.alwaysAsk)) return 'ask'
  return undefined
}

/** The subcommand of a git call, skipping options such as `-C dir`. Returns its index in `t`, or -1. */
function gitSub(t: string[], sub: string): number {
  const g = t.indexOf('git')
  if (g < 0) return -1
  let j = g + 1
  while (j < t.length && t[j].startsWith('-')) j += ['-C', '-c', '--git-dir', '--work-tree'].includes(t[j]) ? 2 : 1
  return t[j] === sub ? j : -1
}

/** A `git push` that names a protected branch (`origin main`, `origin HEAD:main`, `origin HEAD:refs/heads/main`, `git -C dir push ...`). A bare `git push` names none, so it is left alone. */
export function pushesTo(command: string, branches: string[]): boolean {
  if (!branches.length) return false
  return command.split(/&&|\|\||[;|\n]/).some((part) => {
    const t = part.trim().split(/\s+/)
    const at = gitSub(t, 'push')
    if (at < 0) return false
    return t.slice(at + 1).filter((w) => !w.startsWith('-')).some((w) => branches.includes((w.replace(/^\+/, '').split(':').pop() ?? '').replace(/^refs\/heads\//, '')))
  })
}

export const NETWORK_OFF = 'Network access is off in Kernel (Settings, Permissions).'
const NET_PROGRAMS = /^(?:\w+=\S+\s+)*(?:sudo\s+)?(?:curl|wget|nc|ncat|ssh|scp|rsync|ftp|sftp|telnet|gh)\b/
const NET_PACKAGE = /^(?:\w+=\S+\s+)*(?:npm|pnpm|yarn|bun|pip|pip3|brew)\s+(?:install|i|add|update|upgrade|publish)\b/
const NET_GIT = ['push', 'pull', 'fetch', 'clone', 'ls-remote']

/** Commands that reach the network: downloads, remote shells, package installs and git calls to a remote. Matched per command in a chain, so it is a guard for obvious cases, not a sandbox. */
export function usesNetwork(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some((part) => {
    const c = part.trim()
    if (NET_PROGRAMS.test(c) || NET_PACKAGE.test(c)) return true
    const t = c.split(/\s+/)
    return NET_GIT.some((sub) => gitSub(t, sub) >= 0)
  })
}

/**
 * Room rules use Claude Code's Bash rule shape: `prefix:*` covers the prefix with any arguments, otherwise the exact command.
 * A prefix rule never covers a chained command, so `npm run build:*` can't wave through `npm run build && pnpm db:reset`.
 */
export function matchesRoomRule(command: string, rule: string): boolean {
  const c = command.trim()
  if (!rule.endsWith(':*')) return c === rule.trim()
  const prefix = rule.slice(0, -2).trim()
  return (c === prefix || c.startsWith(prefix + ' ')) && !/[;&|\n`]|\$\(/.test(c)
}

/**
 * The rule "Always allow in this room" saves: Claude Code's own suggestion when it is a single Bash rule and may be saved,
 * else the exact command.
 */
export function roomRule(command: string, suggestions?: PermissionUpdate[], suppressAlwaysAllowRule?: boolean): string {
  const rules = suppressAlwaysAllowRule ? [] : (suggestions ?? []).flatMap((s) => (s.type === 'addRules' && s.behavior === 'allow' ? s.rules : []))
  return rules.length === 1 && rules[0].toolName === 'Bash' && rules[0].ruleContent ? rules[0].ruleContent : command.trim()
}

/** Sessions bill the Claude plan through Claude Code's own login. An API key in Kernel's environment would bill the API instead. */
export function sessionEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>, o: { agentTeams?: boolean } = {}): Record<string, string> {
  const env = { ...base, ...extra } as Record<string, string>
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  // Settings > Models > "Use agent teams" decides for Kernel's own sessions, whatever the user's shell exports (D-027).
  if (o.agentTeams === true) env[AGENT_TEAMS] = '1'
  else if (o.agentTeams === false) delete env[AGENT_TEAMS]
  return env
}

/** Claude Code's switch for agent teams (TaskCreated, TaskCompleted, TeammateIdle, a shared task list). */
export const AGENT_TEAMS = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'

const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const

/** A window update. Status is left out when the source doesn't know it, so an earlier warning isn't cleared. */
export type LimitPatch = Omit<RateLimit, 'status'> & { status?: RateLimit['status'] }

/**
 * rate_limit_event names the window that matters right now, and the CLI also sends `unifiedWindows`
 * (not in sdk.d.ts) with the 5-hour and weekly numbers. Utilization is 0 to 1, resetsAt is epoch seconds.
 */
export function limitsFromEvent(info: SDKRateLimitInfo): LimitPatch[] {
  const windows = (info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined> }).unifiedWindows ?? {}
  const out: LimitPatch[] = []
  for (const type of WINDOWS) {
    const w = windows[type]
    if (w) out.push({ type, utilization: w.utilization, resetsAt: w.resetsAt })
  }
  if (info.rateLimitType) {
    const named = defined({ type: info.rateLimitType, status: info.status, utilization: info.utilization, resetsAt: info.resetsAt })
    const i = out.findIndex((l) => l.type === info.rateLimitType)
    if (i >= 0) out[i] = { ...out[i], ...named }; else out.push(named)
  }
  return out
}

/**
 * The experimental usage call reports utilization 0 to 100 and ISO reset times. Converted to the rate_limit_event units.
 * Fable's own weekly window comes in `model_scoped` and is the window rate_limit_event calls `seven_day_overage_included`.
 */
export function limitsFromUsage(res: SDKControlGetUsageResponse): LimitPatch[] {
  const out: LimitPatch[] = []
  const add = (type: LimitPatch['type'], w: { utilization: number | null; resets_at: string | null } | null | undefined) => {
    if (w && w.utilization !== null) out.push({ type, utilization: w.utilization / 100, resetsAt: w.resets_at ? Math.round(Date.parse(w.resets_at) / 1000) : undefined })
  }
  for (const type of WINDOWS) add(type, res.rate_limits?.[type])
  add('seven_day_overage_included', res.rate_limits?.model_scoped?.find((m) => /fable/i.test(m.display_name)))
  return out
}

/** Below this, a reading of a rejected window means it lifted early (a reset on claude.ai, a bigger plan). Near 100% it may be rounding, so the rejection stands. */
const LIFTED_UNDER = 0.95

/**
 * A patch without a status keeps the stored one, unless that window has since reset or the reading shows clear room again.
 * A new window resets at least a minute later: reset times read back from ISO strings can be a second off.
 */
export function mergeLimit(prev: RateLimit | undefined, patch: LimitPatch, now: number): RateLimit {
  const reset = prev?.resetsAt !== undefined && (prev.resetsAt * 1000 <= now || (patch.resetsAt !== undefined && patch.resetsAt > prev.resetsAt + 60))
  const room = prev?.status === 'rejected' && patch.status === undefined && patch.utilization !== undefined && patch.utilization < Math.min(prev.utilization ?? 1, LIFTED_UNDER)
  return { ...prev, status: reset || room || !prev ? 'allowed' : prev.status, ...defined(patch) }
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
