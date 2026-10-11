import type { ChildProcess } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { ChatItem, ChatPart, CodexPersonality, Decision, Effort } from '@shared/types'
import { linkText } from '@shared/links'
import { describeTool } from '../../approvals'
import { exec } from '../../exec'
import { IMAGE_DATA_URL } from '../../plans'
import { bashVerdict, NETWORK_OFF, usesNetwork } from '../../bashGuard'
import type { LimitPatch } from '../limits'
import type { Proc, Runner, RunnerHost } from '../types'
import { codexEnv, KERNEL_VERSION } from './client'
import { initializeParams, Rpc, RpcError } from './rpc'
import { callTool, CODEX_TOOL_PREFIX, toolOutput, toolSpecs } from './tools'
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams'
import type { CommandExecutionRequestApprovalResponse } from './protocol/v2/CommandExecutionRequestApprovalResponse'
import type { DynamicToolCallParams } from './protocol/v2/DynamicToolCallParams'
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams'
import type { FileChangeRequestApprovalResponse } from './protocol/v2/FileChangeRequestApprovalResponse'
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse'
import type { PermissionsRequestApprovalParams } from './protocol/v2/PermissionsRequestApprovalParams'
import type { PermissionsRequestApprovalResponse } from './protocol/v2/PermissionsRequestApprovalResponse'
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot'
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse'
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams'
import type { ToolRequestUserInputResponse } from './protocol/v2/ToolRequestUserInputResponse'
import type { Turn } from './protocol/v2/Turn'
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse'
import type { UserInput } from './protocol/v2/UserInput'

// Codex through `codex app-server`, one process per chat like Claude (KERNEL-406). Kernel speaks its JSON-RPC: a thread per
// chat (its id is the chat's session id), a turn per message, and Codex's approval requests, questions and tool calls
// answered here. The decisions behind it are in docs/decisions/KERNEL-406.md.

/** What a Codex runner starts with, which Sessions works out for the chat. */
export interface CodexStart {
  /** The `codex` executable, by Settings, Providers. */
  bin: string
  /** CODEX_HOME of the active Codex account. Undefined is Codex's own `~/.codex`. */
  home?: string
  /** The workspace's variables. */
  env: Record<string, string>
  /** The agent's prompt with Kernel's rules and the tools' instructions, as the thread's developer instructions. */
  prompt: string
  /** Kernel's own tools for this agent, offered as dynamic tools. */
  tools: SdkMcpToolDefinition<any>[]
  personality: CodexPersonality
}

/** How much of a tool's output, and of each string in its input, a chat row keeps (the same as Claude's rows). */
const TEXT_MAX = 20_000

/** What Kernel tells an agent whose plan the user approved, when it isn't the Lead (whose hand-off says more). */
export const PLAN_APPROVED = 'The user approved your plan. Go ahead and carry it out.'

/** What a plan the user wants changed goes back as, the next plan-mode turn. */
export const planChanges = (text: string) => `The user wants changes to your plan: ${text}`

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

/** Composer parts as Codex's turn input. Pasted text is inlined and images go as data URLs, as they do for Claude. */
export function toCodexInput(parts: ChatPart[]): UserInput[] {
  const text: string[] = []
  const images: UserInput[] = []
  for (const p of parts) {
    if (p.type === 'text' && p.text.trim()) text.push(p.text)
    // Codex names a skill with `$`, where Claude Code takes a slash command.
    else if (p.type === 'skill') text.push(`$${p.name}`)
    else if (p.type === 'file') text.push(p.text ? `<pasted name="${p.name}">\n${p.text}\n</pasted>` : `@${p.path ?? p.name}`)
    else if (p.type === 'issue' || p.type === 'workspace') text.push(linkText(p))
    else if (p.type === 'image' && p.dataUrl && IMAGE_DATA_URL.test(p.dataUrl)) images.push({ type: 'image', url: p.dataUrl })
  }
  return [...(text.length ? [{ type: 'text' as const, text: text.join(' '), text_elements: [] }] : []), ...images]
}

/** The repo's shared git folder, which a worktree commits into, so the sandbox lets git write there. */
async function gitCommonDir(cwd: string): Promise<string | undefined> {
  const r = await exec('git', ['rev-parse', '--git-common-dir'], { cwd, timeoutMs: 10_000 })
  const dir = r.code === 0 ? r.stdout.trim() : ''
  return dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : undefined
}

