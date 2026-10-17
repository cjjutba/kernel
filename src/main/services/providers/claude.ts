import { randomUUID } from 'node:crypto'
import { query, type CanUseTool, type EffortLevel, type HookCallback, type HookCallbackMatcher, type HookEvent, type McpServerStatus, type ModelInfo, type Options, type PermissionResult, type PreToolUseHookInput, type Query, type SDKControlGetUsageResponse, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage, type SlashCommand, type SpawnedProcess, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { AppSettings, AskedQuestion, BuiltinCommand, Chat, ChatItem, ChatPart, CompactWindow, Effort, LeadMode, TokenCounts, UnlistedTools } from '@shared/types'
import { MODELS } from '@shared/types'
import type { HookPayload } from '@shared/hookSchemas'
import { linkText } from '@shared/links'
import { leadModeOf } from '@shared/leadMode'
import { toolView } from '@shared/toolView'
import { bus } from '../../bus'
import { NO_PROMPTS } from '../exec'
import { describeTool } from '../approvals'
import { toActivity } from '../hookServer'
import { failureOf } from '../health'
import { toolKind, toolPolicy, type ToolPolicy } from '../agentTools'
import { mcpStatus, type McpReport } from '../mcp'
import { fileMarker, filesNote, IMAGE_DATA_URL, imageMarker, imagesNote, isAttached } from '../attachments'
import { buildWrite, decide, hookVerdict, MODE_NAMES, NETWORK_OFF, referenceWrite, rulesOf, saveAlwaysAllow, stricter, type Rules, type RunMode, type Verdict } from '../permissions'
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
  /** The skills and MCP servers switched off for the project (KERNEL-226). */
  disabled?: { skills: string[]; mcp: string[] }
  /** The agent's prompt with Kernel's rules, appended to Claude Code's own. */
  prompt: string
  /** The workspace's variables, before `sessionEnv` takes the API keys out. */
  env: Record<string, string>
  /** The active account's folder or credential (`Providers.claudeEnv`), which `sessionEnv` adds after that (KERNEL-523, KERNEL-567). */
  credential?: Record<string, string>
  /** Where the chat compacts, from its role in Settings, Models (feat-compact-window-per-role-with-plan). Without it the variable stays as the Mac has it. */
  compact?: CompactWindow
  /** The project's checkout, which a Lead worktree takes its `.claude` settings from. */
  root?: string
  /** The project's `[mcp.aliases]`, which the agent file's tools line reads through (KERNEL-464). */
  aliases?: Record<string, string>
  /** The project's `[agents]` table for this agent: `unlisted_tools`, and the MCP servers `allow` adds to its tools line (KERNEL-537). */
  access?: { unlisted: UnlistedTools; allow: string[] }
  /** The project's reference folders that are there now: Claude may read them, and Kernel denies edits under them (KERNEL-748). */
  references?: string[]
  /** The mode the session starts in (`effectiveMode`). */
  mode: RunMode
  /**
   * The chat runs in Bypass permissions, plan mode aside, so the process may take it (`allowDangerouslySkipPermissions`).
   * Only then: a subagent's own Bypass needs it too, and a repo's agent file could otherwise ask for it (KERNEL-447).
   */
  bypass: boolean
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
  /** This turn's notification notes by the SDK's key, so a repeat updates its line. The key is fixed across chats and turns, so the id is the first event's uuid (KERNEL-808). */
  private readonly notices = new Map<string, string>()
  /** Bash commands by tool use id, as the model wrote them. Other hooks may rewrite the input canUseTool sees. */
  private readonly commands = new Map<string, string>()
  /** The folder each Bash command runs in, from the hook, for the push guard in canUseTool (KERNEL-687). */
  private readonly cwds = new Map<string, string>()
  /** The session id this process resumed, until its first init shows Claude Code found it (KERNEL-286). */
  private resume?: string
  /** The running turn's first and last main-loop model calls, by their usage, for the turn's facts (KERNEL-842). */
  private calls: { first?: Usage; last?: Usage } = {}
  /** The mode Kernel last put the CLI in: the start's, then each one `setPermissionMode` took (KERNEL-447). */
  private applied: RunMode
  /** The mode Claude Code last said it runs in, from its init and status messages. A message can lag a switch. */
  private reported?: RunMode
  /** Modes a switch asked for that Claude Code hasn't answered yet. */
  private readonly switchingTo: RunMode[] = []
  /** Mode switches, one after another, so the last one asked for is the one that holds. */
  private switching: Promise<void> = Promise.resolve()
  /**
   * The process started with `allowDangerouslySkipPermissions`, so Claude Code, or a subagent with its own bypass, may run a
   * step in Bypass permissions whatever mode Kernel last asked for, until the process ends.
   */
  private readonly bypassable: boolean
  /** The project's reference folders as the session started with them (KERNEL-748). */
  private readonly references: string[]

  constructor(private readonly host: RunnerHost, o: ClaudeStart) {
    const chat = host.chat()
    const ws = host.workspace
    const agent = host.agent
    const ctx = { projectId: ws.projectId, workspaceId: ws.id, agentId: agent?.id }
    // Known before the process starts, so the hook server never mistakes this session's first hooks for an outside one.
    const sessionId = chat.sessionId ?? randomUUID()
    host.managed(sessionId)
    // The agent file's tools line and disallowedTools hold, as they do when Claude Code runs the file as a subagent (KERNEL-397, KERNEL-451).
    // A review only reads, whatever its agent's file says (KERNEL-549). A chat with Kernel edits only in Build here (KERNEL-770).
    const tools = toolPolicy(agent?.tools, { disallowed: agent?.disallowedTools, aliases: o.aliases, allow: o.access?.allow, readOnly: !!ws.reviewOf, lead: agent?.lead ? leadModeOf(ws) : undefined })
    const off = switchedOff(o.disabled, Object.keys(o.mcpServers ?? {}))
    this.applied = o.mode
    this.bypassable = o.bypass
    this.references = o.references ?? []
    const options: Options = {
      cwd: ws.path,
      ...(o.references?.length ? { additionalDirectories: o.references } : {}),
      // The Lead's worktree takes `.claude` settings, agents, hooks and `.mcp.json` from the project's checkout, as it did when
      // it worked there, and loads each once (KERNEL-348, KERNEL-355).
      ...(ws.lead && ws.mode === 'worktree' && o.root ? { projectConfigRoot: o.root } : {}),
      model: chat.model,
      effort: claudeEffort(chat.effort),
      // Without display: 'summarized' the CLI sends thinking blocks with empty text.
      thinking: { type: 'adaptive', display: 'summarized' },
      permissionMode: o.mode,
      ...(o.bypass ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: this.canUseTool(),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: o.prompt },
      mcpServers: o.mcpServers,
      ...(off ? { settings: off } : {}),
      ...(tools?.hidden.length ? { disallowedTools: tools.hidden } : {}),
      hooks: kernelHooks({
        ctx, commands: this.commands, cwds: this.cwds, tools,
        verdict: (command, cwd) => hookVerdict({ tool: 'Bash', command, cwd }, this.rules()),
        writeVerdict: (tool, input, cwd) => referenceWrite({ tool, input, cwd }, this.references),
        ...(agent?.lead && host.buildOpen ? { buildGate: (tool: string, input: unknown, cwd?: string) => (host.leadMode() === 'build' ? buildWrite({ tool, input, cwd }, () => host.buildOpen!()) : undefined) } : {}),
        projectAllows: (tool, input) => hookVerdict({ tool, input }, this.rules())?.behavior === 'allow',
        askUser: (command, reason, signal) => this.askFromHook(command, reason, signal),
        askTool: (tool, input, reason, signal) => this.askToolFromHook(tool, input, reason, signal),
        unlisted: o.access?.unlisted ?? 'ask',
        bypassing: () => this.rules().mode === 'bypassPermissions',
        gates: () => host.settings().hooks,
        held: () => host.held(),
        networkAllowed: () => host.settings().permissions.network !== false,
        afterPlan: () => host.afterPlan(),
        setupNote: () => host.setupNote(),
        handoff: agent?.lead ? { atStop: () => host.handoffAtStop() } : undefined,
        leadMode: () => host.leadMode()
      }),
      includeHookEvents: true,
      ...(chat.sessionId ? { resume: chat.sessionId } : { sessionId }),
      abortController: this.abort,
      env: sessionEnv(o.env, o.credential ?? {}, { agentTeams: host.settings().models?.agentTeams, compact: o.compact }),
      pathToClaudeCodeExecutable: claudeExecutable(host.settings().providers?.claude),
      // No sandbox, Bypass permissions included, as in Claude Code's own `--dangerously-skip-permissions` (KERNEL-571).
      // Kernel's hooks and canUseTool still decide first.
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
  setMode(mode: RunMode): Promise<void> {
    // Counted at once, so a hook that fires before the switch goes out already checks against it.
    this.switchingTo.push(mode)
    this.switching = this.switching.then(() => this.switchTo(mode))
    return this.switching
  }
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

  /** Claude Code's models with what each one supports, from the session's initialize answer, for Auto (KERNEL-447). */
  async models(): Promise<ModelInfo[]> { return (await withTimeout(this.query.initializationResult(), 15_000)).models ?? [] }

  private async switchTo(mode: RunMode) {
    try {
      if (mode === this.applied || this.closed) return
      await this.query.setPermissionMode(mode)
      this.applied = mode
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      this.host.item({ kind: 'note', id: randomUUID(), ts: Date.now(), text: `Claude Code didn't switch this chat to ${MODE_NAMES[mode]} (${why}), so it stays in ${MODE_NAMES[this.applied]}.` })
    } finally {
      this.switchingTo.splice(this.switchingTo.indexOf(mode), 1)
    }
  }

  /** What an init or status message says Claude Code runs in. Kernel never asks for `dontAsk`, which asks no one, so it reads as Manual. */
  private report(mode: NonNullable<Options['permissionMode']> | undefined) {
    if (mode) this.reported = mode === 'dontAsk' ? 'default' : mode
  }

  /**
   * The rules Kernel's own checks use (KERNEL-447). Asks follow the strictest mode Claude Code might run the step in: the one
   * Kernel last set, the ones a switch is still asking for, the one Claude Code last reported and the one the chat should be
   * in. So Always ask has no opinion only when every one of them is Bypass permissions. Bypass's own denials hold for the whole
   * life of a process that can take it, since a switch out of it can be pending or refused and a subagent can run in it anyway.
   */
  private rules(): Rules {
    const mode = [this.host.mode(), ...this.switchingTo, ...(this.reported ? [this.reported] : [])].reduce<RunMode>(stricter, this.applied)
    return { ...rulesOf(this.host, mode), mayBypass: this.bypassable, references: this.references }
  }

  /**
   * Always ask, from the Bash guard: the user answers inside the hook, in every mode it applies in, so no classifier and no
   * rule of Claude Code's answers first (KERNEL-433, KERNEL-447). Always allow on the card saves the project rule, as canUseTool's does.
   */
  private askFromHook(command: string, reason: string, signal: AbortSignal): Promise<SyncHookJSONOutput> {
    const host = this.host
    const d = describeTool('Bash', { command })
    const asking = {
      ask: async (a: Ask, o: { signal?: AbortSignal; timeoutMs?: number }) => {
        const decision = await host.ask(a, o)
        saveAlwaysAllow(host, { tool: 'Bash', command }, decision)
        return decision
      }
    }
    return awaitDecision(asking, { kind: 'tool', toolName: 'Bash', input: { command }, title: d.title, detail: d.detail, reason }, signal)
  }

  /**
   * An MCP tool from a server the agent file doesn't list, in a project whose `unlisted_tools` is `ask` (KERNEL-537). The user
   * answers inside the hook as for Always ask, and Always allow on the card saves the project's tool rule.
   */
  private askToolFromHook(tool: string, input: unknown, reason: string, signal: AbortSignal): Promise<SyncHookJSONOutput> {
    const host = this.host
    const d = describeTool(tool, input)
    const asking = {
      ask: async (a: Ask, o: { signal?: AbortSignal; timeoutMs?: number }) => {
        const decision = await host.ask(a, o)
        saveAlwaysAllow(host, { tool, input }, decision)
        return decision
      }
    }
    return awaitDecision(asking, { kind: 'tool', toolName: tool, input, title: d.title, detail: d.detail, reason }, signal)
  }

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
          this.report(msg.permissionMode)
          this.resume = undefined
          // Claude.ai connectors only show up here, so a tools line naming a server the session lacks is caught at init. Each
          // init's statuses keep the project's fresh (KERNEL-464).
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
        if (msg.subtype === 'status') this.report(msg.permissionMode)
        // Auto mode's classifier refused a step without asking anyone, so the chat says what and why (KERNEL-447).
        if (msg.subtype === 'permission_denied' && msg.decision_reason_type === 'classifier') {
          const row = this.toolItems.get(msg.tool_use_id)
          const why = (msg.decision_reason ?? msg.message ?? '').trim()
          host.item({ kind: 'note', id: `denied-${msg.tool_use_id}`, ts: now, text: `Auto mode refused ${row ? `"${row.label}"` : msg.tool_name}${why ? `: ${why}` : '.'}` })
        }
        // Events that can end a turn with no reply say what happened, so the turn doesn't look empty (KERNEL-808).
        if (msg.subtype === 'compact_boundary') {
          const { trigger, pre_tokens: pre, post_tokens: post } = msg.compact_metadata
          const span = post === undefined ? `from ${kTokens(pre)}` : `${kTokens(pre)} to ${kTokens(post)}`
          const note: ChatItem = { kind: 'note', id: msg.uuid, ts: now, text: trigger === 'auto' ? `Context was full, so the conversation was compacted (${span} tokens).` : `Compacted the conversation${post === undefined ? '' : ','} ${span} tokens.` }
          if (!host.compacted?.(note, { pre, post })) host.item(note)
          void this.context()
        }
        // A hook's block reason or a prominent status line. Progress lines for one tool share an id, so each replaces the last.
        if (msg.subtype === 'informational' && msg.content.trim() && (msg.prevent_continuation || msg.level === 'warning' || msg.level === 'suggestion')) {
          host.item({ kind: 'note', id: msg.tool_use_id ? `info-${msg.tool_use_id}` : msg.uuid, ts: now, text: msg.content.trim() })
        }
        if (msg.subtype === 'notification' && msg.text.trim() && (msg.priority === 'high' || msg.priority === 'immediate')) {
          const id = this.notices.get(msg.key) ?? msg.uuid
          this.notices.set(msg.key, id)
          host.item({ kind: 'note', id, ts: now, text: msg.text.trim() })
        }
        if (msg.subtype === 'model_refusal_no_fallback') host.item({ kind: 'note', id: msg.uuid, ts: now, text: msg.content.trim() || 'Claude declined to answer.' })
        if (msg.subtype === 'model_refusal_fallback') {
          const scope = msg.scope === 'local' ? ' The switch covers only this reply.' : ''
          host.item({ kind: 'note', id: msg.uuid, ts: now, text: `Claude declined on ${msg.original_model}, so the reply came from ${msg.fallback_model}.${scope}` })
        }
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
        // Each content block comes as its own message with the call's usage, so the first call is the first one seen.
        if (msg.message.usage) { this.calls.first ??= msg.message.usage; this.calls.last = msg.message.usage }
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
          this.cwds.delete(block.tool_use_id)
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
        this.notices.clear()
        const ok = msg.subtype === 'success'
        // A turn that ended on an API error is `success` with `is_error`, so it never says the API was reached.
        if (ok && !msg.is_error) host.reached()
        const calls = this.calls
        this.calls = {}
        if (msg.subtype !== 'success' && this.resume && msg.errors?.includes(`${SESSION_GONE}${this.resume}`) && host.sessionGone()) return
        if (msg.usage) host.turnUsage({ ...counts(msg.usage), ...(calls.first ? { first: counts(calls.first) } : {}), ...(calls.last ? { context: contextOf(calls.last) } : {}) })
        host.turnEnded({ id: msg.uuid, ok, durationMs: msg.duration_ms, error: ok ? undefined : msg.subtype, ...(msg.terminal_reason === 'prompt_too_long' ? { tooLong: true as const } : {}) })
        return
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info
        host.mergeLimits(limitsFromEvent(info))
        if (info.status === 'rejected') host.limited()
        if (info.status === 'rejected' && info.rateLimitType) bus.activity({ kind: 'limit', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, text: `hit the ${info.rateLimitType.replace(/_/g, ' ')} limit`, data: { resetsAt: info.resetsAt } })
        return
      }
      default: return
    }
  }

  /**
   * Called for whatever Claude Code would prompt for. Kernel's rules decide first (`decide`), and what they leave open goes to
   * the user. In Bypass permissions that is everything the CLI still sends, since it only sends what it insists on asking about.
   */
  private canUseTool(): CanUseTool {
    const host = this.host
    return async (toolName, input, { signal, suggestions, suppressAlwaysAllowRule, toolUseID, decisionReason, blockedPath, description }): Promise<PermissionResult> => {
      const command = toolName === 'Bash' ? this.commands.get(toolUseID) ?? String((input as any).command ?? '') : ''
      const step = { tool: toolName, command, input, cwd: this.cwds.get(toolUseID) }
      const verdict = decide(step, this.rules())
      if (verdict?.behavior === 'deny') return { behavior: 'deny', message: verdict.message }
      if (verdict?.behavior === 'allow') return { behavior: 'allow', updatedInput: input }

      const isQuestion = toolName === 'AskUserQuestion'
      const shown = command ? { ...input, command } : input
      const d = describeTool(toolName, shown)
      const questions = isQuestion ? askedQuestions(input) : undefined
      const options = questions?.[0]?.options.map((o) => o.label) ?? (isQuestion ? [] : undefined)
      const reason = isQuestion ? undefined : askReason({ decisionReason, blockedPath, description })
      const result = toolName === 'ExitPlanMode'
        ? await host.requestPlan(String((input as any).plan ?? ''), { signal, toolName, input: shown })
        : await host.ask({ kind: isQuestion ? 'question' : 'tool', toolName, input: shown, title: isQuestion ? questions?.[0]?.question ?? 'Question' : d.title, detail: d.detail, options, questions, ...(reason ? { reason } : {}) }, { signal })
      if (!result) return { behavior: 'deny', message: NO_DECISION }
      // A rule Kernel saved on the project outlives the worktree. Claude Code's suggestions only go back for a tool it can't save.
      const saved = saveAlwaysAllow(host, step, result, { suggestions, suppressAlwaysAllowRule })
      if (result.behavior === 'allow') return { behavior: 'allow', updatedInput: input, updatedPermissions: result.always && !command && !saved ? suggestions : undefined }
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

/**
 * Claude Code started with no prompt, no settings and no transcript, asked for usage and stopped. It sends no message, so it
 * uses none of the plan. `env` is the account's (`Providers.claudeEnv`), so an added account reads its own (KERNEL-567).
 */
export async function probeClaudeUsage(cwd: string, merge: (p: LimitPatch[]) => void, o: { env?: Record<string, string>; bin?: string } = {}) {
  const input = new InputQueue<SDKUserMessage>()
  const abort = new AbortController()
  try {
    const q = query({ prompt: input, options: { cwd, settingSources: [], persistSession: false, abortController: abort, env: sessionEnv(process.env, o.env ?? {}), pathToClaudeCodeExecutable: o.bin ?? packagedClaude() } })
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
 * user's settings run at SessionStart fires and Kernel's own hooks never see an outside session. The project's switched-off
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
 * Claude Code's models with what each supports, without a live session (KERNEL-447): Claude Code starts on the active
 * account with no prompt, no settings and no transcript, answers its initialize and stops, which sends no message.
 */
export async function claudeModels(cwd: string, o: { env: Record<string, string>; bin?: string }): Promise<ModelInfo[]> {
  const input = new InputQueue<SDKUserMessage>()
  const abort = new AbortController()
  try {
    const q = query({ prompt: input, options: { cwd, settingSources: [], persistSession: false, abortController: abort, env: sessionEnv(process.env, o.env), pathToClaudeCodeExecutable: o.bin ?? packagedClaude() } })
    return (await withTimeout(q.initializationResult(), 15_000)).models ?? []
  } finally {
    input.close()
    abort.abort()
  }
}

/**
 * Why Claude Code asked, for the card's reason line (`Approval.reason`, KERNEL-447): its own reason, the path it stopped at
 * and its description of the step, as far as it gives them.
 */
export function askReason(o: { decisionReason?: string; blockedPath?: string; description?: string }): string | undefined {
  const path = o.blockedPath && !o.decisionReason?.includes(o.blockedPath) ? `Blocked path: ${o.blockedPath}` : undefined
  const parts = [o.decisionReason, path, o.description].map((p) => p?.trim().replace(/\.+$/, '')).filter((p): p is string => !!p)
  return parts.length ? `${parts.join('. ')}.` : undefined
}

/**
 * Claude Code's own slash commands without a live session: Claude Code starts on the active account with no prompt, no
 * settings and no transcript, lists them and stops, which sends no message.
 */
export async function claudeCommands(cwd: string, o: { env?: Record<string, string>; bin?: string } = {}): Promise<BuiltinCommand[]> {
  const input = new InputQueue<SDKUserMessage>()
  const abort = new AbortController()
  try {
    const q = query({ prompt: input, options: { cwd, settingSources: [], persistSession: false, abortController: abort, env: sessionEnv(process.env, o.env ?? {}), pathToClaudeCodeExecutable: o.bin ?? packagedClaude() } })
    return builtinCommands(await withTimeout(q.supportedCommands(), 15_000))
  } finally {
    input.close()
    abort.abort()
  }
}

/**
 * Turn composer parts into one SDK user message. Pasted text is inlined. An image saved to the workspace is named where it sat,
 * and a last line asks the agent to Read each one, so it opens them as steps of their own (KERNEL-545). One without a file
 * goes inline as an image block.
 */
export function toUserMessage(parts: ChatPart[]): SDKUserMessage {
  const content: any[] = []
  // A skill chip is a slash command, and Claude Code only reads one at the start of a text block, so the text after it joins it.
  let lead = ''
  let images = 0
  const files: Parameters<typeof filesNote>[0] = []
  const text = (t: string) => { content.push({ type: 'text', text: [lead, t].filter(Boolean).join(' ') }); lead = '' }
  for (const p of parts) {
    if (p.type === 'text' && p.text.trim()) text(p.text)
    else if (p.type === 'skill') { if (lead) text(''); lead = `/${p.name}` }
    else if (isAttached(p)) { files.push(p); text(fileMarker(files.length, p)) }
    else if (p.type === 'file') text(p.text ? `<pasted name="${p.name}">\n${p.text}\n</pasted>` : `@${p.path ?? p.name}`)
    else if (p.type === 'issue' || p.type === 'pr' || p.type === 'workspace') text(linkText(p))
    else if (p.type === 'agent') text(`@${p.name}`)
    else if (p.type === 'image' && p.path) text(imageMarker(++images, { ...p, path: p.path }))
    else if (p.type === 'image' && p.dataUrl) {
      const m = IMAGE_DATA_URL.exec(p.dataUrl)
      if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
    }
  }
  if (lead) text('')
  if (images) text(imagesNote(images, 'the Read tool'))
  if (files.length) text(filesNote(files, 'claude'))
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
export const TOOL_TEXT_MAX = 20_000

/** The tool's input for its row, with every string longer than TOOL_TEXT_MAX clipped, nested ones too. */
export function clipInput(input: unknown): Record<string, unknown> | undefined {
  const clip = (v: unknown): unknown =>
    typeof v === 'string' ? v.slice(0, TOOL_TEXT_MAX)
      : Array.isArray(v) ? v.map(clip)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]))
          : v
  return input && typeof input === 'object' && !Array.isArray(input) ? clip(input) as Record<string, unknown> : undefined
}

export function toolDetail(name: string, input: any): string {
  if (name === 'Bash') return String(input?.command ?? '').split('\n')[0]
  if (SUBAGENT_TOOLS.has(name) && input?.description) return String(input.description)
  if (input?.file_path) return String(input.file_path)
  if (input?.pattern) return String(input.pattern)
  // A tool the chat's own wording knows keeps what that wording says about it, not its raw input (KERNEL-785).
  const view = toolView({ name, input: input ?? {}, status: 'running' })
  if (!view.hidden && view.verb !== name) return view.detail ?? view.object ?? ''
  return JSON.stringify(input ?? {}).slice(0, 120)
}

/**
 * In-process hooks. Every event feeds the project log the same way the installed hooks do for outside sessions.
 * A Bash guard applies Kernel's Never allow and Always ask lists on top of the user's own Claude Code settings.
 */
function kernelHooks(o: {
  ctx: { projectId: string; workspaceId: string; agentId?: string }
  commands: Map<string, string>
  cwds: Map<string, string>
  /** Kernel's answer about a command in the hook (`hookVerdict`), run in `cwd`. */
  verdict: (command: string, cwd?: string) => Verdict
  /** Kernel's answer about a file edit in the hook: a deny under a reference folder (`referenceWrite`, KERNEL-748). */
  writeVerdict?: (tool: string, input: unknown, cwd?: string) => Verdict
  /** A Build here chat's file edit in the hook: a deny until the user has given a go-ahead (`buildWrite`, KERNEL-992). */
  buildGate?: (tool: string, input: unknown, cwd?: string) => Verdict
  /** A project's tool rule lets an MCP or web tool call through from the hook (`hookVerdict`, KERNEL-454). */
  projectAllows: (tool: string, input: unknown) => boolean
  /** Asks the user about an Always ask command and waits, for the hook's answer (`awaitDecision`). */
  askUser: (command: string, reason: string, signal: AbortSignal) => Promise<SyncHookJSONOutput>
  held: () => Promise<void> | undefined
  networkAllowed?: () => boolean
  /** The approved plan's note for the agent, once, as context on ExitPlanMode's answer (plan-cards-survive-restart). */
  afterPlan?: () => string | undefined
  setupNote?: () => string | undefined
  handoff?: LeadHandoff
  /** The agent file's tools line, when it has one (KERNEL-397). */
  tools?: ToolPolicy
  /** A chat with Kernel's mode at the call, so Hand off's refusal can say the user switched since the turn started (KERNEL-770). */
  leadMode?: () => LeadMode | undefined
  /** Asks the user about an MCP tool the file doesn't list, for `unlisted_tools = "ask"` (KERNEL-537). */
  askTool?: (tool: string, input: unknown, reason: string, signal: AbortSignal) => Promise<SyncHookJSONOutput>
  /** The project's `[agents] unlisted_tools`. `ask` when unset. */
  unlisted?: UnlistedTools
  /**
   * Every mode Claude Code might run the step in is Bypass permissions (`rules()`), so an MCP tool `unlisted = "ask"` would ask
   * about runs instead (bypass-allows-unlisted-mcp). Read at each call, since the mode changes during a process's life.
   */
  bypassing?: () => boolean
  /** Settings, Hooks, read each time a gate runs (KERNEL-537). */
  gates?: () => AppSettings['hooks'] | undefined
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { ctx, commands, cwds, verdict, writeVerdict, buildGate, projectAllows, askUser, held, networkAllowed = () => true, afterPlan, setupNote, handoff, tools, leadMode = () => undefined, askTool, unlisted = 'ask', bypassing = () => false, gates } = o
  const report: HookCallback = async (input) => {
    const a = toActivity(input as HookPayload, ctx)
    if (a) bus.activity(a)
    return {}
  }
  const guard: HookCallback = async (input, _id, { signal }) => {
    const { tool_use_id, tool_input, cwd } = input as PreToolUseHookInput
    const command = String((tool_input as any)?.command ?? '')
    commands.set(tool_use_id, command)
    if (cwd) cwds.set(tool_use_id, cwd)
    const v = verdict(command, cwd)
    if (v?.behavior === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.message } }
    // A command the tools line refuses is neither asked about nor allowed: the gate denies it (KERNEL-447).
    if (tools && !tools.allows('Bash', tool_input)) return {}
    // Always ask waits for the user here, in every mode but Bypass permissions, where the guard has no opinion on it.
    if (v?.behavior === 'ask') return askUser(command, v.reason, signal)
    // A project's Always allow rule answers here, so Auto mode's classifier can't refuse it (KERNEL-454).
    if (v?.behavior === 'allow') return PROJECT_ALLOWS
    return {}
  }
  // The same for an MCP or web tool the project allows. Network off and the tools line still deny it in their own hooks.
  const projectTool: HookCallback = async (input) => {
    const { tool_name: tool, tool_input } = input as PreToolUseHookInput
    if (tools && !tools.allows(tool, tool_input)) return {}
    return projectAllows(tool, tool_input) ? PROJECT_ALLOWS : {}
  }
  // A paused project's agents wait here, so they stop at the next tool call and not in the middle of one.
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
    // Kernel's note that setup ended reaches the agent here, once, at a tool call and never as a turn of its own.
    const note = setupNote?.()
    return note ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } } : {}
  }
  const events: HookEvent[] = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle']
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = Object.fromEntries(events.map((e) => [e, [{ hooks: [report] }]]))
  const web: HookCallback = async () => (networkAllowed() ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NETWORK_OFF } })
  hooks.PreToolUse!.push({ hooks: [hold], timeout: HOLD_TIMEOUT_SEC }, { matcher: 'Bash', hooks: [guard], timeout: HOLD_TIMEOUT_SEC }, { matcher: 'WebFetch|WebSearch', hooks: [web] }, { matcher: PROJECT_TOOLS, hooks: [projectTool] })
  // An edit under a reference folder is denied here, so Accept edits and Bypass permissions, which never ask, still refuse it (KERNEL-748).
  if (writeVerdict) {
    const write: HookCallback = async (input) => {
      const { tool_name: tool, tool_input, cwd } = input as PreToolUseHookInput
      const v = writeVerdict(tool, tool_input, cwd)
      return v?.behavior === 'deny' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.message } } : {}
    }
    hooks.PreToolUse!.push({ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [write] })
  }
  // Build here edits files only after a go-ahead, whatever the mode says, so Bypass permissions can't skip it (KERNEL-992).
  if (buildGate) {
    const closed: HookCallback = async (input) => {
      const { tool_name: tool, tool_input, cwd } = input as PreToolUseHookInput
      const v = buildGate(tool, tool_input, cwd)
      return v?.behavior === 'deny' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.message } } : {}
    }
    hooks.PreToolUse!.push({ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [closed] })
  }
  // A tool the agent file doesn't list is refused with the reason, here and in any subagent it starts (KERNEL-397).
  if (tools) {
    const gate: HookCallback = async (input, _id, { signal }) => {
      const { tool_name: tool, tool_input } = input as PreToolUseHookInput
      if (tools.allows(tool, tool_input)) return {}
      // Hand off refuses an edit whatever the file says, and says so, including a switch to Build here since the turn started.
      // A Lead's tracker issue writes go through file_issue, whatever a project rule or the user would allow (KERNEL-770,
      // feat-lead-files-tracker-issues-only-with).
      const mode = tools.modeRefuses(tool, leadMode())
      if (mode) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: mode } }
      // An MCP server the file doesn't list, and disallowedTools doesn't take away: a project rule lets it through, and with
      // `unlisted_tools = "ask"` the user decides, or Bypass permissions does as it would with no tools line. `hide` refuses
      // it as before (KERNEL-537, bypass-allows-unlisted-mcp).
      if (tool.startsWith('mcp__') && !tools.disallows(tool)) {
        if (projectAllows(tool, tool_input)) return PROJECT_ALLOWS
        if (unlisted === 'ask' && bypassing()) return PROJECT_ALLOWS
        if (unlisted === 'ask' && askTool) return askTool(tool, tool_input, `Your agent file doesn't list ${tool.split('__')[1]}.`, signal)
      }
      bus.track({ name: 'tool.blocked_by_agent_file', tool: toolKind(tool) })
      const why = tools.disallows(tool)
        ? `Your agent file's disallowedTools takes away ${tool}. Use another tool, or ask the user to take ${tool} off disallowedTools in your agent file.`
        : `Your agent file doesn't list ${tool}. Use another tool, or ask the user to add ${tool} to the tools line in your agent file.`
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }
    }
    hooks.PreToolUse!.push({ hooks: [gate], timeout: HOLD_TIMEOUT_SEC })
  }
  if (gates) {
    const team = teamGates(gates)
    hooks.PostToolUse!.push({ matcher: 'Bash', hooks: [team.onBash] })
    hooks.TaskCreated!.push({ hooks: [team.onTaskCreated] })
    hooks.TaskCompleted!.push({ hooks: [team.onTaskCompleted] })
    hooks.TeammateIdle!.push({ hooks: [team.onIdle] })
  }
  if (afterPlan) {
    // The approval reaches the agent with the plan's path, and a Lead's with "hand it off now", in the same turn.
    const planned: HookCallback = async () => { const t = afterPlan(); return t ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: t } } : {} }
    hooks.PostToolUse!.push({ matcher: 'ExitPlanMode', hooks: [planned] })
  }
  if (handoff) {
    // A Lead's Stop before any workspace exists gets one reminder.
    const atStop: HookCallback = async () => { const t = handoff.atStop(); return t ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: t } } : {} }
    hooks.Stop!.push({ hooks: [atStop] })
  }
  return hooks
}

