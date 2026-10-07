import { randomUUID } from 'node:crypto'
import { query, type CanUseTool, type HookCallback, type HookCallbackMatcher, type HookEvent, type Options, type PermissionResult, type PermissionUpdate, type PreToolUseHookInput, type Query, type SDKControlGetUsageResponse, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, AgentStatus, Chat, ChatItem, ChatPart, QueuedMessage, RateLimit, Workspace } from '@shared/types'
import type { HookPayload } from '@shared/hookSchemas'
import type { Store } from '../db'
import { bus } from '../bus'
import { describeTool, matchesRule, needsUser, type Approvals } from './approvals'
import { toActivity } from './hookServer'
import type { AppSettings } from './settings'

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
  /** A hook refused a step and the agent has not moved on yet. */
  blocked?: boolean
  /** Set by sendNow: the interrupted turn is followed by the queue. A plain Stop is not. */
  sendNext?: boolean
  toolItems: Map<string, ChatItem & { kind: 'tool' }>
  /** Bash commands by tool use id, as the model wrote them. Other hooks may rewrite the input canUseTool sees. */
  commands: Map<string, string>
}

export interface SessionDeps {
  store: Store
  approvals: Approvals
  settings: () => AppSettings
  agentFor: (ws: Workspace) => AgentDef | undefined
  /** In-process MCP servers this agent may use (Kernel's own tools for the lead). */
  mcpFor: (ws: Workspace, agent: AgentDef | undefined, chat: Chat) => Options['mcpServers']
  /** Bash rules CJ allowed for the whole room. */
  roomAllow: (roomId: string) => string[]
  allowInRoom: (roomId: string, rule: string) => void
  onTurnDone?: (ws: Workspace, chat: Chat) => void
}

