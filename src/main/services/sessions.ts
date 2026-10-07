import { randomUUID } from 'node:crypto'
import { query, type CanUseTool, type HookCallbackMatcher, type HookEvent, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, AgentStatus, Chat, ChatItem, ChatPart, RateLimit, Workspace } from '@shared/types'
import type { HookPayload } from '@shared/hookSchemas'
import type { Store } from '../db'
import { bus } from '../bus'
import { describeTool, matchesRule, type Approvals } from './approvals'
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

interface Live { query: Query; input: InputQueue<SDKUserMessage>; abort: AbortController; running: boolean; toolItems: Map<string, ChatItem & { kind: 'tool' }> }

export interface SessionDeps {
  store: Store
  approvals: Approvals
  settings: () => AppSettings
  agentFor: (ws: Workspace) => AgentDef | undefined
  /** In-process MCP servers this agent may use (Kernel's own tools for the lead). */
  mcpFor: (ws: Workspace, agent: AgentDef | undefined) => Options['mcpServers']
  onTurnDone?: (ws: Workspace, chat: Chat) => void
}

export class Sessions {
  private live = new Map<string, Live>()
  private managedIds = new Set<string>()
  private limits = new Map<string, RateLimit>()
  constructor(private d: SessionDeps) {}

  /** Session ids started by Kernel. The hook server ignores these because in-process hooks already report them. */
  isManaged(sessionId: string) { return this.managedIds.has(sessionId) }
  isRunning(chatId: string) { return this.live.get(chatId)?.running ?? false }
  usage(): RateLimit[] { return [...this.limits.values()] }

  async send(chatId: string, parts: ChatPart[]): Promise<{ queued: boolean }> {
    const chat = this.mustChat(chatId)
    const ws = this.mustWorkspace(chat.workspaceId)
    this.item(chat, { kind: 'user', id: randomUUID(), ts: Date.now(), parts })
    let live = this.live.get(chatId)
    const queued = !!live?.running
    if (!live) live = this.start(chat, ws)
    live.input.push(toUserMessage(parts))
    this.setRunning(chat, ws, live, true)
    return { queued }
  }

  async interrupt(chatId: string) {
    const live = this.live.get(chatId)
    if (!live) return
    await live.query.interrupt().catch(() => undefined)
    const chat = this.mustChat(chatId)
    this.item(chat, { kind: 'interrupted', id: randomUUID(), ts: Date.now() })
    this.setRunning(chat, this.mustWorkspace(chat.workspaceId), live, false)
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
  }

  stopWorkspace(workspaceId: string) { for (const c of this.d.store.chats(workspaceId)) this.stop(c.id) }
  stopAll() { for (const id of [...this.live.keys()]) this.stop(id) }

  private baseMode(): NonNullable<Options['permissionMode']> { return this.d.settings().permissions.mode === 'ask' ? 'default' : 'acceptEdits' }

