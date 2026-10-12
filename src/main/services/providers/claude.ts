import { randomUUID } from 'node:crypto'
import { query, type CanUseTool, type EffortLevel, type HookCallback, type HookCallbackMatcher, type HookEvent, type McpServerStatus, type Options, type PermissionResult, type PreToolUseHookInput, type Query, type SDKControlGetUsageResponse, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage, type SlashCommand, type SpawnedProcess, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { AskedQuestion, BuiltinCommand, Chat, ChatItem, ChatPart, Effort } from '@shared/types'
import { MODELS } from '@shared/types'
import type { HookPayload } from '@shared/hookSchemas'
import { linkText } from '@shared/links'
import { bus } from '../../bus'
import { describeTool } from '../approvals'
import { toActivity } from '../hookServer'
import { failureOf } from '../health'
import { toolKind, toolPolicy, type ToolPolicy } from '../agentTools'
import { mcpStatus, type McpReport } from '../mcp'
import { IMAGE_DATA_URL } from '../plans'
import { decide, guardVerdict, NETWORK_OFF, rulesOf, saveAlwaysAllow, type Verdict } from '../permissions'
import { askedOption } from './questions'
import { defined, type LimitPatch } from './limits'
import type { Ask, Proc, Runner, RunnerHost } from './types'
import { claudeExecutable, packagedClaude } from './binary'

export { packagedClaude }

// Claude Code through the Agent SDK (KERNEL-406). Moved here from Sessions as it was, behind the Runner seam.

/** What a tool row still marked running says once Kernel opens again, and what a tool a quit stopped says. */
export const TOOL_STOPPED = 'Stopped when Kernel quit'

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

/** What a Claude runner starts with, which Sessions works out for the chat. */
export interface ClaudeStart {
  /** In-process MCP servers this agent may use (Kernel's own tools). */
  mcpServers: Options['mcpServers']
  /** The skills and MCP servers switched off for the room (KERNEL-226). */
  disabled?: { skills: string[]; mcp: string[] }
  /** The agent's prompt with Kernel's rules, appended to Claude Code's own. */
  prompt: string
  /** The workspace's variables, before `sessionEnv` takes the API keys out. */
  env: Record<string, string>
  /** The room's checkout, which a Lead worktree takes its `.claude` settings from. */
  root?: string
  /** The room's `[mcp.aliases]`, which the agent file's tools line reads through (KERNEL-464). */
  aliases?: Record<string, string>
}

/** One chat's Claude Code process through the Agent SDK (KERNEL-406 moved it out of Sessions as it was). */
export class ClaudeRunner implements Runner {
  private readonly input = new InputQueue<SDKUserMessage>()
  private readonly abort = new AbortController()
  private readonly query: Query
  private readonly proc: Proc = { stderr: '' }
  private readonly toolItems = new Map<string, ChatItem & { kind: 'tool' }>()
  /** Agent rows whose label already names the subagent's model, by tool use id. The call's own `model` is final (KERNEL-158). */
  private readonly agentModels = new Set<string>()
  /** Bash commands by tool use id, as the model wrote them. Other hooks may rewrite the input canUseTool sees. */
  private readonly commands = new Map<string, string>()
  /** The session id this process resumed, until its first init shows Claude Code found it (KERNEL-286). */
  private resume?: string

  constructor(private readonly host: RunnerHost, o: ClaudeStart) {
    const chat = host.chat()
    const ws = host.workspace
    const agent = host.agent
    const ctx = { roomId: ws.roomId, workspaceId: ws.id, agentId: agent?.id }
    // Known before the process starts, so the hook server never mistakes this session's first hooks for an outside one.
    const sessionId = chat.sessionId ?? randomUUID()
    host.managed(sessionId)
    // The agent file's tools line and disallowedTools hold, as they do when Claude Code runs the file as a subagent (KERNEL-397, KERNEL-451).
    const tools = toolPolicy(agent?.tools, { disallowed: agent?.disallowedTools, aliases: o.aliases })
    const off = switchedOff(o.disabled, Object.keys(o.mcpServers ?? {}))
    const options: Options = {
      cwd: ws.path,
      // The Lead's worktree takes `.claude` settings, agents, hooks and `.mcp.json` from the room's checkout, as it did when
      // it worked there, and loads each once (KERNEL-348, KERNEL-355).
      ...(ws.lead && ws.mode === 'worktree' && o.root ? { projectConfigRoot: o.root } : {}),
      model: chat.model,
      effort: claudeEffort(chat.effort),
      // Without display: 'summarized' the CLI sends thinking blocks with empty text.
      thinking: { type: 'adaptive', display: 'summarized' },
      permissionMode: chat.plan ? 'plan' : this.baseMode(),
      canUseTool: this.canUseTool(),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: o.prompt },
      mcpServers: o.mcpServers,
      ...(off ? { settings: off } : {}),
      ...(tools?.hidden.length ? { disallowedTools: tools.hidden } : {}),
      hooks: kernelHooks({
        ctx, commands: this.commands, tools,
        verdict: (command) => guardVerdict(command, rulesOf(host)),
        held: () => host.held(),
        networkAllowed: () => host.settings().permissions.network !== false,
        handoff: agent?.lead ? { afterPlan: () => host.handoffAfterPlan(), atStop: () => host.handoffAtStop() } : undefined
      }),
      includeHookEvents: true,
      ...(chat.sessionId ? { resume: chat.sessionId } : { sessionId }),
      abortController: this.abort,
      env: sessionEnv(o.env, {}, { agentTeams: host.settings().models?.agentTeams }),
      pathToClaudeCodeExecutable: claudeExecutable(host.settings().providers?.claude),
      spawnClaudeCodeProcess: (s) => host.spawn(s.command, s.args, { cwd: s.cwd, env: s.env, signal: s.signal }, this.proc) as unknown as SpawnedProcess
    }
    this.query = query({ prompt: this.input, options })
    this.resume = chat.sessionId
  }

  get closed() { return this.abort.signal.aborted }

  /** Starts reading what the process writes. Sessions calls it once the chat's Live holds this runner. */
  start() { void this.consume() }

  push(parts: ChatPart[]) { this.input.push(toUserMessage(parts)) }
  async interrupt() { await this.query.interrupt().catch(() => undefined) }
  async setModel(model: string) { await this.query.setModel(model).catch(() => undefined) }
  async setEffort(effort: Effort) { await this.query.applyFlagSettings({ effortLevel: claudeEffort(effort) }).catch(() => undefined) }
  async setPlan(on: boolean) { await this.query.setPermissionMode(on ? 'plan' : this.baseMode()).catch(() => undefined) }
  async usage() { await readUsage(this.query, (p) => this.host.mergeLimits(p)) }

  close() {
    this.input.close()
    this.abort.abort()
  }

  kill() {
    // The SDK waits about 2 seconds after closing stdin before it kills the process, and Kernel is gone by then. A
    // process left mid-step carries on alone, so it gets SIGTERM now, which also ends the shells its tools started.
    if (this.proc.child && this.proc.child.exitCode === null) this.proc.child.kill('SIGTERM')
  }

  /** Claude Code's own slash commands, from the live session. */
  async commandList(): Promise<BuiltinCommand[]> { return builtinCommands(await withTimeout(this.query.supportedCommands(), 15_000)) }

  /** Context window use from Claude Code's own /context numbers, saved on the chat for the composer and the banner. */
  async context() {
    const ask = (this.query as Partial<Query>).getContextUsage
    if (typeof ask !== 'function') return
    try {
      const usage = await withTimeout(ask.call(this.query), 10_000)
      const context = Math.max(0, Math.round(usage.percentage))
      // Deferred tool schemas sit outside the window, so they are not part of the breakdown.
      const contextUsage: Chat['contextUsage'] = typeof usage.totalTokens === 'number' && typeof usage.maxTokens === 'number'
        ? { used: usage.totalTokens, max: usage.maxTokens, rows: (usage.categories ?? []).flatMap(({ name, tokens, kind }) => (kind === 'deferred' ? [] : [{ name, tokens, kind }])) }
        : undefined
      this.host.setContext(context, contextUsage)
    } catch { /* the composer keeps the last number */ }
  }

  private baseMode(): NonNullable<Options['permissionMode']> { return this.host.settings().permissions.mode === 'default' ? 'default' : 'acceptEdits' }

  private async consume() {
    let ended: string | null = null
    let error = false
    try {
      // A stopped process can still deliver lines it had already written. Once a newer session owns the chat, they are dropped.
      for await (const msg of this.query) if (!this.host.stale()) this.handle(msg)
      // Nobody asked it to stop, so the process went away on its own.
      if (!this.closed) ended = ''
    } catch (err) {
      if (!this.closed) { ended = withStderr(String((err as Error).message ?? err), this.proc.stderr); error = true }
    } finally {
      this.host.ended(ended, { error })
    }
  }

  private handle(msg: SDKMessage) {
    const host = this.host
    const ws = host.workspace
    const now = Date.now()
    switch (msg.type) {
      case 'system': {
        // The CLI sends init at the start of every turn, including queued follow-ups after an interrupt.
        if (msg.subtype === 'init') {
          this.resume = undefined
          // Claude.ai connectors only show up here, so a tools line naming a server the session lacks is caught at init. Each
          // init's statuses keep the room's fresh (KERNEL-464).
          host.sessionStarted(msg.session_id, { billedBy: msg.apiKeySource, mcpServers: mcpReports(msg.mcp_servers ?? []) })
        }
        if (msg.subtype === 'hook_response' && msg.exit_code === 2 && BLOCKING_HOOKS.has(msg.hook_event)) host.blocked(msg.hook_event, msg.stderr || msg.output || msg.stdout)
        // The SDK's level signal for background work, which replaces the whole set. Ambient tasks are housekeeping, not work.
        if (msg.subtype === 'background_tasks_changed') host.setTasks(msg.tasks.filter((t) => !t.ambient).map((t) => t.task_id))
        if (msg.subtype === 'api_retry') {
          const failure = failureOf(msg.error, msg.error_status)
          // A connection error is the network's banner, not the overloaded one.
          if (failure === 'network' || failure === 'auth') host.failed(failure, { notify: true })
          else host.retrying({ attempt: msg.attempt, of: msg.max_retries, nextAt: now + msg.retry_delay_ms })
        }
        if (msg.subtype === 'compact_boundary') void this.context()
        // Most commands answer with an assistant message; some print here instead.
        if (msg.subtype === 'local_command_output' && msg.content.trim()) host.item({ kind: 'text', id: msg.uuid, ts: now, text: msg.content })
        return
      }
      case 'conversation_reset': {
        // /clear (or /reset, /new): Claude Code starts a fresh conversation under a new session id, which the next init
        // saves. The transcript starts over too, as the CLI's screen does. The old conversation stays in Claude Code's own history.
        this.toolItems.clear()
        this.agentModels.clear()
        host.reset(msg.trigger)
        return
      }
      case 'assistant': {
        host.clearRetry()
        const failure = failureOf(msg.error)
        if (failure === 'auth' || failure === 'network') host.failed(failure, { notify: failure === 'auth' })
        if (failure === 'limit') host.limited({ always: true })
        // Only a clean answer counts. `unknown` and `server_error` are what Claude Code sends when its retries run out.
        if (!msg.error) host.reached()
        host.replied()
        // Subagent chatter stays inside the tool row. Only the model it runs on reaches the row's label.
        if (msg.parent_tool_use_id) { this.subagentModel(msg.parent_tool_use_id, msg.message.model); return }
        msg.message.content.forEach((block: any, i: number) => {
          const id = `${msg.uuid}:${i}`
          if (block.type === 'text' && block.text?.trim()) host.item({ kind: 'text', id, ts: now, text: block.text })
          else if (block.type === 'thinking' && block.thinking?.trim()) host.item({ kind: 'thinking', id, ts: now, text: block.thinking })
          else if (block.type === 'tool_use') {
            const d = describeTool(block.name, block.input)
            // A fork ignores `model` and runs on the parent's, so its first message names it instead.
            const model = SUBAGENT_TOOLS.has(block.name) && block.input?.model && block.input.subagent_type !== 'fork' ? String(block.input.model) : undefined
            if (model) this.agentModels.add(block.id)
            const label = model ? `${d.title} · ${modelName(model)}` : d.title
            const item: ChatItem & { kind: 'tool' } = { kind: 'tool', id, ts: now, toolUseId: block.id, name: block.name, label, detail: toolDetail(block.name, block.input), status: 'running', input: clipInput(block.input) }
            this.toolItems.set(block.id, item)
            host.item(item)
          }
        })
        return
      }
      case 'user': {
        const content = (msg.message as any).content
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (block?.type !== 'tool_result') continue
          const item = this.toolItems.get(block.tool_use_id)
          this.commands.delete(block.tool_use_id)
          // A step that went through after a PreToolUse refusal: the agent found its way past it.
          if (item && !block.is_error) host.toolSucceeded()
          if (!item) continue
          const output = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c.text ?? '').join('\n')
          const cut = output.length > TOOL_TEXT_MAX
          const done = (host.quitting
            ? { ...item, status: 'failed', output: TOOL_STOPPED, outputCut: undefined }
            : { ...item, status: block.is_error ? 'failed' : 'done', output: output.slice(0, TOOL_TEXT_MAX), outputCut: cut || undefined, ts: item.ts }) as ChatItem & { kind: 'tool' }
          this.toolItems.set(block.tool_use_id, done)
          host.item(done)
        }
        return
      }
      case 'result': {
        const ok = msg.subtype === 'success'
        // A turn that ended on an API error is `success` with `is_error`, so it never says the API was reached.
        if (ok && !msg.is_error) host.reached()
        if (msg.subtype !== 'success' && this.resume && msg.errors?.includes(`${SESSION_GONE}${this.resume}`) && host.sessionGone()) return
        host.turnEnded({ id: msg.uuid, ok, durationMs: msg.duration_ms, error: ok ? undefined : msg.subtype })
        return
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info
        if (info.status === 'rejected') host.limited()
        host.mergeLimits(limitsFromEvent(info))
        if (info.status === 'rejected' && info.rateLimitType) bus.activity({ kind: 'limit', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: `hit the ${info.rateLimitType.replace(/_/g, ' ')} limit`, data: { resetsAt: info.resetsAt } })
        return
      }
      default: return
    }
  }

  /**
   * Called for whatever Claude Code would prompt for, including Bash the PreToolUse hook marked Always ask. Kernel's rules
   * decide first (`decide`), and what they leave open goes to the user.
   */
  private canUseTool(): CanUseTool {
    const host = this.host
    return async (toolName, input, { signal, suggestions, suppressAlwaysAllowRule, toolUseID }): Promise<PermissionResult> => {
      const command = toolName === 'Bash' ? this.commands.get(toolUseID) ?? String((input as any).command ?? '') : ''
      const step = { tool: toolName, command }
      const verdict = decide(step, rulesOf(host))
      if (verdict?.behavior === 'deny') return { behavior: 'deny', message: verdict.message }
      if (verdict?.behavior === 'allow') return { behavior: 'allow', updatedInput: input }

      const isQuestion = toolName === 'AskUserQuestion'
      const shown = command ? { ...input, command } : input
      const d = describeTool(toolName, shown)
      const questions = isQuestion ? askedQuestions(input) : undefined
      const options = questions?.[0]?.options.map((o) => o.label) ?? (isQuestion ? [] : undefined)
      const result = toolName === 'ExitPlanMode'
        ? await host.requestPlan(String((input as any).plan ?? ''), { signal, toolName, input: shown, activity: d.title })
        : await host.ask({ kind: isQuestion ? 'question' : 'tool', toolName, input: shown, title: isQuestion ? questions?.[0]?.question ?? 'Question' : d.title, detail: d.detail, options, questions, activity: d.title }, { signal })
      if (!result) return { behavior: 'deny', message: NO_DECISION }
      saveAlwaysAllow(host, step, result, { suggestions, suppressAlwaysAllowRule })
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

  /**
   * A subagent's messages carry the model it runs on. The first one names its Agent row, which is saved again so the
   * name survives a restart. A row that is already done keeps its status. With no message and no `model` in the call,
   * the row stays "Agent": the model is never guessed.
   */
  private subagentModel(toolUseId: string, model: string | undefined) {
    const row = this.toolItems.get(toolUseId)
    // "<synthetic>" marks the CLI's own messages, which no model wrote.
    if (!row || !model || model.startsWith('<') || !SUBAGENT_TOOLS.has(row.name) || this.agentModels.has(toolUseId)) return
    this.agentModels.add(toolUseId)
    const named = { ...row, label: `${row.label} · ${modelName(model)}` }
    this.toolItems.set(toolUseId, named)
    this.host.item(named)
  }
}

/** Asks a session for the usage windows. A failed call keeps the rate_limit_event numbers. */
export async function readUsage(q: Query, merge: (p: LimitPatch[]) => void) {
  const ask = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
  if (typeof ask !== 'function') return
  try { merge(limitsFromUsage(await withTimeout(ask.call(q, { skipBehaviors: true }), 10_000))) } catch { /* keep rate_limit_event data */ }
}

/** Claude Code started with no prompt, no settings and no transcript, asked for usage and stopped. It sends no message, so it uses none of the plan. */
export async function probeClaudeUsage(cwd: string, merge: (p: LimitPatch[]) => void) {
  const input = new InputQueue<SDKUserMessage>()
  const abort = new AbortController()
  try {
    const q = query({ prompt: input, options: { cwd, settingSources: [], persistSession: false, abortController: abort, env: sessionEnv(process.env, {}), pathToClaudeCodeExecutable: packagedClaude() } })
    await readUsage(q, merge)
  } catch { /* keep rate_limit_event data */ } finally {
    input.close()
    abort.abort()
  }
}

/** A session's or a probe's MCP servers as reports. A status Kernel doesn't know is left out. */
export function mcpReports(list: { name: string; status: string; source?: string; scope?: string; error?: string }[]): McpReport[] {
  return list.flatMap((s) => {
    const status = mcpStatus(s.status)
    const source = s.source ?? s.scope
    return status ? [{ name: s.name, status, ...(source ? { source } : {}), ...(s.error ? { error: s.error } : {}) }] : []
  })
}

/**
 * Claude Code's MCP servers for a folder, each with its status, as a session there would load them (KERNEL-464). Claude
 * Code starts with the user's settings and no prompt, so it sends no message, and with every hook off, so nothing the
 * user's settings run at SessionStart fires and Kernel's own hooks never see an outside session. The room's switched-off
 * servers (`denied`) never start. Servers connect on their own time, and claude.ai's connectors join a few seconds in, so
 * the list counts once two reads in a row agree and none is pending, or after `ms` as it stands.
 */
export async function probeClaudeMcp(cwd: string, o: { env: Record<string, string>; executable?: string; denied?: string[]; ms?: number; every?: number }): Promise<McpServerStatus[]> {
  const input = new InputQueue<SDKUserMessage>()
  const abort = new AbortController()
  const denied = [...new Set(o.denied ?? [])].map((serverName) => ({ serverName }))
  try {
    const settings = { disableAllHooks: true, ...(denied.length ? { deniedMcpServers: denied } : {}) }
    const q = query({ prompt: input, options: { cwd, settingSources: ['user', 'project', 'local'], settings, persistSession: false, abortController: abort, env: o.env, pathToClaudeCodeExecutable: o.executable } })
    const until = Date.now() + (o.ms ?? 30_000)
    let last: string | undefined
    for (;;) {
      const list = await withTimeout(q.mcpServerStatus(), 15_000)
      const shape = JSON.stringify(list.map((s) => [s.name, s.status]))
      if ((shape === last && !list.some((s) => s.status === 'pending')) || Date.now() >= until) return list
      last = shape
      await new Promise((resolve) => setTimeout(resolve, o.every ?? 1500))
    }
  } finally {
    input.close()
    abort.abort()
  }
}

/**
 * Claude Code's own slash commands without a live session: Claude Code starts with no prompt, no settings and no transcript,
 * lists them and stops, which sends no message.
 */
export async function claudeCommands(cwd: string): Promise<BuiltinCommand[]> {
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
export function askedQuestions(input: Record<string, unknown>): AskedQuestion[] {
  const list = Array.isArray(input.questions) ? input.questions : []
  return list.filter((q: any) => q && typeof q.question === 'string').map((q: any) => ({
    question: q.question,
    ...(typeof q.header === 'string' ? { header: q.header } : {}),
    options: (Array.isArray(q.options) ? q.options : []).map((o: any) => askedOption(o?.label ?? o, o?.description)),
    ...(typeof q.multiSelect === 'boolean' ? { multiSelect: q.multiSelect } : {})
  }))
}

/** Claude has no `ultra`, which only Codex models offer. A Claude chat never picks it, but a hand-edited one runs at `max`. */
const claudeEffort = (e: Effort): EffortLevel => (e === 'ultra' ? 'max' : e)

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

/**
 * In-process hooks. Every event feeds the room log the same way the installed hooks do for outside sessions.
 * A Bash guard applies Kernel's Never allow and Always ask lists on top of the user's own Claude Code settings.
 */
function kernelHooks(o: {
  ctx: { roomId: string; workspaceId: string; agentId?: string }
  commands: Map<string, string>
  verdict: (command: string) => Verdict
  held: () => Promise<void> | undefined
  networkAllowed?: () => boolean
  handoff?: LeadHandoff
  /** The agent file's tools line, when it has one (KERNEL-397). */
  tools?: ToolPolicy
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { ctx, commands, verdict, held, networkAllowed = () => true, handoff, tools } = o
  const report: HookCallback = async (input) => {
    const a = toActivity(input as HookPayload, ctx)
    if (a) bus.activity(a)
    return {}
  }
  const guard: HookCallback = async (input) => {
    const { tool_use_id, tool_input } = input as PreToolUseHookInput
    const command = String((tool_input as any)?.command ?? '')
    commands.set(tool_use_id, command)
    // A room's Always allow rule gives no opinion here. canUseTool allows the command if Claude Code asks about it.
    const v = verdict(command)
    if (v?.behavior === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.message } }
    if (v?.behavior === 'ask') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: v.reason } }
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
  // A tool the agent file doesn't list is refused with the reason, here and in any subagent it starts (KERNEL-397).
  if (tools) {
    const gate: HookCallback = async (input) => {
      const { tool_name: tool, tool_input } = input as PreToolUseHookInput
      if (tools.allows(tool, tool_input)) return {}
      bus.track({ name: 'tool.blocked_by_agent_file', tool: toolKind(tool) })
      const why = tools.disallows(tool)
        ? `Your agent file's disallowedTools takes away ${tool}. Use another tool, or ask the user to take ${tool} off disallowedTools in your agent file.`
        : `Your agent file doesn't list ${tool}. Use another tool, or ask the user to add ${tool} to the tools line in your agent file.`
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }
    }
    hooks.PreToolUse!.push({ hooks: [gate] })
  }
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

/**
 * What Claude Code 2.1.292 answers a resume of a session it has no transcript for, followed by the id, as the only entry
 * of an error_during_execution result's `errors` that comes before any init (KERNEL-286). It prints the same on stderr.
 */
export const SESSION_GONE = 'No conversation found with session ID: '

/** How long a paused room's tool call may wait. The CLI gives a callback hook 600 seconds unless told otherwise, and a timed-out PreToolUse hook lets the call go. In seconds. */
export const HOLD_TIMEOUT_SEC = 7 * 24 * 3600

/** How long a hook that asks the user waits: a minute short of its matcher's timeout, so Kernel denies the call before the CLI stops waiting and lets it go. In milliseconds. */
export const HOOK_ASK_MS = (HOLD_TIMEOUT_SEC - 60) * 1000

/** What the agent hears when the user didn't answer in time, or the ask ended without an answer. */
const NO_DECISION = 'No decision was made in time.'

/**
 * Asks the user from inside a PreToolUse hook and waits, for a call Claude Code would run without asking: Always ask in
 * Auto, the tools gate in Auto and Bypass (KERNEL-433, KERNEL-446). The card and the agent's needs status are the ones
 * canUseTool's asks get. Only the user's yes allows the call. An abort, the wait running out and no decision deny it,
 * because a hook that times out lets the call go. The hook's matcher needs `timeout: HOLD_TIMEOUT_SEC`.
 */
export async function awaitDecision(host: Pick<RunnerHost, 'ask'>, req: Ask, signal: AbortSignal, timeoutMs = HOOK_ASK_MS): Promise<SyncHookJSONOutput> {
  const deny = (reason: string): SyncHookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
  // An abort listener added after the abort never fires, so the card would wait out the whole timeout.
  if (signal.aborted) return deny(NO_DECISION)
  const result = await host.ask(req, { signal, timeoutMs })
  if (result?.behavior === 'allow') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
  if (!result) return deny(NO_DECISION)
  return deny(result.behavior === 'answer' ? `The user answered: ${result.text}` : result.message ?? 'Denied in Kernel.')
}

/** Hooks whose exit code 2 stops the agent from going on, which the floor shows as blocked. */
const BLOCKING_HOOKS = new Set(['TaskCreated', 'TaskCompleted', 'TeammateIdle', 'Stop', 'PreToolUse'])

/** Sessions bill the Claude plan through Claude Code's own login. An API key in Kernel's environment would bill the API instead. */
export function sessionEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>, o: { agentTeams?: boolean } = {}): Record<string, string> {
  const env = { ...base, ...extra } as Record<string, string>
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  // Settings > Models > "Use agent teams" decides for Kernel's own sessions, whatever the user's shell exports (D-027).
  if (o.agentTeams === true) env[AGENT_TEAMS] = '1'
  else if (o.agentTeams === false) delete env[AGENT_TEAMS]
  // No compact window: a chat uses its model's whole context window, 1M on a 1M model (context-window-follows-model).
  return env
}