export class Sessions {
  private live = new Map<string, Live>()
  private queues = new Map<string, QueuedMessage[]>()
  private managedIds = new Set<string>()
  private limits = new Map<string, RateLimit>()
  private billing = new Map<string, string>()
  /** Rooms CJ (or a limit) paused. Their agents finish the step they are on, then wait at the next tool call. */
  private paused = new Map<string, { open: Promise<void>; release: () => void }>()
  constructor(private d: SessionDeps) {}

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
  }

  /** Let the room's agents go on and send what was held while it was paused. */
  resume(roomId: string) {
    const gate = this.paused.get(roomId)
    if (!gate) return
    this.paused.delete(roomId)
    gate.release()
    for (const ws of this.d.store.workspaces(roomId)) for (const c of this.d.store.chats(ws.id)) if (!this.live.get(c.id)?.running) this.drain(c.id)
  }

  private pausedChat(chat: Chat) {
    const ws = this.d.store.workspace(chat.workspaceId)
    return !!ws && this.paused.has(ws.roomId)
  }

  /** Session ids started by Kernel. The hook server ignores these because in-process hooks already report them. */
  isManaged(sessionId: string) { return this.managedIds.has(sessionId) }
  isRunning(chatId: string) { return this.live.get(chatId)?.running ?? false }
  /** apiKeySource from the chat's init message. 'none' means the Claude plan pays. */
  billingOf(chatId: string) { return this.billing.get(chatId) }

  /**
   * 5-hour and weekly windows, fetched only when asked. A live session answers the experimental usage call;
   * without one, or when the call fails, the last rate_limit_event numbers stand.
   */
  async usage(): Promise<RateLimit[]> {
    const live = [...this.live.values()].find((l) => !l.abort.signal.aborted)
    const ask = live?.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (live && typeof ask === 'function') {
      try { this.mergeLimits(limitsFromUsage(await withTimeout(ask.call(live.query, { skipBehaviors: true }), 10_000))) } catch { /* keep rate_limit_event data */ }
    }
    return [...this.limits.values()]
  }

  /**
   * Starts a turn, or holds the message when one is running. A held message shows in the composer
   * (edit or remove it until it goes) and is sent, in order, when the turn ends.
   */
  async send(chatId: string, parts: ChatPart[]): Promise<{ queued: boolean }> {
    const chat = this.mustChat(chatId)
    if (this.live.get(chatId)?.running || this.pausedChat(chat)) {
      this.setQueue(chatId, [...this.queued(chatId), { id: randomUUID(), chatId, parts, ts: Date.now() }])
      return { queued: true }
    }
    this.dispatch(chat, parts)
    return { queued: false }
  }

  queued(chatId: string): QueuedMessage[] { return this.queues.get(chatId) ?? [] }

  unqueue(chatId: string, id: string): QueuedMessage[] {
    return this.setQueue(chatId, this.queued(chatId).filter((q) => q.id !== id))
  }

  /** Move a queued message to the front and stop the running turn, so it goes out as soon as that turn ends. */
  async sendNow(chatId: string, id: string): Promise<QueuedMessage[]> {
    const pick = this.queued(chatId).find((q) => q.id === id)
    if (!pick) return this.queued(chatId)
    this.setQueue(chatId, [pick, ...this.queued(chatId).filter((q) => q.id !== id)])
    const live = this.live.get(chatId)
    if (live?.running) { live.sendNext = true; await this.interrupt(chatId, true) }
    else this.drain(chatId)
    return this.queued(chatId)
  }

  /** Send the same message again: the user message before the given reply. */
  async retry(chatId: string, itemId: string): Promise<void> {
    const items = this.d.store.items(chatId)
    const at = items.findIndex((i) => i.id === itemId)
    if (at < 0) throw new Error('That message is no longer in this chat.')
    const user = items.slice(0, at).reverse().find((i) => i.kind === 'user')
    if (!user || user.kind !== 'user') throw new Error('There is no message to send again.')
    await this.send(chatId, user.parts)
  }

  private dispatch(chat: Chat, parts: ChatPart[]) {
    const ws = this.mustWorkspace(chat.workspaceId)
    this.item(chat, { kind: 'user', id: randomUUID(), ts: Date.now(), parts })
    const live = this.live.get(chat.id) ?? this.start(chat, ws)
    live.input.push(toUserMessage(parts))
    this.setRunning(chat, ws, live, true)
  }

  /** Send the oldest held message. The next one goes when this turn ends. */
  private drain(chatId: string) {
    const [next, ...rest] = this.queued(chatId)
    const chat = this.d.store.chat(chatId)
    if (!next || !chat || this.pausedChat(chat)) return
    this.setQueue(chatId, rest)
    this.dispatch(chat, next.parts)
  }

  private setQueue(chatId: string, queue: QueuedMessage[]): QueuedMessage[] {
    if (queue.length) this.queues.set(chatId, queue)
    else this.queues.delete(chatId)
    bus.push({ type: 'chat.queue', chatId, queue })
    return queue
  }

  /** The turn's own result message ends it. Queued follow-ups still run afterwards, as in Claude Code. */
  async interrupt(chatId: string, sendNext = false) {
    const live = this.live.get(chatId)
    if (!live?.running) return
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
      if (patch.plan !== undefined) await live.query.setPermissionMode(patch.plan ? 'plan' : this.baseMode()).catch(() => undefined)
      // Effort applies from the next session start; the SDK fixes it per process.
    }
    return chat
  }

  stop(chatId: string) {
    const live = this.live.get(chatId)
    if (!live) return
    live.input.close()
    live.abort.abort()
    this.live.delete(chatId)
    if (this.queued(chatId).length) this.setQueue(chatId, [])
  }

  /** Start a new session for a chat whose session ended, resuming its conversation with a nudge to carry on. */
  async restart(chatId: string): Promise<void> {
    this.mustChat(chatId)
    this.stop(chatId)
    await this.send(chatId, [{ type: 'text', text: 'Your session ended unexpectedly. Check the worktree and pick up where you left off.' }])
  }

  stopWorkspace(workspaceId: string) { for (const c of this.d.store.chats(workspaceId)) this.stop(c.id) }
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
      systemPrompt: { type: 'preset', preset: 'claude_code', append: agentPrompt(agent, ws) },
      mcpServers: this.d.mcpFor(ws, agent, chat),
      hooks: kernelHooks(ctx, commands, (command) => bashVerdict(command, this.d.settings().permissions, this.d.roomAllow(ws.roomId)), () => this.paused.get(ws.roomId)?.open),
      includeHookEvents: true,
      ...(chat.sessionId ? { resume: chat.sessionId } : { sessionId }),
      abortController: abort,
      env: sessionEnv(process.env, { KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE_ID: ws.id })
    }
    const q = query({ prompt: input, options })
    const live: Live = { query: q, input, abort, running: false, interrupted: false, toolItems: new Map(), commands }
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
      if (this.live.get(chatId) === live) this.live.delete(chatId)
      const chat = this.d.store.chat(chatId)
      if (chat && !replaced) this.setRunning(chat, ws, live, false)
      if (chat && !replaced && ended !== null) this.offline(ws, ended)
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
        if (msg.subtype === 'hook_response' && msg.exit_code === 2 && BLOCKING_HOOKS.has(msg.hook_event)) this.blocked(ws, live, msg.hook_event, msg.stderr || msg.output || msg.stdout)
        return
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) return // subagent chatter stays inside the tool row
        if (live.blocked) { live.blocked = false; this.setStatus(ws, this.d.agentFor(ws), chat.plan ? 'planning' : 'working') }
        msg.message.content.forEach((block: any, i: number) => {
          const id = `${msg.uuid}:${i}`
          if (block.type === 'text' && block.text?.trim()) this.item(chat, { kind: 'text', id, ts: now, text: block.text })
          else if (block.type === 'thinking' && block.thinking?.trim()) this.item(chat, { kind: 'thinking', id, ts: now, text: block.thinking })
          else if (block.type === 'tool_use') {
            const d = describeTool(block.name, block.input)
            const item: ChatItem & { kind: 'tool' } = { kind: 'tool', id, ts: now, toolUseId: block.id, name: block.name, label: d.title, detail: toolDetail(block.name, block.input), status: 'running' }
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
          if (!item) continue
          const output = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c.text ?? '').join('\n')
          const done = { ...item, status: block.is_error ? 'failed' : 'done', output: output.slice(0, 4000), ts: item.ts } as ChatItem & { kind: 'tool' }
          live.toolItems.set(block.tool_use_id, done)
          this.item(chat, done)
        }
        return
      }
      case 'result': {
        const ok = msg.subtype === 'success'
        // An interrupted turn ends with error_during_execution; the interrupted row already says what happened.
        if (ok || !live.interrupted) this.item(chat, { kind: 'result', id: msg.uuid, ts: now, durationMs: msg.duration_ms, ok, error: ok ? undefined : msg.subtype })
        const stopped = live.interrupted && !live.sendNext
        live.interrupted = false
        live.sendNext = false
        live.blocked = false
        this.setRunning(chat, ws, live, false)
        this.d.onTurnDone?.(ws, chat)
        // Stop means stop: held messages are dropped, not sent. Send now keeps them.
        if (stopped) this.setQueue(chatId, [])
        else this.drain(chatId)
        return
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info
        this.mergeLimits(limitsFromEvent(info))
        if (info.status === 'rejected' && info.rateLimitType) bus.activity({ kind: 'limit', roomId: ws.roomId, workspaceId: ws.id, text: `hit the ${info.rateLimitType.replace(/_/g, ' ')} limit`, data: { resetsAt: info.resetsAt } })
        return
      }
      default: return
    }
  }

  /**
   * Called for whatever Claude Code would prompt for, including Bash the PreToolUse hook marked Always ask.
   * Order: Never allow, the room's Always allow rules, Always ask, Bypass in worktrees, then CJ decides.
   */
  private canUseTool(chat: Chat, ws: Workspace, agent: AgentDef | undefined, commands: Map<string, string>): CanUseTool {
    return async (toolName, input, { signal, suggestions, suppressAlwaysAllowRule, toolUseID }): Promise<PermissionResult> => {
      const p = this.d.settings().permissions
      if (toolName.startsWith('mcp__kernel__')) return { behavior: 'allow', updatedInput: input }
      const command = toolName === 'Bash' ? commands.get(toolUseID) ?? String((input as any).command ?? '') : ''
      const verdict = command ? bashVerdict(command, p, this.d.roomAllow(ws.roomId)) : undefined
      if (verdict === 'deny') return { behavior: 'deny', message: `Kernel blocks "${command}" in every room.` }
      if (verdict === 'allow') return { behavior: 'allow', updatedInput: input }
      if (verdict !== 'ask' && !needsUser(toolName) && p.mode === 'bypassInWorktrees' && ws.mode === 'worktree') return { behavior: 'allow', updatedInput: input }

      const isQuestion = toolName === 'AskUserQuestion'
      const shown = command ? { ...input, command } : input
      const d = describeTool(toolName, shown)
      const options = isQuestion ? ((input as any).questions?.[0]?.options ?? []).map((o: any) => String(o.label ?? o)) : undefined
      this.setStatus(ws, agent, 'needs', d.title)
      const isPlan = toolName === 'ExitPlanMode'
      const { approval, decision } = this.d.approvals.request({
        kind: isQuestion ? 'question' : isPlan ? 'plan' : 'tool', source: 'sdk', roomId: ws.roomId, workspaceId: ws.id, chatId: chat.id, agentId: agent?.id,
        toolName, input: shown, title: isQuestion ? String((input as any).questions?.[0]?.question ?? 'Question') : isPlan ? `Plan for ${ws.name}` : d.title,
        detail: isPlan ? String((input as any).plan ?? '') : d.detail, options
      }, { signal })
      this.placeApproval(chat.id, approval.id)
      const result = await decision
      this.setStatus(ws, agent, 'working')
      if (!result) return { behavior: 'deny', message: 'No decision was made in time.' }
      // Once the plan is approved the chat leaves plan mode, so a restart does not put it back.
      if (isPlan && result.behavior === 'allow') await this.configure(chat.id, { plan: false }).catch(() => undefined)
      if (result.behavior === 'allow' && result.always && command) this.d.allowInRoom(ws.roomId, roomRule(command, suggestions, suppressAlwaysAllowRule))
      if (result.behavior === 'allow') return { behavior: 'allow', updatedInput: input, updatedPermissions: result.always && !command ? suggestions : undefined }
      // Answers to questions travel back as the denial message, which the model reads as the user's reply.
      if (result.behavior === 'answer') return { behavior: 'deny', message: `The user answered: ${result.text}` }
      return { behavior: 'deny', message: result.message ?? 'Denied in Kernel.' }
    }
  }

  private setRunning(chat: Chat, ws: Workspace, live: Live, running: boolean) {
    if (live.running === running) return
    live.running = running
    bus.push({ type: 'chat.running', chatId: chat.id, running })
    this.setStatus(ws, this.d.agentFor(ws), running ? (chat.plan ? 'planning' : 'working') : 'idle')
  }

  private mergeLimits(next: LimitPatch[]) {
    if (!next.length) return
    for (const l of next) this.limits.set(l.type, mergeLimit(this.limits.get(l.type), l, Date.now()))
    bus.push({ type: 'usage', limits: [...this.limits.values()] })
  }

  /** A paused room shows everyone as paused, except an agent waiting on CJ. */
  private setStatus(ws: Workspace, agent: AgentDef | undefined, status: AgentStatus, activity?: string) {
    const shown = this.paused.has(ws.roomId) && status !== 'needs' ? 'paused' : status
    if (agent) bus.push({ type: 'agent.status', roomId: ws.roomId, agentId: agent.id, status: shown, activity })
  }

  /** The session ended without being stopped: the agent goes offline and the logs say where and why. */
  private offline(ws: Workspace, reason: string) {
    const detail = `Claude Code exited in ${ws.name}${reason ? ` (${reason.slice(0, 120)})` : ''}. The worktree and chat are saved.`
    this.setStatus(ws, this.d.agentFor(ws), 'offline', `Session ended in ${ws.name}`)
    bus.activity({ kind: 'session.end', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: 'went offline in', object: ws.name, warn: true, data: { detail, crashed: true } })
  }

  /** A hook exited with code 2: it refused the step. The agent shows as blocked with the hook's own words. */
  private blocked(ws: Workspace, live: Live, event: string, output: string) {
    live.blocked = true
    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4)
    this.setStatus(ws, this.d.agentFor(ws), 'blocked', `Blocked by the ${event} hook`)
    bus.activity({
      kind: 'agent.status', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: 'was blocked on', object: ws.name, warn: true,
      data: { status: 'blocked', detail: `The ${event} hook refused the last step. Read its output, then fix it or ask the agent to.`, output: lines.length ? lines : undefined }
    })
  }

  private item(chat: Chat, item: ChatItem) {
    this.d.store.saveItem(chat.id, item)
    bus.push({ type: 'chat.item', chatId: chat.id, item })
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
    else if (p.type === 'image' && p.dataUrl) {
      const m = /^data:(image\/[a-z+]+);base64,(.*)$/.exec(p.dataUrl)
      if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
    }
  }
  if (lead) text('')
  return { type: 'user', message: { role: 'user', content: content.length ? content : [{ type: 'text', text: '' }] }, parent_tool_use_id: null } as SDKUserMessage
}