  private start(chat: Chat, ws: Workspace): Live {
    const agent = this.d.agentFor(ws)
    const input = new InputQueue<SDKUserMessage>()
    const abort = new AbortController()
    const ctx = { roomId: ws.roomId, workspaceId: ws.id, agentId: agent?.id }
    const options: Options = {
      cwd: ws.path,
      model: chat.model,
      effort: chat.effort,
      permissionMode: chat.plan ? 'plan' : this.baseMode(),
      canUseTool: this.canUseTool(ws, agent),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: agentPrompt(agent, ws) },
      mcpServers: this.d.mcpFor(ws, agent),
      hooks: activityHooks(ctx),
      resume: chat.sessionId,
      abortController: abort,
      env: { ...process.env, KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE_ID: ws.id } as Record<string, string>
    }
    const q = query({ prompt: input, options })
    const live: Live = { query: q, input, abort, running: false, toolItems: new Map() }
    this.live.set(chat.id, live)
    void this.consume(chat.id, ws, live)
    return live
  }

  private async consume(chatId: string, ws: Workspace, live: Live) {
    try {
      for await (const msg of live.query) this.handle(chatId, ws, live, msg)
    } catch (err) {
      if (!live.abort.signal.aborted) this.item(this.mustChat(chatId), { kind: 'note', id: randomUUID(), ts: Date.now(), text: `Session stopped: ${String((err as Error).message ?? err)}` })
    } finally {
      const chat = this.d.store.chat(chatId)
      if (chat) this.setRunning(chat, ws, live, false)
      this.live.delete(chatId)
    }
  }

  private handle(chatId: string, ws: Workspace, live: Live, msg: SDKMessage) {
    let chat = this.mustChat(chatId)
    const now = Date.now()
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init' && 'session_id' in msg) {
          this.managedIds.add(msg.session_id)
          if (chat.sessionId !== msg.session_id) { chat = { ...chat, sessionId: msg.session_id }; this.d.store.saveChat(chat) }
        }
        return
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) return // subagent chatter stays inside the tool row
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
        this.item(chat, { kind: 'result', id: msg.uuid, ts: now, durationMs: msg.duration_ms, ok, error: ok ? undefined : msg.subtype })
        this.setRunning(chat, ws, live, false)
        this.d.onTurnDone?.(ws, chat)
        return
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info
        if (!info.rateLimitType) return
        this.limits.set(info.rateLimitType, { type: info.rateLimitType, status: info.status, utilization: info.utilization, resetsAt: info.resetsAt })
        bus.push({ type: 'usage', limits: this.usage() })
        if (info.status === 'rejected') bus.activity({ kind: 'limit', roomId: ws.roomId, workspaceId: ws.id, text: `hit the ${info.rateLimitType.replace(/_/g, ' ')} limit`, data: { resetsAt: info.resetsAt } })
        return
      }
      default: return
    }
  }

  /** Permission policy from Settings > Permissions, then CJ's decision for everything else. */
  private canUseTool(ws: Workspace, agent: AgentDef | undefined): CanUseTool {
    return async (toolName, input, { signal, suggestions }): Promise<PermissionResult> => {
      const p = this.d.settings().permissions
      if (toolName.startsWith('mcp__kernel__')) return { behavior: 'allow', updatedInput: input }
      const command = toolName === 'Bash' ? String((input as any).command ?? '') : ''
      if (command && matchesRule(command, p.neverAllow)) return { behavior: 'deny', message: `Kernel blocks "${command}" in every room.` }
      const mustAsk = command ? !!matchesRule(command, p.alwaysAsk) : false
      if (!mustAsk && p.mode === 'bypassInWorktrees' && ws.mode === 'worktree') return { behavior: 'allow', updatedInput: input }

      const isQuestion = toolName === 'AskUserQuestion'
      const d = describeTool(toolName, input)
      const options = isQuestion ? ((input as any).questions?.[0]?.options ?? []).map((o: any) => String(o.label ?? o)) : undefined
      this.setStatus(ws, agent, 'needs', d.title)
      const { decision } = this.d.approvals.request({
        kind: isQuestion ? 'question' : 'tool', source: 'sdk', roomId: ws.roomId, workspaceId: ws.id, agentId: agent?.id,
        toolName, input, title: isQuestion ? String((input as any).questions?.[0]?.question ?? 'Question') : d.title, detail: d.detail, options
      }, { signal })
      const result = await decision
      this.setStatus(ws, agent, 'working')
      if (!result) return { behavior: 'deny', message: 'No decision was made in time.' }
      if (result.behavior === 'allow') return { behavior: 'allow', updatedInput: input, updatedPermissions: result.always ? suggestions : undefined }
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

  private setStatus(ws: Workspace, agent: AgentDef | undefined, status: AgentStatus, activity?: string) {
    if (agent) bus.push({ type: 'agent.status', roomId: ws.roomId, agentId: agent.id, status, activity })
  }

  private item(chat: Chat, item: ChatItem) {
    this.d.store.saveItem(chat.id, item)
    bus.push({ type: 'chat.item', chatId: chat.id, item })
  }

  private mustChat(id: string) { const c = this.d.store.chat(id); if (!c) throw new Error(`Unknown chat ${id}`); return c }
  private mustWorkspace(id: string) { const w = this.d.store.workspace(id); if (!w) throw new Error(`Unknown workspace ${id}`); return w }
}

/** Turn composer parts into one SDK user message. Pasted text is inlined, images become image blocks. */
export function toUserMessage(parts: ChatPart[]): SDKUserMessage {
  const content: any[] = []
  for (const p of parts) {
    if (p.type === 'text' && p.text.trim()) content.push({ type: 'text', text: p.text })
    else if (p.type === 'file') content.push({ type: 'text', text: p.text ? `<pasted name="${p.name}">\n${p.text}\n</pasted>` : `@${p.path ?? p.name}` })
    else if (p.type === 'image' && p.dataUrl) {
      const m = /^data:(image\/[a-z+]+);base64,(.*)$/.exec(p.dataUrl)
      if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
    }
  }
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

/** In-process hooks feed the room log the same way http hooks do for outside sessions. */
function activityHooks(ctx: { roomId: string; workspaceId: string; agentId?: string }): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const report = async (input: unknown) => {
    const a = toActivity(input as HookPayload, ctx)
    if (a) bus.activity(a)
    return {}
  }
  const events: HookEvent[] = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'TaskCreated', 'TaskCompleted']
  return Object.fromEntries(events.map((e) => [e, [{ hooks: [report] }]]))
}
