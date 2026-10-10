import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { parseHook, permissionResponse, type HookPayload } from '@shared/hookSchemas'
import type { ActivityEvent } from '@shared/types'
import { bus } from '../bus'
import { describeTool, needsUser, type Approvals } from './approvals'
import { firstLine } from './text'

export interface HookContext { roomId?: string; workspaceId?: string; agentId?: string }

export interface HookServerOptions {
  port: number
  approvals: Approvals
  /** Map a session's cwd to the room and workspace it belongs to. */
  resolve: (cwd: string, sessionId: string) => HookContext
  /** Sessions Kernel started itself report through in-process hooks, so their posts here are ignored. */
  isManaged: (sessionId: string) => boolean
  /** A function so a change in Settings applies to the next request without restarting the server. */
  approvalTimeoutMs: number | (() => number)
}

/**
 * Receives Claude Code hooks on localhost, posted by the curl command the installer writes (D-050). Most events are fire and forget.
 * PermissionRequest from a session in a room is held open until the user decides in Kernel, the timeout passes,
 * or Claude Code stops waiting. The empty response lets Claude Code show its normal prompt in the terminal.
 */
export function startHookServer(o: HookServerOptions): Promise<Server> {
  const sessions = new Set<string>()
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true })
    if (req.method !== 'POST' || !req.url?.startsWith('/hooks')) return json(res, 404, { error: 'not found' })
    let body: unknown
    try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'invalid json' }) }
    const parsed = parseHook(body)
    if (!parsed.ok) { bus.emit('hook.invalid', parsed.error); return json(res, 200, {}) }
    const e = parsed.event
    if (o.isManaged(e.session_id)) return json(res, 200, {})
    const ctx = o.resolve(e.cwd, e.session_id)
    bus.emit('hook', e, ctx)
    // Kernel installs no SessionStart hook (D-047), so the first event from a new session stands in for it.
    if (e.hook_event_name === 'SessionEnd') sessions.delete(e.session_id)
    else if (!sessions.has(e.session_id)) {
      sessions.add(e.session_id)
      const start = toActivity({ ...e, hook_event_name: 'SessionStart' } as HookPayload, ctx)
      if (start && e.hook_event_name !== 'SessionStart') bus.activity(start)
    }
    if (!parsed.known) return json(res, 200, {})

    const ev = parsed.event as HookPayload
    if (ev.hook_event_name === 'PermissionRequest') {
      // A session outside every room asks in its own window, as if Kernel weren't installed (D-138).
      if (!ctx.roomId) return json(res, 200, permissionResponse(null))
      // A plan or a question belongs to the app that started the session, which answers it in its own window (KERNEL-285).
      if (needsUser(ev.tool_name)) return json(res, 200, permissionResponse(null))
      // Claude Code stops waiting when the user answers in the terminal or the session ends, so the approval ends too.
      const closed = new AbortController()
      res.on('close', () => { if (!res.writableFinished) closed.abort() })
      const { title, detail } = describeTool(ev.tool_name, ev.tool_input)
      // Room only: Kernel can't tell which chat an outside session belongs to, so it asks in Inbox and Home, never in a workspace's chats.
      const { decision } = o.approvals.request({ kind: 'tool', source: 'hook', roomId: ctx.roomId, toolName: ev.tool_name, input: ev.tool_input, title, detail }, { timeoutMs: typeof o.approvalTimeoutMs === 'function' ? o.approvalTimeoutMs() : o.approvalTimeoutMs, signal: closed.signal })
      const d = await decision
      if (!d) return json(res, 200, permissionResponse(null))
      if (d.behavior === 'allow') return json(res, 200, permissionResponse({ behavior: 'allow' }))
      return json(res, 200, permissionResponse({ behavior: 'deny', message: d.behavior === 'deny' ? d.message ?? 'Denied in Kernel' : d.text }))
    }
    const activity = toActivity(ev, ctx)
    if (activity) bus.activity(activity)
    return json(res, 200, {})
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, '127.0.0.1', () => resolve(server))
  })
}

