import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { ChatItem, ChatPart, CodexPersonality, Decision, Effort, TokenCounts, UnlistedTools } from '@shared/types'
import { linkText } from '@shared/links'
import { leadModeOf } from '@shared/leadMode'
import { describeTool } from '../../approvals'
import { planChanges } from '../../handoff'
import { exec } from '../../exec'
import { fileMarker, filesNote, IMAGE_DATA_URL, imageMarker, imagesNote, isAttached } from '../../attachments'
import { ALWAYS_ASK, BUILD_CLOSED, decide, referenceWrite, REFERENCE_READ_ONLY, rulesOf, saveAlwaysAllow, type Rules, type RunMode, type Step } from '../../permissions'
import { handoffRefusal, toolPolicy } from '../../agentTools'
import { codexStatus } from '../../mcp'
import { sharesFile } from '../../sharedFiles'
export { sharesFile }
import type { LimitPatch } from '../limits'
import type { Proc, Runner, RunnerHost } from '../types'
import { appServerArgs, codexEnv, KERNEL_VERSION, loginWithKey } from './client'
import { initializeParams, Rpc, RpcError } from './rpc'
import { callTool, CODEX_TOOL_PREFIX, mcpOverrides, toolOutput, toolSpecs } from './tools'
import type { JsonValue } from './protocol/serde_json/JsonValue'
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams'
import type { CommandExecutionRequestApprovalResponse } from './protocol/v2/CommandExecutionRequestApprovalResponse'
import type { ConfigReadParams } from './protocol/v2/ConfigReadParams'
import type { ConfigReadResponse } from './protocol/v2/ConfigReadResponse'
import type { DynamicToolCallParams } from './protocol/v2/DynamicToolCallParams'
import type { McpServerStatusUpdatedNotification } from './protocol/v2/McpServerStatusUpdatedNotification'
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams'
import type { FileChangeRequestApprovalResponse } from './protocol/v2/FileChangeRequestApprovalResponse'
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse'
import type { PermissionsRequestApprovalParams } from './protocol/v2/PermissionsRequestApprovalParams'
import type { PermissionsRequestApprovalResponse } from './protocol/v2/PermissionsRequestApprovalResponse'
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot'
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse'
import type { ThreadTokenUsage } from './protocol/v2/ThreadTokenUsage'
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown'
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams'
import type { ToolRequestUserInputResponse } from './protocol/v2/ToolRequestUserInputResponse'
import type { Turn } from './protocol/v2/Turn'
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse'
import type { UserInput } from './protocol/v2/UserInput'
import { askedOption } from '../questions'

// Codex through `codex app-server`, one process per chat like Claude (KERNEL-406). Kernel speaks its JSON-RPC: a thread per
// chat (its id is the chat's session id), a turn per message, and Codex's approval requests, questions and tool calls
// answered here. The decisions behind it are in docs/decisions/KERNEL-406.md.

/** What a Codex runner starts with, which Sessions works out for the chat. */
export interface CodexStart {
  /** The `codex` executable, by Settings, Providers. */
  bin: string
  /** CODEX_HOME of the active Codex account. Undefined is Codex's own `~/.codex`. */
  home?: string
  /** An API key account's key, which the process logs in with and keeps in memory only (KERNEL-523). */
  apiKey?: string
  /** The workspace's variables. */
  env: Record<string, string>
  /** The agent's prompt with Kernel's rules and the tools' instructions, as the thread's developer instructions. */
  prompt: string
  /** Kernel's own tools for this agent, offered as dynamic tools. */
  tools: SdkMcpToolDefinition<any>[]
  personality: CodexPersonality
  /** The MCP servers the project switched off, and its `[mcp.aliases]` the agent file's tools line reads through (KERNEL-464). */
  disabled?: string[]
  aliases?: Record<string, string>
  /** The project's `[agents]` table for this agent: `unlisted_tools`, and the MCP servers `allow` adds to its tools line (KERNEL-537). */
  access?: { unlisted: UnlistedTools; allow: string[] }
  /**
   * The chat runs in Bypass permissions (`effectiveMode`, so not while it plans), and with `unlisted_tools = "ask"` the thread
   * keeps the MCP servers its tools line leaves out. The thread keeps that list until its process restarts (bypass-allows-unlisted-mcp).
   */
  bypass?: boolean
  /** The project's reference folders that are there now: the agent may read them, and Kernel declines changes under them (KERNEL-790). */
  references?: string[]
}

/** How much of a tool's output, and of each string in its input, a chat row keeps (the same as Claude's rows). */
const TEXT_MAX = 20_000

/**
 * Codex runs commands through the login shell (`/bin/zsh -lc "..."`). Kernel's rules match what the agent meant, so the
 * shell wrapper comes off for them and for the row.
 */