function toolDetail(name: string, input: any): string {
  if (name === 'Bash') return String(input?.command ?? '').split('\n')[0]
  if (input?.file_path) return String(input.file_path)
  if (input?.pattern) return String(input.pattern)
  return JSON.stringify(input ?? {}).slice(0, 120)
}

function agentPrompt(agent: AgentDef | undefined, ws: Workspace): string {
  const where = ws.mode === 'worktree'
    ? `You are working in a git worktree at ${ws.path} on branch ${ws.branch}, created from ${ws.baseRef}. Stay inside it.`
    : `You are working directly in the main checkout at ${ws.path} on ${ws.branch}. Some files already had changes before you started; never commit those unless asked.`
  const port = `If you start a dev server, use port ${ws.port} ($KERNEL_PORT).`
  return [agent?.prompt, where, port].filter(Boolean).join('\n\n')
}

/**
 * In-process hooks. Every event feeds the room log the same way http hooks do for outside sessions.
 * A Bash guard applies Kernel's Never allow and Always ask lists on top of CJ's own Claude Code settings.
 */
function kernelHooks(ctx: { roomId: string; workspaceId: string; agentId?: string }, commands: Map<string, string>, verdict: (command: string) => BashVerdict, held: () => Promise<void> | undefined): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
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
  const hold: HookCallback = async () => { await held(); return {} }
  const events: HookEvent[] = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'TaskCreated', 'TaskCompleted']
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = Object.fromEntries(events.map((e) => [e, [{ hooks: [report] }]]))
  hooks.PreToolUse!.push({ hooks: [hold] }, { matcher: 'Bash', hooks: [guard] })
  return hooks
}