/** A command that runs a test suite, for Block TaskCompleted without test output (KERNEL-537). */
export const TEST_COMMAND = /(^|[\s;&|(])((p?npm|yarn|bun|pnpm)\s+(run\s+)?test(:\S+)?|npx\s+(vitest|jest|playwright\s+test)|vitest|jest|pytest|py\.test|go\s+test|cargo\s+(nextest\s+run|test)|mix\s+test|rspec|phpunit|dotnet\s+test|swift\s+test|xcodebuild\b[^;&|]*\btest|(\.\/)?gradlew?\s+test|mvn\s+(\S+\s+)*test|make\s+(check|test)|deno\s+test|bundle\s+exec\s+(rspec|rake\s+test)|python3?\s+-m\s+(pytest|unittest))\b/

/** How many times in a row Keep idle teammates working sends one teammate back while no task finishes, so it can't loop. */
export const IDLE_NUDGES = 3

/**
 * Settings, Hooks gates for Kernel's own sessions (KERNEL-537), read from `gates` each time so a switch applies at once.
 * Block TaskCompleted without test output refuses a task marked done when no test command ran in the session since the
 * last task finished, once per task: a teammate's own commands may not reach this session, so a second try goes through.
 * Keep idle teammates working sends a teammate that goes idle back while the task list has open
 * tasks, at most `IDLE_NUDGES` times in a row. Claude Code reads `decision: 'block'` and feeds `reason` to the agent.
 */
export function teamGates(gates: () => AppSettings['hooks'] | undefined): { onBash: HookCallback; onTaskCreated: HookCallback; onTaskCompleted: HookCallback; onIdle: HookCallback } {
  let tested = false
  const open = new Map<string, string>()
  const asked = new Set<string>()
  const nudges = new Map<string, number>()
  const block = (reason: string): SyncHookJSONOutput => ({ decision: 'block', reason })
  return {
    onBash: async (input) => {
      const command = String(((input as { tool_input?: { command?: unknown } }).tool_input)?.command ?? '')
      if (TEST_COMMAND.test(command)) tested = true
      return {}
    },
    onTaskCreated: async (input) => {
      const t = input as { task_id?: string; task_subject?: string }
      if (t.task_id) open.set(t.task_id, t.task_subject ?? t.task_id)
      return {}
    },
    onTaskCompleted: async (input) => {
      const t = input as { task_id?: string; task_subject?: string }
      const key = t.task_id ?? t.task_subject ?? ''
      if (gates()?.requireTestOutput && !tested && !asked.has(key)) {
        asked.add(key)
        return block(`Run the tests before you mark "${t.task_subject ?? t.task_id ?? 'this task'}" done, and include their output. No test command ran since the last task finished. Kernel's Settings, Hooks asks for test output.`)
      }
      tested = false
      if (t.task_id) open.delete(t.task_id)
      nudges.clear()
      return {}
    },
    onIdle: async (input) => {
      const name = (input as { teammate_name?: string }).teammate_name ?? 'teammate'
      if (!gates()?.keepTeammatesWorking || !open.size) return {}
      const n = nudges.get(name) ?? 0
      if (n >= IDLE_NUDGES) return {}
      nudges.set(name, n + 1)
      const list = [...open.values()].slice(0, 5).map((s) => `"${s}"`).join(', ')
      return block(`The task list still has open tasks: ${list}${open.size > 5 ? ` and ${open.size - 5} more` : ''}. Claim one with TaskList and TaskUpdate and keep working. Kernel's Settings, Hooks keeps idle teammates working.`)
    }
  }
}

/** What a PreToolUse hook answers for a step a project's Always allow rule covers (KERNEL-454), or an unlisted MCP tool in Bypass permissions. */
const PROJECT_ALLOWS: SyncHookJSONOutput = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }

/** The tools a project's tool rule can cover, as a hook matcher: every MCP tool, WebFetch and WebSearch. */
export const PROJECT_TOOLS = 'mcp__.*|WebFetch|WebSearch'

/** A Lead's hand-off hook: the Stop reminder. Returns the text to send, or nothing. */
interface LeadHandoff { atStop: () => string | undefined }

/**
 * What Claude Code 2.1.292 answers a resume of a session it has no transcript for, followed by the id, as the only entry
 * of an error_during_execution result's `errors` that comes before any init (KERNEL-286). It prints the same on stderr.
 */
export const SESSION_GONE = 'No conversation found with session ID: '

/** How long a paused project's tool call may wait. The CLI gives a callback hook 600 seconds unless told otherwise, and a timed-out PreToolUse hook lets the call go. In seconds. */
export const HOLD_TIMEOUT_SEC = 7 * 24 * 3600

/** How long a hook that asks the user waits: a minute short of its matcher's timeout, so Kernel denies the call before the CLI stops waiting and lets it go. In milliseconds. */
export const HOOK_ASK_MS = (HOLD_TIMEOUT_SEC - 60) * 1000

/** What the agent hears when the user didn't answer in time, or the ask ended without an answer. */
const NO_DECISION = 'No decision was made in time.'