/** Claude Code's switch for agent teams (TaskCreated, TaskCompleted, TeammateIdle, a shared task list). */
export const AGENT_TEAMS = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'

/**
 * What the room switched off, as the session's flag settings: each skill hidden from the model and the / menu, each MCP
 * server never started. Kernel's own servers (`own`) stay whatever their name. Nothing switched off adds nothing (KERNEL-226).
 */
export function switchedOff(off: { skills: string[]; mcp: string[] } | undefined, own: string[] = []): Options['settings'] | undefined {
  const skills = [...new Set(off?.skills ?? [])]
  const mcp = [...new Set(off?.mcp ?? [])].filter((name) => !own.includes(name))
  if (!skills.length && !mcp.length) return undefined
  return {
    ...(skills.length ? { skillOverrides: Object.fromEntries(skills.map((name) => [name, 'off' as const])) } : {}),
    ...(mcp.length ? { deniedMcpServers: mcp.map((serverName) => ({ serverName })) } : {})
  }
}

const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const

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

/** The SDK adds the end of stderr to a process's exit error only when it spawned the process itself. */
function withStderr(message: string, stderr: string): string {
  const tail = stderr.trim().slice(-500)
  return tail && !message.includes('stderr:') ? `${message}. stderr: ${tail}` : message
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