/** Hooks whose exit code 2 stops the agent from going on, which the floor shows as blocked. */
const BLOCKING_HOOKS = new Set(['TaskCreated', 'TaskCompleted', 'TeammateIdle', 'Stop', 'PreToolUse'])

export type BashVerdict = 'deny' | 'allow' | 'ask' | undefined

/**
 * Kernel's say on one Bash command: Never allow, then the room's Always allow rules, then Always ask.
 * Undefined leaves it to Claude Code's own settings, so CJ's allow list still covers everyday commands.
 */
export function bashVerdict(command: string, p: { neverAllow: string[]; alwaysAsk: string[] }, roomAllow: string[]): BashVerdict {
  if (matchesRule(command, p.neverAllow)) return 'deny'
  if (roomAllow.some((r) => matchesRoomRule(command, r))) return 'allow'
  if (matchesRule(command, p.alwaysAsk)) return 'ask'
  return undefined
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
export function sessionEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env = { ...base, ...extra } as Record<string, string>
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

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

/** The experimental usage call reports utilization 0 to 100 and ISO reset times. Converted to the rate_limit_event units. */
export function limitsFromUsage(res: SDKControlGetUsageResponse): LimitPatch[] {
  const out: LimitPatch[] = []
  for (const type of WINDOWS) {
    const w = res.rate_limits?.[type]
    if (!w || w.utilization === null) continue
    out.push({ type, utilization: w.utilization / 100, resetsAt: w.resets_at ? Math.round(Date.parse(w.resets_at) / 1000) : undefined })
  }
  return out
}

/** A patch without a status keeps the stored one, unless that window has since reset. */
export function mergeLimit(prev: RateLimit | undefined, patch: LimitPatch, now: number): RateLimit {
  const reset = prev?.resetsAt !== undefined && (prev.resetsAt * 1000 <= now || (patch.resetsAt !== undefined && patch.resetsAt > prev.resetsAt))
  return { ...prev, status: reset || !prev ? 'allowed' : prev.status, ...defined(patch) }
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