/** A thread Codex no longer has: its rollout was deleted, or `~/.codex/sessions` was cleared (KERNEL-286's Codex side). */
const threadGone = (e: unknown) => e instanceof RpcError && /no rollout found|thread not found/i.test(e.message)

/** One chat's `codex app-server` process (KERNEL-406). */
export class CodexRunner implements Runner {
  private readonly proc: Proc = { stderr: '' }
  private child?: ChildProcess
  private rpc?: Rpc
  private ready?: Promise<string>
  private isClosed = false
  private threadId?: string
  private turnId?: string
  private model: string
  private effort: Effort
  private plan: boolean
  private gitDir?: string
  /** The running turn's plan, from its `plan` item. A plan-mode turn that ends with one asks for approval. */
  private planText?: string
  /** Tool rows by Codex item id, so each one's end updates its start. */
  private readonly rows = new Map<string, ChatItem & { kind: 'tool' }>()
  /** File changes by item id, which their approval request names only by id. */
  private readonly changes = new Map<string, Extract<ThreadItem, { type: 'fileChange' }>>()
  private ended = false

  constructor(private readonly host: RunnerHost, private readonly o: CodexStart) {
    const chat = host.chat()
    this.model = chat.model
    this.effort = chat.effort
    this.plan = chat.plan
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
    if (!this.rpc || !threadId || !turnId) return
    await this.rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 10_000 }).catch(() => undefined)
  }

  // Codex takes the model, the effort and the mode with each turn, so a change applies from the next one.
  async setModel(model: string) { this.model = model }
  async setEffort(effort: Effort) { this.effort = effort }
  async setPlan(on: boolean) { this.plan = on }

  async usage() {
    if (!this.rpc || this.isClosed) return
    try {
      const r = await this.rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read', undefined, { timeoutMs: 10_000 })
      this.host.mergeLimits(codexLimits(r.rateLimits))
    } catch { /* keep the last numbers */ }
  }

  /** Codex sends the context window use with every model call (`thread/tokenUsage/updated`), so there is nothing to ask. */
  async context() {}

  /** `/compact`: Codex summarises the thread and frees context. */
  async compact() {
    const threadId = await this.ready
    if (threadId) await this.rpc?.request('thread/compact/start', { threadId }, { timeoutMs: 30_000 })
  }

  close() {
    if (this.isClosed) return
    this.isClosed = true
    this.rpc?.close()
    this.child?.stdin?.end()
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM')
  }

  kill() { if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM') }

  /** The sandbox for the next turn: writes in the workspace and the repo's git folder, network as Settings, Permissions says. Plan mode only reads. */
  private sandbox(): SandboxPolicy {
    const network = this.host.settings().permissions.network !== false
    if (this.plan) return { type: 'readOnly', networkAccess: network }
    return { type: 'workspaceWrite', writableRoots: this.gitDir ? [this.gitDir] : [], networkAccess: network, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }

  private async boot(): Promise<string> {
    const ws = this.host.workspace
    const child = this.host.spawn(this.o.bin, ['app-server'], { cwd: ws.path, env: codexEnv(this.o.env, this.o.home) }, this.proc)
    this.child = child
    child.stdin?.on('error', () => undefined)
    this.rpc = new Rpc(child.stdin!, child.stdout!, { notify: (m, p) => this.notified(m, p), request: (m, p) => this.requested(m, p) })
    child.once('exit', (code, signal) => this.exited(code, signal))
    child.once('error', (e) => this.exited(null, null, e.message))
    await this.rpc.request('initialize', initializeParams(KERNEL_VERSION), { timeoutMs: 60_000 })
    this.rpc.notify('initialized', {})
    this.gitDir = await gitCommonDir(ws.path).catch(() => undefined)
    const settings = { cwd: ws.path, model: this.model, approvalPolicy: 'untrusted' as const, sandbox: 'workspace-write' as const, developerInstructions: this.o.prompt, personality: this.o.personality }
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

  private async turn(parts: ChatPart[]) {
    const threadId = await this.ready!
    if (this.isClosed) return
    // The thread is up: the chat resumes it by this id from now on, and the turn shows as working.
    this.host.sessionStarted(threadId)
    this.planText = undefined
    const effort = this.effort
    const r = await this.rpc!.request<TurnStartResponse>('turn/start', {
      threadId, input: toCodexInput(parts), model: this.model, effort, summary: 'auto', approvalPolicy: 'untrusted', sandboxPolicy: this.sandbox(),
      collaborationMode: { mode: this.plan ? 'plan' : 'default', settings: { model: this.model, reasoning_effort: effort, developer_instructions: null } }
    }, { timeoutMs: 60_000 })
    this.turnId = r.turn.id
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
      case 'turn/started': this.turnId = params.turn?.id ?? this.turnId; return
      case 'turn/completed': void this.turnCompleted(params.turn as Turn); return
      case 'thread/tokenUsage/updated': {
        const u = params.tokenUsage as { last: { totalTokens: number }; modelContextWindow: number | null }
        if (u?.modelContextWindow) this.host.setContext(Math.max(0, Math.min(100, Math.round((u.last.totalTokens / u.modelContextWindow) * 100))), { used: u.last.totalTokens, max: u.modelContextWindow, rows: [] })
        return
      }
      case 'account/rateLimits/updated': this.host.mergeLimits(codexLimits(params.rateLimits as RateLimitSnapshot)); return
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
      case 'mcpToolCall': return this.finish(item.id, item.status === 'completed', item.error ? item.error.message : (item.result?.content ?? []).map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n'))
      case 'dynamicToolCall': return this.finish(item.id, item.success !== false && item.status === 'completed', toolOutput(item.contentItems))
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
    const ok = turn.status === 'completed'
    const info = turn.error?.codexErrorInfo
    if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded') { await this.usage(); this.host.limited({ always: true }) }
    else if (info === 'unauthorized') this.host.failed('auth', { notify: true })
    else if (info && typeof info === 'object' && ('httpConnectionFailed' in info || 'responseStreamConnectionFailed' in info || 'responseStreamDisconnected' in info)) this.host.failed('network', { notify: true })
    if (!ok && turn.status === 'failed' && turn.error?.message) this.host.item({ kind: 'note', id: `${turn.id}-error`, ts: Date.now(), text: turn.error.message })
    const plan = ok && this.plan ? this.planText : undefined
    this.planText = undefined
    this.host.turnEnded({ id: `${turn.id}-result`, ok, durationMs: turn.durationMs ?? undefined, error: ok ? undefined : turn.status === 'interrupted' ? 'interrupted' : 'error_during_execution' })
    // A plan-mode turn that ended with a plan: the user approves it as Claude's ExitPlanMode would, and the agent goes on.
    if (plan?.trim()) { void this.planned(plan); return }
    // A Lead that ended a turn with an approved plan and nothing handed off gets one reminder, as Claude's Stop hook gives.
    const reminder = this.host.handoffAtStop()
    if (reminder) this.host.followUp(reminder)
  }

  private async planned(plan: string) {
    const result = await this.host.requestPlan(plan, { activity: 'Plan ready' })
    if (!result || this.isClosed && !this.host.chat()) return
    if (result.behavior === 'allow') { this.host.followUp(this.host.handoffAfterPlan() ?? PLAN_APPROVED); return }
    const text = result.behavior === 'answer' ? result.text : result.message
    if (text?.trim()) this.host.followUp(planChanges(text.trim()))
  }

  private async requested(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': return this.approveCommand(params as CommandExecutionRequestApprovalParams)
      case 'item/fileChange/requestApproval': return this.approveFiles(params as FileChangeRequestApprovalParams)
      case 'item/permissions/requestApproval': return this.approvePermissions(params as PermissionsRequestApprovalParams)
      case 'item/tool/requestUserInput': return this.question(params as ToolRequestUserInputParams)
      case 'item/tool/call': { const p = params as DynamicToolCallParams; return callTool(this.o.tools, p.tool, p.arguments) }
      case 'execCommandApproval': case 'applyPatchApproval': return { decision: 'denied' }
      default: throw new RpcError(`Kernel can't answer ${method}.`, -32601)
    }
  }

  /** A paused room's agent waits here, before its next step, as a Claude agent waits at its next tool call. */
  private async held() { const open = this.host.held(); if (open) await open }

  /**
   * A command Codex wants to run. Kernel's order (docs/decisions/KERNEL-406.md): Never allow and Network off decline, a room
   * rule accepts, Always ask asks, a request to leave the sandbox asks, then Ask mode asks and the other modes accept, inside
   * the sandbox.
   */
  private async approveCommand(p: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse> {
    await this.held()
    const perms = this.host.settings().permissions
    const command = unwrapShell(p.command ?? '')
    const leaves = !!(p.additionalPermissions || p.networkApprovalContext)
    // Codex's answer carries no reason, so a refusal shows in the chat, where the user sees why the step failed.
    if (perms.network === false && (usesNetwork(command) || p.networkApprovalContext)) return this.declined(NETWORK_OFF)
    const verdict = command ? bashVerdict(command, perms, this.host.roomAllow()) : undefined
    if (verdict === 'deny') return this.declined(`Kernel blocks "${command}" in every room.`)
    if (verdict === 'allow') return { decision: 'accept' }
    if (verdict !== 'ask' && !leaves && perms.mode !== 'ask') return { decision: 'accept' }
    const d = describeTool('Bash', { command })
    const result = await this.host.ask({ kind: 'tool', toolName: 'Bash', input: { command }, title: d.title, detail: p.reason ?? undefined, activity: d.title }, {})
    if (result?.behavior === 'allow') {
      if (result.always && command) this.host.allowInRoom(command.trim())
      return { decision: 'accept' }
    }
    return { decision: 'decline' }
  }

  private declined(why: string): CommandExecutionRequestApprovalResponse {
    this.host.item({ kind: 'note', id: `codex-declined-${Date.now()}`, ts: Date.now(), text: why })
    return { decision: 'decline' }
  }

  /** File edits accept in Accept edits and Bypass in worktrees, and ask in Ask, as Claude's do. Writes outside the workspace always ask. */
  private async approveFiles(p: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse> {
    await this.held()
    const perms = this.host.settings().permissions
    if (perms.mode !== 'ask' && !p.grantRoot) return { decision: 'accept' }
    const change = this.changes.get(p.itemId)
    const path = change?.changes[0]?.path ?? p.grantRoot ?? ''
    const name = change && change.changes.length === 1 && change.changes[0].kind.type === 'add' ? 'Write' : 'Edit'
    const d = describeTool(name, { file_path: path })
    const result = await this.host.ask({ kind: 'tool', toolName: name, input: { file_path: path }, title: d.title, detail: p.reason ?? undefined, activity: d.title }, {})
    return { decision: result?.behavior === 'allow' ? 'accept' : 'decline' }
  }

  /** More permissions than the sandbox gives, such as the network or another folder. Always the user's call, and Network off says no. */
  private async approvePermissions(p: PermissionsRequestApprovalParams): Promise<PermissionsRequestApprovalResponse> {
    const none: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' }
    if (this.host.settings().permissions.network === false && p.permissions.network) return none
    const title = p.permissions.network ? 'Allow network access' : 'Allow access outside the workspace'
    const result = await this.host.ask({ kind: 'tool', toolName: 'Permissions', input: p.permissions, title, detail: p.reason ?? undefined, activity: title }, {})
    if (result?.behavior !== 'allow') return none
    return { permissions: { ...(p.permissions.network ? { network: p.permissions.network } : {}), ...(p.permissions.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}) }, scope: 'turn' }
  }

  /** Codex's questions, as a Kernel question card like AskUserQuestion's. Answers go back by question id. */
  private async question(p: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
    const questions = p.questions.map((q) => ({ question: q.question, ...(q.header ? { header: q.header } : {}), options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) }))
    const first = questions[0]
    const result: Decision | undefined = await this.host.ask({ kind: 'question', toolName: 'AskUserQuestion', input: { questions }, title: first?.question ?? 'Question', options: first?.options.map((o) => o.label) ?? [], questions, activity: first?.question ?? 'Question' }, {})
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

/** The thread this chat resumed is gone, so Sessions starts a fresh one. */
class ThreadGone extends Error { constructor() { super('The Codex thread is gone.') } }

/** The tool's input for its row, with every long string clipped, nested ones too. */
function clip(v: unknown): unknown {
  return typeof v === 'string' ? v.slice(0, TEXT_MAX)
    : Array.isArray(v) ? v.map(clip)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]))
        : v
}