/**
 * Asks the user from inside a PreToolUse hook and waits, for a call no mode or classifier of Claude Code's may answer: Always
 * ask in every mode but Bypass permissions, and the tools gate in Auto and Bypass (KERNEL-433, KERNEL-446, KERNEL-447). The
 * card and the agent's needs status are the ones canUseTool's asks get. Only the user's yes allows the call. An abort, the
 * wait running out and no decision deny it, because a hook that times out lets the call go. The hook's matcher needs
 * `timeout: HOLD_TIMEOUT_SEC`.
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

/** What the SDK warns with when a session starts in Bypass permissions with a canUseTool. */
export const SHADOWED_WARNING = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'

/**
 * The SDK warns at every session started in Bypass permissions that canUseTool won't see every call. Kernel knows, and asks
 * only about what Claude Code still sends it there (KERNEL-447), so the warning would only fill the log. Node prints warnings
 * from its own `warning` listener, so the listeners there now are wrapped to skip this one and get every other.
 */
export function muteShadowedWarning(proc: Pick<NodeJS.Process, 'listeners' | 'removeAllListeners' | 'on'> = process) {
  const before = proc.listeners('warning') as ((w: Error) => void)[]
  proc.removeAllListeners('warning')
  proc.on('warning', (w: Error & { code?: string }) => { if (w.code !== SHADOWED_WARNING) for (const l of before) l(w) })
}

