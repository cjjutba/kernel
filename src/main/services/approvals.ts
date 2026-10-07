import { randomUUID } from 'node:crypto'
import type { Approval, Decision, PlanStep } from '@shared/types'
import type { Store } from '../db'
import { bus } from '../bus'

type Pending = { resolve: (d: Decision | null) => void; timer?: NodeJS.Timeout }

/**
 * One queue for everything that needs CJ: tool permissions (from canUseTool or the PermissionRequest
 * hook), plan approvals and questions from Rowan. request() waits until decide() is called, or the timeout
 * passes and it resolves null so the caller can fall back (hooks fall back to Claude Code's own prompt).
 */
export class Approvals {
  private pending = new Map<string, Pending>()
  constructor(private store?: Store) {}

  request(a: Omit<Approval, 'id' | 'status' | 'createdAt'>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): { approval: Approval; decision: Promise<Decision | null> } {
    const approval: Approval = { ...a, id: randomUUID(), status: 'pending', createdAt: Date.now() }
    this.store?.saveApproval(approval)
    bus.push({ type: 'approval', approval })
    bus.activity({ kind: 'approval.requested', roomId: a.roomId, workspaceId: a.workspaceId, agentId: a.agentId, text: a.title, object: a.toolName })
    const decision = new Promise<Decision | null>((resolve) => {
      const entry: Pending = { resolve }
      if (opts.timeoutMs) entry.timer = setTimeout(() => this.finish(approval.id, null, 'expired'), opts.timeoutMs)
      opts.signal?.addEventListener('abort', () => this.finish(approval.id, null, 'expired'), { once: true })
      this.pending.set(approval.id, entry)
    })
    return { approval, decision }
  }

  decide(id: string, decision: Decision): Approval | undefined {
    const status = decision.behavior === 'allow' ? 'allowed' : decision.behavior === 'deny' ? 'denied' : 'answered'
    return this.finish(id, decision, status)
  }

  isPending(id: string) { return this.pending.has(id) }

  /** Change a saved approval and tell every window, for example to link a plan step to the workspace it was handed to. */
  update(id: string, patch: Partial<Approval>): Approval | undefined {
    const prev = this.store?.approvals().find((x) => x.id === id)
    if (!prev) return undefined
    const next = { ...prev, ...patch }
    this.store?.saveApproval(next)
    bus.push({ type: 'approval', approval: next })
    return next
  }

  private finish(id: string, decision: Decision | null, status: Approval['status']): Approval | undefined {
    const p = this.pending.get(id)
    if (!p) return undefined
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve(decision)
    const prev = this.store?.approvals().find((x) => x.id === id)
    if (!prev) return undefined
    const next: Approval = { ...prev, status, answer: decision && decision.behavior === 'answer' ? decision.text : prev.answer }
    this.store?.saveApproval(next)
    bus.push({ type: 'approval', approval: next })
    bus.activity({ kind: 'approval.decided', roomId: next.roomId, workspaceId: next.workspaceId, agentId: next.agentId, text: `${status} ${next.title}`, object: next.toolName })
    return next
  }
}

/** Tools that are a question to CJ, not a permission. No setting may answer them for him. */
export const needsUser = (toolName: string) => toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion'

/** "T-15a PDF renderer · Noor" becomes a step with the agent's id. Lines without a known name stay as plain text. */
export function parsePlanSteps(lines: string[], agents: { id: string; name: string }[]): PlanStep[] {
  return lines.map((line) => {
    const at = line.lastIndexOf(' · ')
    const agent = at < 0 ? undefined : agents.find((a) => a.name.toLowerCase() === line.slice(at + 3).trim().toLowerCase() || a.id === line.slice(at + 3).trim().toLowerCase())
    const title = agent ? line.slice(0, at).trim() : line.trim()
    const id = /^(T-\d+[a-z]?)\b/.exec(title)?.[1]
    return { title, ...(id ? { taskId: id } : {}), ...(agent ? { agentId: agent.id } : {}) }
  })
}

/** Short human title for a tool call, used in the Inbox and on the floor card. */
export function describeTool(toolName: string, input: unknown): { title: string; detail?: string } {
  const i = (input ?? {}) as Record<string, any>
  switch (toolName) {
    case 'Bash': return { title: `Run ${String(i.command ?? '').split('\n')[0].slice(0, 80)}`, detail: i.description }
    case 'Edit': case 'Write': case 'MultiEdit': return { title: `${toolName} ${i.file_path ?? ''}` }
    case 'WebFetch': return { title: `Fetch ${i.url ?? ''}` }
    default: return { title: toolName.startsWith('mcp__') ? toolName.split('__').slice(1).join(' · ') : toolName }
  }
}

/** Match a Bash command against Settings > Permissions lists (simple substring and * wildcard). */
export function matchesRule(command: string, rules: string[]): string | undefined {
  const c = command.trim()
  return rules.find((r) => {
    if (r.includes('*')) return new RegExp('^' + r.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(c)
    return c === r || c.startsWith(r + ' ') || c.includes(r)
  })
}
