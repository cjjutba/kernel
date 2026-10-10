import { randomUUID } from 'node:crypto'
import type { Approval, Decision, PlanStep } from '@shared/types'
import type { Store } from '../db'
import { bus } from '../bus'

type Pending = { resolve: (d: Decision | null) => void; timer?: NodeJS.Timeout }

/**
 * One queue for everything that needs the user: tool permissions (from canUseTool or the PermissionRequest
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
    const prev = this.store?.approval(id)
    if (!prev) return undefined
    const next = { ...prev, ...patch }
    this.store?.saveApproval(next)
    bus.push({ type: 'approval', approval: next })
    return next
  }

  /**
   * At start: every approval saved as pending belongs to an earlier run, whose waiter is gone, so nobody can answer it
   * (D-137). Each one is marked expired. Call before `Notifications.attach()`, which then settles their rows.
   */
  expireStale(): Approval[] {
    return (this.store?.approvals({ pendingOnly: true }) ?? []).filter((a) => !this.pending.has(a.id)).map((a) => this.expire(a))
  }

  /**
   * An archived workspace's pending approvals end (D-137). One with a waiter resolves null, so its session or hook falls
   * back instead of waiting on a workspace that is gone.
   */
  expireWorkspace(workspaceId: string): Approval[] {
    return (this.store?.approvals({ workspaceId, pendingOnly: true }) ?? []).map((a) => this.finish(a.id, null, 'expired') ?? this.expire(a))
  }

  private expire(a: Approval): Approval {
    const next: Approval = { ...a, status: 'expired' }
    this.store?.saveApproval(next)
    bus.push({ type: 'approval', approval: next })
    bus.activity({ kind: 'approval.decided', roomId: next.roomId, workspaceId: next.workspaceId, agentId: next.agentId, text: `expired ${next.title}`, object: next.toolName })
    return next
  }

  private finish(id: string, decision: Decision | null, status: Approval['status']): Approval | undefined {
    const p = this.pending.get(id)
    if (!p) return undefined
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve(decision)
    const prev = this.store?.approval(id)
    if (!prev) return undefined
    const answered = decision?.behavior === 'answer' ? decision : undefined
    const next: Approval = { ...prev, status, answer: answered ? answered.text : prev.answer, answers: answered?.answers ?? prev.answers }
    this.store?.saveApproval(next)
    bus.push({ type: 'approval', approval: next })
    bus.activity({ kind: 'approval.decided', roomId: next.roomId, workspaceId: next.workspaceId, agentId: next.agentId, text: `${status} ${next.title}`, object: next.toolName })
    return next
  }
}

/** Tools that are a question to the user, not a permission. No setting may answer them for the user. */
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
    case 'mcp__kernel__share_file': return { title: `Share ${String(i.path ?? '').split('/').pop()}` }
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