export function unwrapShell(command: string): string {
  const m = /^\S*\/?(?:zsh|bash|sh) -l?c (['"])([\s\S]*)\1$/.exec(command.trim())
  if (!m) return command
  return m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, '$1') : m[2].replace(/'"'"'/g, "'")
}

/** Codex's usage windows as Kernel's: the 300-minute window is the 5-hour one, the 10080-minute one the weekly one. */
export function codexLimits(snap: RateLimitSnapshot | null | undefined, accountId?: string): LimitPatch[] {
  if (!snap) return []
  const out: LimitPatch[] = []
  for (const w of [snap.primary, snap.secondary]) {
    if (!w) continue
    const mins = w.windowDurationMins ?? 0
    const type = mins && mins <= 24 * 60 ? 'five_hour' : 'seven_day'
    out.push({ type, provider: 'codex', ...(accountId ? { accountId } : {}), utilization: w.usedPercent / 100, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), ...(w.usedPercent >= 100 ? { status: 'rejected' as const } : {}) })
  }
  // Codex says a limit was reached without a full window: the fuller window is the one that stopped it.
  if (snap.rateLimitReachedType && !out.some((l) => l.status === 'rejected') && out.length) {
    const fullest = out.reduce((a, b) => ((b.utilization ?? 0) > (a.utilization ?? 0) ? b : a))
    fullest.status = 'rejected'
  }
  return out
}

/**
 * Composer parts as Codex's turn input, in order. Pasted text is inlined. An image saved to the workspace is named where it
 * sat, as it is for Claude, and a last line asks Codex to open each one with its view_image tool, which shows as a Read step
 * (KERNEL-545). One without a file goes as a data URL in its place.
 */
export function toCodexInput(parts: ChatPart[]): UserInput[] {
  const input: UserInput[] = []
  let text: string[] = []
  let images = 0
  const files: Parameters<typeof filesNote>[0] = []
  const flush = (...end: (string | undefined)[]) => {
    const t = [text.join(' '), ...end].filter(Boolean).join('\n\n')
    if (t) input.push({ type: 'text', text: t, text_elements: [] })
    text = []
  }
  for (const p of parts) {
    if (p.type === 'text' && p.text.trim()) text.push(p.text)
    // Codex names a skill with `$`, where Claude Code takes a slash command.
    else if (p.type === 'skill') text.push(`$${p.name}`)
    else if (isAttached(p)) { files.push(p); text.push(fileMarker(files.length, p)) }
    else if (p.type === 'file') text.push(p.text ? `<pasted name="${p.name}">\n${p.text}\n</pasted>` : `@${p.path ?? p.name}`)
    else if (p.type === 'issue' || p.type === 'pr' || p.type === 'workspace') text.push(linkText(p))
    else if (p.type === 'agent') text.push(`@${p.name}`)
    else if (p.type === 'image' && p.path) text.push(imageMarker(++images, { ...p, path: p.path }))
    else if (p.type === 'image' && p.dataUrl && IMAGE_DATA_URL.test(p.dataUrl)) { flush(); input.push({ type: 'image', url: p.dataUrl }) }
  }
  flush(images ? imagesNote(images, 'view_image') : undefined, files.length ? filesNote(files, 'codex') : undefined)
  return input
}

/** The repo's shared git folder, which a worktree commits into, so the sandbox lets git write there. */
async function gitCommonDir(cwd: string): Promise<string | undefined> {
  const r = await exec('git', ['rev-parse', '--git-common-dir'], { cwd, timeoutMs: 10_000 })
  const dir = r.code === 0 ? r.stdout.trim() : ''
  return dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : undefined
}

/** A thread Codex no longer has: its rollout was deleted, or `~/.codex/sessions` was cleared (KERNEL-286's Codex side). */
const threadGone = (e: unknown) => e instanceof RpcError && /no rollout found|thread not found/i.test(e.message)

/**
 * A Codex model call's input counts in Claude's terms (KERNEL-842). OpenAI counts cached input inside `inputTokens`, so the
 * input that wasn't cached is what is left once the reads and writes are taken out.
 */
function codexCounts(u: TokenUsageBreakdown): TokenCounts {
  const cacheRead = u.cachedInputTokens ?? 0
  const cacheWrite = u.cacheWriteInputTokens ?? 0
  return { input: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite), cacheRead, cacheWrite }
}

/** One chat's `codex app-server` process (KERNEL-406). */
export class CodexRunner implements Runner {
  private readonly proc: Proc = { stderr: '' }
  private child?: ChildProcess
  private rpc?: Rpc
  private ready?: Promise<string>
  private isClosed = false
  private threadId?: string
  private turnId?: string
  /**
   * The turn being started: its `turn/start` hasn't answered yet, so Stop has no turn id to interrupt. `stopAsked` says Stop
   * was pressed meanwhile, and interrupts the turn as soon as Codex names it. Each turn has its own, so a turn that ended in
   * the chunk that answered its start can't clear the one queued straight after it (KERNEL-625).
   */
  private starting?: { stopAsked: boolean }
  private model: string
  private effort: Effort
  private plan: boolean
  /** A chat with Kernel in Hand off, which edits no file but the ones it shares (KERNEL-770). The mode it started in. A switch to Hand off applies at the next file change too (KERNEL-994). */
  private readonly handoff: boolean
  private gitDir?: string
  /** The running turn's plan, from its `plan` item. A plan-mode turn that ends with one asks for approval. */
  private planText?: string
  /** The turn already asked for approval with Kernel's request_plan_approval, so its plan item asks nothing more. */
  private planAsked = false
  /** The running turn's first and last model calls, from `thread/tokenUsage/updated`, for the turn's facts (KERNEL-842). */
  private calls: { first?: TokenUsageBreakdown; last?: TokenUsageBreakdown } = {}
  /** The id of the last turn that completed, so a start answered after its turn ended doesn't leave it as the current turn. */
  private endedTurn?: string
  /**
   * A compaction under way (`compact`): Codex runs it as a turn of its own, whose id `turn/started` gives. Its end resolves
   * `compact` and isn't one of Kernel's turns (KERNEL-844).
   */
  private compaction?: { turnId?: string; done: () => void }
  /**
   * Aborts when the running turn stops (Stop, Send now), ends or loses its process. Every card the turn put up waits on
   * it, Kernel's tools' too, so a stopped turn's card ends as expired (KERNEL-563).
   */
  private turnStop = new AbortController()
  /**
   * What a plan from `planned` waits on, since it outlives its turn: it aborts when the process goes away on its own.
   * Kernel closing an idle process leaves it, as the next message resumes the thread and approving the plan sends one.
   */
  private readonly planStop = new AbortController()
  /** Tool rows by Codex item id, so each one's end updates its start. */
  private readonly rows = new Map<string, ChatItem & { kind: 'tool' }>()
  /** File changes by item id, which their approval request names only by id. */
  private readonly changes = new Map<string, Extract<ThreadItem, { type: 'fileChange' }>>()
  private ended = false
  /** Servers Codex reported a startup status for. A tool call tells the project how the others are doing (KERNEL-464). */
  private readonly reported = new Set<string>()
  /** What tool calls last said of each server Codex reported nothing for, so a run of calls tells the project once. */
  private readonly called = new Map<string, boolean>()