/** Translate a hook into a log line for the room. Returns null for events the logs do not show. */
export function toActivity(e: HookPayload, ctx: HookContext): Omit<ActivityEvent, 'id' | 'ts'> | null {
  const base = { ...ctx, sessionId: e.session_id }
  switch (e.hook_event_name) {
    case 'SessionStart': return { ...base, kind: 'session.start', text: 'started a session' }
    case 'SessionEnd': return { ...base, kind: 'session.end', text: 'ended the session', data: { reason: e.reason } }
    case 'UserPromptSubmit': return { ...base, kind: 'prompt', text: 'got a message', data: { prompt: e.prompt.slice(0, 280) } }
    case 'PreToolUse': {
      // A subagent delegation is one agent talking to another: the floor walks the speaker to the listener (KERNEL-24).
      const input = (e.tool_input ?? {}) as Record<string, unknown>
      if ((e.tool_name === 'Task' || e.tool_name === 'Agent') && typeof input.subagent_type === 'string') {
        const line = typeof input.description === 'string' ? input.description : typeof input.prompt === 'string' ? input.prompt : ''
        return { ...base, kind: 'agent.talk', text: 'delegated to', object: input.subagent_type, quote: line.slice(0, 280) || undefined, data: { from: ctx.agentId, to: input.subagent_type, line: firstLine(line), toolUseId: e.tool_use_id } }
      }
      if (quiet(e.tool_name)) return null
      return { ...base, kind: 'tool.start', text: verb(e.tool_name), object: objectOf(e.tool_name, e.tool_input), data: { tool: e.tool_name, toolUseId: e.tool_use_id } }
    }
    case 'PostToolUse': return quiet(e.tool_name) ? null : { ...base, kind: 'tool.end', text: verb(e.tool_name, true), object: objectOf(e.tool_name, e.tool_input), data: { tool: e.tool_name, toolUseId: e.tool_use_id, durationMs: e.duration_ms } }
    case 'PostToolUseFailure': return e.tool_name === 'ToolSearch' ? null : { ...base, kind: 'tool.failed', text: `failed to ${failVerb[e.tool_name] ?? 'use'}`, object: objectOf(e.tool_name, e.tool_input), data: { tool: e.tool_name, toolUseId: e.tool_use_id } }
    case 'Stop': return { ...base, kind: 'turn.done', text: 'finished its turn' }
    case 'Notification': return { ...base, kind: 'note', text: e.message }
    case 'TaskCreated': return { ...base, kind: 'task.created', text: 'created', object: e.task_subject, data: { taskId: e.task_id, teammate: e.teammate_name } }
    case 'TaskCompleted': return { ...base, kind: 'task.completed', text: 'completed', object: e.task_subject, data: { taskId: e.task_id, teammate: e.teammate_name } }
    case 'TeammateIdle': return { ...base, kind: 'agent.status', text: `${e.teammate_name} is idle`, data: { teammate: e.teammate_name, status: 'idle' } }
    default: return null
  }
}

const verb = (tool: string, past = false) => {
  const v: Record<string, [string, string]> = { Read: ['is reading', 'read'], Edit: ['is editing', 'edited'], MultiEdit: ['is editing', 'edited'], Write: ['is writing', 'wrote'], Bash: ['is running', 'ran'], Grep: ['is searching', 'searched'], Glob: ['is looking for', 'found'], WebFetch: ['is fetching', 'fetched'], Task: ['delegated', 'delegated'] }
  return (v[tool] ?? ['is using', 'used'])[past ? 1 : 0]
}
const failVerb: Record<string, string> = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'write', Bash: 'run', Grep: 'search for', Glob: 'find', WebFetch: 'fetch' }

/**
 * Tool calls the logs leave out when they start and end. ToolSearch only loads other tools.
 * Kernel's own tools log a line of their own (assigned, messaged, asked you to review), so their calls would say it twice.
 */
const quiet = (tool: string) => tool === 'ToolSearch' || tool.startsWith('mcp__kernel__')

const objectOf = (tool: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, any>
  if (i.file_path) return String(i.file_path).split('/').pop()!
  // The whole first line: the logs cut it to fit and show the rest on hover.
  if (tool === 'Bash' && i.command) return String(i.command).trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 160)
  if (i.pattern) return String(i.pattern)
  if (i.url) return String(i.url)
  return tool.startsWith('mcp__') ? tool.split('__').pop()! : describeTool(tool, input).title
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 5_000_000) req.destroy() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