/** Hooks whose exit code 2 stops the agent from going on, which Team and the sidebar show as blocked. */
const BLOCKING_HOOKS = new Set(['TaskCreated', 'TaskCompleted', 'TeammateIdle', 'Stop', 'PreToolUse'])

/**
 * Sessions bill the account the user picked (D-018, KERNEL-523). An API key or auth token in `base`, from the Mac or the
 * workspace, would bill the API instead, so it goes. `account` is the active account's (`Providers.claudeEnv`): nothing for
 * the CLI's own login, an added login's folder as CLAUDE_CONFIG_DIR (KERNEL-567), a legacy `setup-token` token, or an API
 * key account's key. A folder or a key also drops any OAuth token from `base`, so the account picked is what pays.
 */
export function sessionEnv(base: NodeJS.ProcessEnv, account: Record<string, string>, o: { agentTeams?: boolean; compact?: CompactWindow } = {}): Record<string, string> {
  const env = { ...base } as Record<string, string>
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  if (account.ANTHROPIC_API_KEY || account.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CODE_OAUTH_TOKEN
  Object.assign(env, account)
  // Settings > Models > "Use agent teams" decides for Kernel's own sessions, whatever the user's shell exports (D-027).
  if (o.agentTeams === true) env[AGENT_TEAMS] = '1'
  else if (o.agentTeams === false) delete env[AGENT_TEAMS]
  env[ARTIFACT] ??= '1'
  // An agent's git can't answer a credential prompt either, so a push without a login fails instead of hanging (KERNEL-460).
  Object.assign(env, NO_PROMPTS)
  // The chat's role in Settings, Models decides where it compacts, whatever the Mac exports: 200k, or the model's whole
  // window, 1M on a 1M model. A helper call or a terminal passes no choice and keeps the Mac's (feat-compact-window-per-role-with-plan).
  if (o.compact === '200k') env[COMPACT_WINDOW] = COMPACT_AT_200K
  else if (o.compact === 'full') delete env[COMPACT_WINDOW]
  return env
}

/** Claude Code's variable for the window a session compacts against. It compacts 33k below it (KERNEL-226). */
export const COMPACT_WINDOW = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const COMPACT_AT_200K = '200000'

/** Claude Code's switch for agent teams (TaskCreated, TaskCompleted, TeammateIdle, a shared task list). */
export const AGENT_TEAMS = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'

/**
 * Claude Code's switch for its Artifact tools, which draw Claude Design canvases. SDK sessions default them off and the CLI
 * on, so Kernel gives its sessions the CLI's default. The Mac's value and `enableArtifact: false` still win (KERNEL-795).
 */
export const ARTIFACT = 'CLAUDE_CODE_ARTIFACT'

/**
 * What the project switched off, as the session's flag settings: each skill hidden from the model and the / menu, each MCP
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

/** The token fields of a Messages API usage, as the SDK sends it on an assistant message and a result. */
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

/** A usage's input counts (KERNEL-842). The API counts input that wasn't cached apart from what was read or written. */
function counts(u: Usage): TokenCounts {
  return { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 }
}

/** The chat's size after a model call: everything it read, and what it wrote, which the next call reads. */
function contextOf(u: Usage): number {
  const c = counts(u)
  return c.input + c.cacheRead + c.cacheWrite + (u.output_tokens ?? 0)
}

/** The SDK adds the end of stderr to a process's exit error only when it spawned the process itself. */
// 142000 reads as 142k.
function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

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