  constructor(private readonly host: RunnerHost, private readonly o: CodexStart) {
    const chat = host.chat()
    this.model = chat.model
    this.effort = chat.effort
    this.plan = chat.plan
    this.handoff = !!host.agent?.lead && leadModeOf(host.workspace) === 'handoff'
    this.threadId = chat.sessionId
    if (chat.sessionId) host.managed(chat.sessionId)
  }

  get closed() { return this.isClosed }

  start() {
    this.ready = this.boot()
    // A failure here reaches whoever waits on the thread. One nobody waits on only ends the process.
    this.ready.catch(() => undefined)
  }

  push(parts: ChatPart[]) {
    void this.turn(parts).catch((e) => this.turnFailed(e))
  }

  async interrupt() {
    const threadId = this.threadId
    const turnId = this.turnId
    if (!this.rpc) return
    if (!turnId && this.starting) { this.starting.stopAsked = true; this.turnStop.abort(); return }
    if (!threadId || !turnId) return
    // The turn's cards end first. Codex 0.153.4 doesn't hold the interrupt for an open request: it clears the request.
    this.turnStop.abort()
    await this.rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 10_000 }).catch(() => undefined)
  }

  // Codex takes the model, the effort and plan mode with each turn, so a change applies from the next one. The permission mode
  // changes no thread setting: Kernel reads it at each approval request (KERNEL-447).
  async setModel(model: string) { this.model = model }
  async setEffort(effort: Effort) { this.effort = effort }
  async setMode(mode: RunMode) { this.plan = mode === 'plan' }

  async usage() {
    if (!this.rpc || this.isClosed) return
    try {
      const r = await this.rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read', undefined, { timeoutMs: 10_000 })
      this.host.mergeLimits(codexLimits(r.rateLimits))
    } catch { /* keep the last numbers */ }
  }

  /** Codex sends the context window use with every model call (`thread/tokenUsage/updated`), so there is nothing to ask. */
  async context() {}

  /**
   * `/compact`: Codex summarises the thread and frees context. Codex runs it as a turn, and this resolves when that turn
   * ends, or the process does, so the next turn never starts on a thread still compacting (KERNEL-844). Its token counts
   * are the chat's last turn's.
   */
  async compact() {
    const threadId = await this.ready
    if (!threadId || !this.rpc || this.isClosed) return
    const done = new Promise<void>((resolve) => { this.compaction = { done: resolve } })
    try {
      await this.rpc.request('thread/compact/start', { threadId }, { timeoutMs: 30_000 })
    } catch (e) {
      this.compaction = undefined
      throw e
    }
    await done
  }

  /** The compaction's turn ended, or the process did. */
  private compacted() {
    const c = this.compaction
    if (!c) return
    this.compaction = undefined
    const { first, last } = this.calls
    this.calls = {}
    if (last) this.host.turnUsage({ ...codexCounts(last), ...(first ? { first: codexCounts(first) } : {}), context: last.totalTokens })
    c.done()
  }

  close() {
    if (this.isClosed) return
    this.isClosed = true
    this.turnStop.abort()
    this.rpc?.close()
    this.child?.stdin?.end()
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM')
  }

  kill() { if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM') }

  /**
   * The sandbox for the next turn: writes in the workspace and the repo's git folder, network as Settings, Permissions says.
   * Plan mode only reads, and so does a chat with Kernel in Hand off (KERNEL-770): every file change then asks, and
   * `approveFiles` declines all but a file it shares. Git reads in the sandbox, and a git command that writes asks to leave it.
   */
  private sandbox(): SandboxPolicy {
    const network = this.host.settings().permissions.network !== false
    if (this.plan || this.handoff) return { type: 'readOnly', networkAccess: network }
    return { type: 'workspaceWrite', writableRoots: this.gitDir ? [this.gitDir] : [], networkAccess: network, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }

  private async boot(): Promise<string> {
    const ws = this.host.workspace
    const child = this.host.spawn(this.o.bin, appServerArgs(this.o.apiKey), { cwd: ws.path, env: codexEnv(this.o.env, this.o.home) }, this.proc)
    this.child = child
    child.stdin?.on('error', () => undefined)
    this.rpc = new Rpc(child.stdin!, child.stdout!, { notify: (m, p) => this.notified(m, p), request: (m, p) => this.requested(m, p) })
    child.once('exit', (code, signal) => this.exited(code, signal))
    child.once('error', (e) => this.exited(null, null, e.message))
    await this.rpc.request('initialize', initializeParams(KERNEL_VERSION), { timeoutMs: 60_000 })
    this.rpc.notify('initialized', {})
    await loginWithKey(this.rpc, this.o.apiKey, 60_000)
    this.gitDir = await gitCommonDir(ws.path).catch(() => undefined)
    const config = await this.mcpConfig(ws.path)
    // The same in every mode (KERNEL-447). Under `untrusted` Kernel sees every command Codex doesn't trust on its own, so Never
    // allow, network off and protected branches hold in Bypass permissions too, and no `approvalsReviewer` ever answers for the
    // user: Auto runs as Accept edits on Codex until Always ask can reach the user under `auto_review` (KERNEL-433).
    const settings = { cwd: ws.path, model: this.model, approvalPolicy: 'untrusted' as const, sandbox: 'workspace-write' as const, developerInstructions: withReferences(this.o.prompt, this.o.references), personality: this.o.personality, ...(config ? { config } : {}) }
    if (this.threadId) {
      try {
        const r = await this.rpc.request<ThreadStartResponse>('thread/resume', { threadId: this.threadId, ...settings }, { timeoutMs: 60_000 })
        this.threadId = r.thread.id
        return r.thread.id
      } catch (e) {
        if (threadGone(e)) throw new ThreadGone()
        throw e
      }
    }
    const r = await this.rpc.request<ThreadStartResponse>('thread/start', { ...settings, dynamicTools: toolSpecs(this.o.tools) }, { timeoutMs: 60_000 })
    this.threadId = r.thread.id
    this.host.managed(r.thread.id)
    return r.thread.id
  }

  /**
   * The agent file's limits on Codex's MCP servers, and the servers the project switched off, as the thread's config
   * (KERNEL-451, KERNEL-464). In Bypass permissions with `unlisted_tools = "ask"`, servers the tools line leaves out stay on
   * (bypass-allows-unlisted-mcp). Codex says which servers it has for this folder. When it can't, the chat says what doesn't
   * hold, rather than failing to start.
   */
  private async mcpConfig(cwd: string): Promise<Record<string, JsonValue> | undefined> {
    const agent = this.host.agent
    // A Lead's tracker issue writes go through file_issue, so Codex turns them off on the Linear and GitHub servers (feat-lead-files-tracker-issues-only-with).
    const policy = toolPolicy(agent?.tools, { disallowed: agent?.disallowedTools, aliases: this.o.aliases, allow: this.o.access?.allow, lead: agent?.lead ? leadModeOf(this.host.workspace) : undefined })
    const unlisted = !!this.o.bypass && (this.o.access?.unlisted ?? 'ask') === 'ask'
    const off = this.o.disabled ?? []
    if (!policy && !off.length) return undefined
    try {
      const r = await this.rpc!.request<ConfigReadResponse>('config/read', { cwd } satisfies ConfigReadParams, { timeoutMs: 30_000 })
      const servers = r?.config?.mcp_servers
      const config = mcpOverrides(policy, servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {}, off, { unlisted })
      return Object.keys(config).length ? config : undefined
    } catch {
      const what = policy ? `${agent?.name ?? 'this agent'}'s file doesn't limit them` : 'the ones switched off in this project are on'
      this.host.item({ kind: 'note', id: `codex-mcp-${Date.now()}`, ts: Date.now(), text: `Kernel couldn't read Codex's MCP servers, so ${what} in this chat.` })
      return undefined
    }
  }

  /** Codex says how a server's start went. The project keeps it (KERNEL-464). */
  private mcpStarted(p: McpServerStatusUpdatedNotification) {
    const status = codexStatus(p.status, p.failureReason)
    if (!status || !p.name) return
    this.reported.add(p.name)
    this.host.mcpStatus([{ name: p.name, status, ...(p.error ? { error: p.error } : {}) }])
  }

  /**
   * A tool call on a server Codex reported nothing for says whether the server works: it connected if the call went
   * through, else it failed with the call's error. The project hears when that changes (KERNEL-464).
   */
  private mcpCalled(server: string, ok: boolean, error?: string) {
    if (this.reported.has(server) || this.called.get(server) === ok) return
    this.called.set(server, ok)
    this.host.mcpStatus([{ name: server, status: ok ? 'connected' : 'failed', ...(!ok && error ? { error } : {}) }])
  }

  private async turn(parts: ChatPart[]) {
    this.turnStop = new AbortController()
    const start = (this.starting = { stopAsked: false })
    let turnId: string | undefined
    let current = false
    try { turnId = await this.startTurn(parts) } finally { current = this.starting === start; if (current) this.starting = undefined }
    // A turn queued while this one's start was answered is the chat's turn now, so this one's id and Stop are stale.
    if (!current) return
    // The turn's own notifications can be handled before its start is answered here, so one that already ended must not become the current turn again.
    if (turnId && turnId !== this.endedTurn) this.turnId = turnId
    if (start.stopAsked) await this.interrupt()
  }

  /** Starts a turn and returns its id. */
  private async startTurn(parts: ChatPart[]): Promise<string | undefined> {
    const threadId = await this.ready!
    if (this.isClosed) return undefined
    // The thread is up: the chat resumes it by this id from now on, and the turn shows as working.
    this.host.sessionStarted(threadId)
    this.planText = undefined
    this.planAsked = false
    const effort = this.effort
    const r = await this.rpc!.request<TurnStartResponse>('turn/start', {
      threadId, input: toCodexInput(parts), model: this.model, effort, summary: 'auto', approvalPolicy: 'untrusted', sandboxPolicy: this.sandbox(),
      collaborationMode: { mode: this.plan ? 'plan' : 'default', settings: { model: this.model, reasoning_effort: effort, developer_instructions: null } }
    }, { timeoutMs: 60_000 })
    return r.turn.id
  }

  /** A turn that couldn't start: the thread is gone, or the process failed. */
  private turnFailed(e: unknown) {
    if (this.isClosed) return
    if (e instanceof ThreadGone) { if (this.host.sessionGone()) return }
    const message = e instanceof Error ? e.message : String(e)
    this.host.item({ kind: 'note', id: `codex-error-${Date.now()}`, ts: Date.now(), text: `Codex could not start the turn: ${message}` })
    this.host.turnEnded({ id: `codex-turn-${Date.now()}`, ok: false, error: 'error_during_execution' })
  }

  private exited(code: number | null, signal: NodeJS.Signals | null, error?: string) {
    if (this.ended) return
    this.ended = true
    this.rpc?.close()
    this.compacted()
    // Nothing the process asked can be answered now. A plan waiting after its turn ends too, unless Kernel closed the process.
    this.turnStop.abort()
    if (!this.isClosed) this.planStop.abort()
    if (this.isClosed) { this.host.ended(null); return }
    const tail = this.proc.stderr.trim().slice(-500)
    const reason = error ?? (code !== null ? `exit code ${code}` : signal ? `signal ${signal}` : '')
    this.host.ended(tail ? `${reason}. stderr: ${tail}` : reason, { error: !!(error || code) })
  }

  private notified(method: string, params: any) {
    if (this.host.stale()) return
    switch (method) {
      case 'item/started': return this.itemStarted(params.item as ThreadItem)
      case 'item/completed': return this.itemCompleted(params.item as ThreadItem)
      case 'turn/started':
        // A compaction's turn starts while Kernel runs none of its own.
        if (this.compaction && !this.compaction.turnId && !this.turnId && !this.starting) { this.compaction.turnId = params.turn?.id; return }
        this.turnId = params.turn?.id ?? this.turnId
        return
      case 'turn/completed':
        if (this.compaction?.turnId && params.turn?.id === this.compaction.turnId) { this.compacted(); return }
        void this.turnCompleted(params.turn as Turn)
        return
      case 'thread/tokenUsage/updated': {
        const u = params.tokenUsage as ThreadTokenUsage
        if (u?.last) { this.calls.first ??= u.last; this.calls.last = u.last }
        if (u?.modelContextWindow) this.host.setContext(Math.max(0, Math.min(100, Math.round((u.last.totalTokens / u.modelContextWindow) * 100))), { used: u.last.totalTokens, max: u.modelContextWindow, rows: [] })
        return
      }
      case 'account/rateLimits/updated': this.host.mergeLimits(codexLimits(params.rateLimits as RateLimitSnapshot)); return
      case 'mcpServer/startupStatus/updated': this.mcpStarted(params as McpServerStatusUpdatedNotification); return
      case 'error': {
        const info = params.error?.codexErrorInfo
        if (info === 'unauthorized') this.host.failed('auth', { notify: true })
        return
      }
      default: return
    }
  }

  private itemStarted(item: ThreadItem) {
    const now = Date.now()
    const row = (name: string, input: Record<string, unknown>, detail: string): ChatItem & { kind: 'tool' } => ({ kind: 'tool', id: item.id, ts: now, toolUseId: item.id, name, label: describeTool(name, input).title, detail, status: 'running', input: clip(input) as Record<string, unknown> })
    let r: (ChatItem & { kind: 'tool' }) | undefined
    if (item.type === 'commandExecution') { const command = unwrapShell(item.command); r = row('Bash', { command }, command.split('\n')[0]) }
    else if (item.type === 'fileChange') {
      this.changes.set(item.id, item)
      const first = item.changes[0]
      const name = item.changes.length === 1 && first?.kind.type === 'add' ? 'Write' : 'Edit'
      r = row(name, { file_path: first?.path ?? '' }, [first?.path, item.changes.length > 1 ? `and ${item.changes.length - 1} more` : ''].filter(Boolean).join(' '))
    } else if (item.type === 'mcpToolCall') r = row(`mcp__${item.server}__${item.tool}`, (item.arguments ?? {}) as Record<string, unknown>, JSON.stringify(item.arguments ?? {}).slice(0, 120))
    else if (item.type === 'dynamicToolCall') r = row(`mcp__kernel__${item.tool.startsWith(CODEX_TOOL_PREFIX) ? item.tool.slice(CODEX_TOOL_PREFIX.length) : item.tool}`, (item.arguments ?? {}) as Record<string, unknown>, JSON.stringify(item.arguments ?? {}).slice(0, 120))
    else if ((item as { type: string }).type === 'webSearch') { const q = String((item as { query?: unknown }).query ?? ''); r = row('WebSearch', { query: q }, q) }
    // view_image opening a file, as an attached image the message asked it to open (KERNEL-545).
    else if (item.type === 'imageView') r = row('Read', { file_path: item.path }, item.path)
    if (!r) return
    this.rows.set(item.id, r)
    this.host.item(r)
  }

  private itemCompleted(item: ThreadItem) {
    const now = Date.now()
    switch (item.type) {
      case 'agentMessage':
        this.host.clearRetry()
        this.host.replied()
        if (item.text.trim()) this.host.item({ kind: 'text', id: item.id, ts: now, text: item.text })
        return
      case 'reasoning': {
        const text = (item.summary.length ? item.summary : item.content).join('\n\n').trim()
        if (text) this.host.item({ kind: 'thinking', id: item.id, ts: now, text })
        return
      }
      case 'plan': this.planText = item.text; return
      case 'commandExecution': return this.finish(item.id, item.status === 'completed', item.aggregatedOutput ?? '')
      case 'fileChange': return this.finish(item.id, item.status === 'completed', item.changes.map((c) => c.diff).join('\n'))
      case 'mcpToolCall':
        if (item.status !== 'inProgress') this.mcpCalled(item.server, item.status === 'completed', item.error?.message)
        return this.finish(item.id, item.status === 'completed', item.error ? item.error.message : (item.result?.content ?? []).map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n'))
      case 'dynamicToolCall':
        if (item.tool === `${CODEX_TOOL_PREFIX}request_plan_approval`) this.planAsked = true
        return this.finish(item.id, item.success !== false && item.status === 'completed', toolOutput(item.contentItems))
      // The compact itself gives no reply, so the turn says what happened (KERNEL-808).
      case 'contextCompaction': this.host.item({ kind: 'note', id: item.id, ts: now, text: 'Compacted the conversation.' }); return
      case 'imageView':
        if (!this.rows.has(item.id)) this.itemStarted(item)
        return this.finish(item.id, true, '')
      default:
        if ((item as { type: string }).type === 'webSearch') this.finish(item.id, true, '')
    }
  }

  private finish(id: string, ok: boolean, output: string) {
    const row = this.rows.get(id)
    if (!row) return
    if (ok) this.host.toolSucceeded()
    const done = (this.host.quitting
      ? { ...row, status: 'failed', output: 'Stopped when Kernel quit', outputCut: undefined }
      : { ...row, status: ok ? 'done' : 'failed', output: output.slice(0, TEXT_MAX), outputCut: output.length > TEXT_MAX || undefined }) as ChatItem & { kind: 'tool' }
    this.rows.set(id, done)
    this.host.item(done)
  }

  private async turnCompleted(turn: Turn) {
    if (turn.id && this.turnId && turn.id !== this.turnId) return
    this.turnId = undefined
    this.endedTurn = turn.id
    // Codex clears a request still open when a turn ends, so a card the turn left ends with it.
    this.turnStop.abort()
    const ok = turn.status === 'completed'
    // A finished turn means OpenAI's API answered, so the network works (KERNEL-231).
    if (ok) this.host.reached()
    const info = turn.error?.codexErrorInfo
    if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded') { await this.usage(); this.host.limited({ always: true }) }
    else if (info === 'unauthorized') this.host.failed('auth', { notify: true })
    else if (info && typeof info === 'object' && ('httpConnectionFailed' in info || 'responseStreamConnectionFailed' in info || 'responseStreamDisconnected' in info)) this.host.failed('network', { notify: true })
    if (!ok && turn.status === 'failed' && turn.error?.message) this.host.item({ kind: 'note', id: `${turn.id}-error`, ts: Date.now(), text: turn.error.message })
    const plan = ok && this.plan && !this.planAsked ? this.planText : undefined
    this.planText = undefined
    const { first, last } = this.calls
    this.calls = {}
    if (last) this.host.turnUsage({ ...codexCounts(last), ...(first ? { first: codexCounts(first) } : {}), context: last.totalTokens })
    this.host.turnEnded({ id: `${turn.id}-result`, ok, durationMs: turn.durationMs ?? undefined, error: ok ? undefined : turn.status === 'interrupted' ? 'interrupted' : 'error_during_execution', ...(info === 'contextWindowExceeded' ? { tooLong: true as const } : {}) })
    // A plan-mode turn that ended with a plan: the user approves it as Claude's ExitPlanMode would, and the agent goes on.
    if (plan?.trim()) { void this.planned(plan); return }
    // A Lead that ended a turn with an approved plan and nothing handed off gets one reminder, as Claude's Stop hook gives.
    const reminder = this.host.handoffAtStop()
    if (reminder) this.host.followUp(reminder)
  }

  private async planned(plan: string) {
    const result = await this.host.requestPlan(plan, { signal: this.planStop.signal })
    if (!result || this.isClosed && !this.host.chat()) return
    // An approval's note is Kernel's message, which `requestPlan` already queued.
    if (result.behavior === 'allow') return
    const text = result.behavior === 'answer' ? result.text : result.message
    if (text?.trim()) this.host.followUp(planChanges(text.trim()))
  }

  private async requested(method: string, params: any): Promise<unknown> {
    // The turn that asked. Its stop ends the card, even when the request waits out a pause first.
    const signal = this.turnStop.signal
    switch (method) {
      case 'item/commandExecution/requestApproval': return this.approveCommand(params as CommandExecutionRequestApprovalParams, signal)
      case 'item/fileChange/requestApproval': return this.approveFiles(params as FileChangeRequestApprovalParams, signal)
      case 'item/permissions/requestApproval': return this.approvePermissions(params as PermissionsRequestApprovalParams, signal)
      case 'item/tool/requestUserInput': return this.question(params as ToolRequestUserInputParams, signal)
      case 'item/tool/call': { const p = params as DynamicToolCallParams; return callTool(this.o.tools, p.tool, p.arguments, { signal }) }
      case 'execCommandApproval': case 'applyPatchApproval': return { decision: 'denied' }
      default: throw new RpcError(`Kernel can't answer ${method}.`, -32601)
    }
  }

  /** The rules for the next step, with the project's reference folders, which no file change may touch (KERNEL-790). */
  private rules(): Rules { return { ...rulesOf(this.host), references: this.o.references } }

  /** A paused project's agent waits here, before its next step, as a Claude agent waits at its next tool call. */
  private async held() { const open = this.host.held(); if (open) await open }

  /**
   * A command Codex wants to run. Kernel's order (docs/decisions/KERNEL-406.md): Never allow and Network off decline, a project
   * rule accepts, then anything that leaves the sandbox asks (`leavesSandbox`), which on Codex is every command it asks about.
   * Only typing into a running terminal follows the mode: Manual asks, the others accept. Bypass permissions declines what
   * Never allow, network off and protected branches refuse and accepts the rest, outside the sandbox too (KERNEL-447).
   */
  private async approveCommand(p: CommandExecutionRequestApprovalParams, signal: AbortSignal): Promise<CommandExecutionRequestApprovalResponse> {
    await this.held()
    const command = unwrapShell(p.command ?? '')
    const leaves = leavesSandbox(p)
    const step: Step = { tool: 'Bash', command, network: !!p.networkApprovalContext, sandbox: leaves ? 'outside' : 'inside', cwd: p.cwd ?? this.host.workspace.path }
    const verdict = decide(step, this.rules())
    // Codex's answer carries no reason, so a refusal shows in the chat, where the user sees why the step failed.
    if (verdict?.behavior === 'deny') return this.declined(verdict.message)
    if (verdict?.behavior === 'allow') return { decision: 'accept' }
    const d = describeTool('Bash', { command })
    const detail = [p.reason, leaves ? OUTSIDE_SANDBOX : undefined].filter(Boolean).join('. ')
    const reason = verdict?.behavior === 'ask' ? ALWAYS_ASK : leaves ? `${OUTSIDE_SANDBOX}.` : undefined
    const result = await this.host.ask({ kind: 'tool', toolName: 'Bash', input: { command }, title: d.title, ...(detail ? { detail } : {}), ...(reason ? { reason } : {}) }, { signal })
    saveAlwaysAllow(this.host, step, result)
    return { decision: result?.behavior === 'allow' ? 'accept' : 'decline' }
  }

  private declined(why: string): { decision: 'decline' } {
    // Two refusals can land in the same millisecond, and each keeps its own note.
    this.host.item({ kind: 'note', id: `codex-declined-${randomUUID()}`, ts: Date.now(), text: why })
    return { decision: 'decline' }
  }

  /**
   * File edits accept in Accept edits, Auto and Bypass permissions, and ask in Manual, as Claude's do. Writes outside the
   * workspace ask, except in Bypass permissions (KERNEL-447). A change that touches a reference folder anywhere, in any of its
   * files, a rename's destination or its `grantRoot`, declines in every mode (KERNEL-790).
   */
  private async approveFiles(p: FileChangeRequestApprovalParams, signal: AbortSignal): Promise<FileChangeRequestApprovalResponse> {
    await this.held()
    const change = this.changes.get(p.itemId)
    const path = change?.changes[0]?.path ?? p.grantRoot ?? ''
    const name = change && change.changes.length === 1 && change.changes[0].kind.type === 'add' ? 'Write' : 'Edit'
    // A rename writes its destination too, so `move_path` counts as a file the change touches.
    const touched = [...(change?.changes.flatMap((c) => [c.path, ...(c.kind.type === 'update' && c.kind.move_path ? [c.kind.move_path] : [])]) ?? []), ...(p.grantRoot ? [p.grantRoot] : [])]
    const cwd = this.host.workspace.path
    if (touched.some((file) => referenceWrite({ tool: 'Edit', input: { file_path: file }, cwd }, this.o.references))) return this.declined(REFERENCE_READ_ONLY)
    // A review only reads, whatever its agent's file says (KERNEL-549).
    if (this.host.workspace.reviewOf) return { decision: 'decline' }
    // Hand off edits nothing but the files it shares under .kernel/shared, whatever the file and the mode say (KERNEL-770).
    // The note says why, and that a switch to Build here during the turn applies from the next message.
    if ((this.handoff || this.host.leadMode() === 'handoff') && !(change?.changes.length && change.changes.every((c) => sharesFile(this.host.workspace.path, c.path)))) return this.declined(handoffRefusal(this.host.leadMode()))
    // Build here edits only after a go-ahead, whatever the mode says (KERNEL-992).
    if (this.host.agent?.lead && this.host.buildOpen && this.host.leadMode() === 'build' && !this.host.buildOpen() && !(change?.changes.length && change.changes.every((c) => sharesFile(this.host.workspace.path, c.path)))) return this.declined(BUILD_CLOSED)
    if (decide({ tool: name, sandbox: p.grantRoot ? 'outside' : 'inside' }, this.rules())?.behavior === 'allow') return { decision: 'accept' }
    const d = describeTool(name, { file_path: path })
    const result = await this.host.ask({ kind: 'tool', toolName: name, input: { file_path: path }, title: d.title, detail: p.reason ?? undefined }, { signal })
    return { decision: result?.behavior === 'allow' ? 'accept' : 'decline' }
  }

  /**
   * More permissions than the sandbox gives, such as the network or another folder. The user's call, except in Bypass
   * permissions, which grants them (KERNEL-447). Network off says no in every mode.
   */
  private async approvePermissions(p: PermissionsRequestApprovalParams, signal: AbortSignal): Promise<PermissionsRequestApprovalResponse> {
    const none: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' }
    const granted: PermissionsRequestApprovalResponse = { permissions: { ...(p.permissions.network ? { network: p.permissions.network } : {}), ...(p.permissions.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}) }, scope: 'turn' }
    const verdict = decide({ tool: 'Permissions', network: !!p.permissions.network, sandbox: 'outside' }, this.rules())
    if (verdict?.behavior === 'deny') return none
    if (verdict?.behavior === 'allow') return granted
    const title = p.permissions.network ? 'Allow network access' : 'Allow access outside the workspace'
    const result = await this.host.ask({ kind: 'tool', toolName: 'Permissions', input: p.permissions, title, detail: p.reason ?? undefined }, { signal })
    return result?.behavior === 'allow' ? granted : none
  }

  /** Codex's questions, as a Kernel question card like AskUserQuestion's. Answers go back by question id. */
  private async question(p: ToolRequestUserInputParams, signal: AbortSignal): Promise<ToolRequestUserInputResponse> {
    const questions = p.questions.map((q) => ({ question: q.question, ...(q.header ? { header: q.header } : {}), options: (q.options ?? []).map((o) => askedOption(o.label, o.description)) }))
    const first = questions[0]
    const result: Decision | undefined = await this.host.ask({ kind: 'question', toolName: 'AskUserQuestion', input: { questions }, title: first?.question ?? 'Question', options: first?.options.map((o) => o.label) ?? [], questions }, { signal })
    const answers: ToolRequestUserInputResponse['answers'] = {}
    if (result?.behavior === 'answer') {
      const given = result.answers ?? {}
      for (const q of p.questions) {
        const a = given[q.question]
        if (a !== undefined) answers[q.id] = { answers: Array.isArray(a) ? a.map(String) : [String(a)] }
      }
      if (!Object.keys(answers).length && p.questions[0] && result.text) answers[p.questions[0].id] = { answers: [result.text] }
    }
    return { answers }
  }
}

/** The thread's developer instructions, with the project's reference folders named, so the agent knows it may read them (KERNEL-790). */
export function withReferences(prompt: string, references: string[] | undefined): string {
  if (!references?.length) return prompt
  const list = references.map((r) => `- ${r}`).join('\n')
  return `${prompt}\n\nThe project's reference folders. Read them when they help, but don't change them, since Kernel declines any edit there:\n${list}`
}

/** What a command card says when accepting runs the command outside Codex's sandbox. */
export const OUTSIDE_SANDBOX = 'Codex runs it outside its sandbox'

/** Codex 0.153.4's reason when a command failed in the sandbox and it asks to run it again with none. No field says so. */
const RETRY_UNSANDBOXED = /retry without sandbox/i

/**
 * Whether accepting a command request runs it outside the sandbox Kernel set for the turn, so it always asks (KERNEL-406).
 * Under the `untrusted` approval policy Kernel runs Codex with, an accepted command runs with no sandbox at all: a live run
 * of 0.153.4 wrote outside the workspace after one plain request was accepted, where `never` and `on-request` were denied
 * the same write. So every `command` request leaves it, the retry Codex asks for after a command failed in the sandbox
 * included, and so do the requests that name it in their fields: extra permissions, network access and a network policy
 * change. Only `writeStdin`, typing into a terminal already running, starts nothing new.
 */
export function leavesSandbox(p: CommandExecutionRequestApprovalParams): boolean {
  if (p.additionalPermissions || p.networkApprovalContext || p.proposedNetworkPolicyAmendments?.length) return true
  if (RETRY_UNSANDBOXED.test(p.reason ?? '')) return true
  return (p.kind ?? 'command') !== 'writeStdin'
}

/** The thread this chat resumed is gone, so Sessions starts a fresh one. */
class ThreadGone extends Error { constructor() { super('The Codex thread is gone.') } }

/** The tool's input for its row, with every long string clipped, nested ones too. */
function clip(v: unknown): unknown {
  return typeof v === 'string' ? v.slice(0, TEXT_MAX)
    : Array.isArray(v) ? v.map(clip)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]))
        : v
}
