import type { AgentDef, Approval, Task, TaskColumn, TaskState, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Store } from '../db'
import { bus } from '../bus'

/** What decides a task's column and state besides the task itself. */
export interface TaskContext {
  workspace?: Workspace
  agent?: Pick<AgentDef, 'role'>
  /** An approval for this task's workspace is waiting on the user. */
  approvalPending: boolean
}

/** PR states where the PR is open and someone is on it. */
const IN_REVIEW: Workspace['prState'][] = ['creating', 'draft', 'open', 'checks', 'resolving', 'merging']
/** PR states that stop the task until someone acts. */
const PR_BLOCKED: Workspace['prState'][] = ['cifail', 'changes', 'conflict']

/**
 * Where a task sits, from what is true now. Nothing here is a timer.
 * No workspace is Plan. A running workspace is Building, or QA when a QA agent holds it.
 * An open PR is Review, a merged one is Done. Failures block. A waiting approval needs the user.
 */
export function derive(task: Pick<Task, 'completedAt' | 'externalId'>, ctx: TaskContext): { column: TaskColumn; state: TaskState } {
  const ws = ctx.workspace
  if (ws?.prState === 'merged' || task.completedAt) return { column: 'done', state: 'done' }
  if (!ws) return task.externalId ? { column: 'build', state: ctx.approvalPending ? 'needs' : 'working' } : { column: 'plan', state: 'idle' }
  const build: TaskColumn = ctx.agent && /\bqa\b/i.test(ctx.agent.role) ? 'qa' : 'build'
  if (ws.status === 'failed') return { column: 'build', state: 'blocked' }
  if (PR_BLOCKED.includes(ws.prState)) return { column: 'review', state: 'blocked' }
  if (ws.prState === 'ready') return { column: 'review', state: 'needs' }
  if (IN_REVIEW.includes(ws.prState)) return { column: 'review', state: ctx.approvalPending ? 'needs' : 'working' }
  if (ws.status === 'archived') return { column: build, state: 'idle' }
  return { column: build, state: ctx.approvalPending ? 'needs' : 'working' }
}

/** The next id in a project: T-17 after T-16. Letters (T-15a) count for their number. */
export function nextTaskId(existing: Pick<Task, 'id'>[]): string {
  const top = existing.reduce((n, t) => Math.max(n, Number(/^T-(\d+)/.exec(t.id)?.[1] ?? 0)), 0)
  return `T-${String(top + 1).padStart(2, '0')}`
}

/** "T-15a" belongs to "T-15". */
const parentOf = (id: string) => /^(T-\d+)[a-z]$/.exec(id)?.[1]

/**
 * A project's tasks (KERNEL-18). Created from approved plans and from TaskCreated hooks, linked to
 * workspaces as the Lead hands them out, and moved only by real events: workspace, PR and approval changes.
 */
export class Tasks {
  private off: () => void = () => undefined

  constructor(private d: { store: Store; agents: (projectId: string) => AgentDef[] }) {}

  list(projectId: string): Task[] { return this.d.store.tasks(projectId) }

  /** Listen for the events that change a task. Call once. */
  attach() {
    const onPush = (e: PushEvent) => {
      if (e.type === 'approval') {
        if (e.approval.kind === 'plan' && e.approval.status === 'allowed') this.fromPlan(e.approval)
        if (e.approval.projectId) this.refresh(e.approval.projectId)
      } else if (e.type === 'workspace') this.refresh(e.workspace.projectId)
      else if (e.type === 'pr') { const ws = this.d.store.workspace(e.workspaceId); if (ws) this.refresh(ws.projectId) }
    }
    const onHook = (e: { hook_event_name: string; task_id?: string; task_subject?: string; task_description?: string; teammate_name?: string; team_name?: string; session_id?: string }, ctx: { projectId?: string; workspaceId?: string; agentId?: string }) => {
      if (!ctx.projectId || !e.task_id) return
      // Claude Code numbers tasks per task list, so two sessions or teams reuse the same ids. Key by list.
      const externalId = `${e.team_name ?? e.session_id ?? 'session'}/${e.task_id}`
      if (e.hook_event_name === 'TaskCreated') this.fromHook(ctx.projectId, 'created', { ...ctx, externalId, subject: e.task_subject, description: e.task_description, teammate: e.teammate_name })
      else if (e.hook_event_name === 'TaskCompleted') this.fromHook(ctx.projectId, 'completed', { ...ctx, externalId, subject: e.task_subject, description: e.task_description, teammate: e.teammate_name })
    }
    bus.on('push', onPush).on('hook', onHook)
    this.off = () => { bus.off('push', onPush).off('hook', onHook) }
  }

  detach() { this.off() }

  /** One task per step of an approved plan, in Plan until the Lead hands it to someone. Safe to call twice for one plan. */
  fromPlan(plan: Approval): Task[] {
    if (!plan.projectId || !plan.steps?.length) return []
    const made = this.list(plan.projectId).filter((t) => t.approvalId === plan.id)
    if (made.length) return made
    const out: Task[] = []
    const now = Date.now()
    for (const step of plan.steps) {
      const existing = this.list(plan.projectId)
      const wanted = step.taskId && !existing.some((t) => t.id === step.taskId) ? step.taskId : nextTaskId(existing)
      const title = step.taskId ? step.title.replace(new RegExp(`^${step.taskId}\\s*`), '').trim() || step.title : step.title
      const task = this.save({
        id: wanted, projectId: plan.projectId, title, column: 'plan', state: 'idle', agentId: step.agentId, parentId: parentOf(wanted),
        spec: plan.detail && plan.steps.length === 1 ? plan.detail : undefined, steps: [], approvalId: plan.id, createdAt: now, updatedAt: now
      })
      bus.activity({ kind: 'task.created', projectId: plan.projectId, taskId: task.id, actor: 'you', text: 'approved the plan', object: task.id })
      out.push(task)
    }
    return out
  }

  /**
   * The Lead created a workspace for `agentId`: the first waiting task for that agent in the latest plan is now being built.
   * `approvalIds` limits it to those plans, the ones approved in the Lead chat that handed it off (KERNEL-105).
   */
  link(projectId: string, agentId: string, workspaceId: string, o: { approvalIds?: Set<string> } = {}): Task | undefined {
    const waiting = this.list(projectId).filter((t) => t.approvalId && !t.workspaceId && t.agentId === agentId && (!o.approvalIds || o.approvalIds.has(t.approvalId)))
    const latest = Math.max(0, ...waiting.map((t) => t.createdAt))
    const task = waiting.filter((t) => t.createdAt === latest).sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }))[0]
    if (!task) return undefined
    const lead = this.d.agents(projectId).find((a) => a.lead)
    bus.activity({ kind: 'task.assigned', projectId, workspaceId, agentId: lead?.id, taskId: task.id, text: 'assigned it to', object: this.d.agents(projectId).find((a) => a.id === agentId)?.name ?? agentId })
    return this.refreshOne({ ...task, workspaceId })
  }

  /** A session outside Kernel made or finished a task. Its own id is kept so the second event finds the first. */
  fromHook(projectId: string, what: 'created' | 'completed', o: { externalId: string; subject?: string; description?: string; teammate?: string; workspaceId?: string; agentId?: string }): Task {
    const agents = this.d.agents(projectId)
    const who = o.teammate?.toLowerCase()
    const agentId = agents.find((a) => a.id === who || a.name.toLowerCase() === who)?.id ?? o.agentId
    const now = Date.now()
    const found = this.list(projectId).find((t) => t.externalId === o.externalId)
    const base: Task = found ?? {
      id: nextTaskId(this.list(projectId)), projectId, title: o.subject ?? o.externalId, column: 'build', state: 'working', agentId, workspaceId: o.workspaceId,
      spec: o.description, steps: [], externalId: o.externalId, createdAt: now, updatedAt: now
    }
    if (!found) bus.activity({ kind: 'task.created', projectId, workspaceId: o.workspaceId, agentId, taskId: base.id, text: 'started', object: base.title })
    if (what === 'completed' && !base.completedAt) {
      bus.activity({ kind: 'task.completed', projectId, workspaceId: o.workspaceId, agentId, taskId: base.id, text: 'finished', object: base.title })
      return this.refreshOne({ ...base, completedAt: now })
    }
    return this.refreshOne(base)
  }

  /**
   * Recompute every task in a project. Saves and pushes only those that moved. The project's pending approvals are read once,
   * not once per task, since every PR poll and workspace change lands here (KERNEL-216).
   */
  refresh(projectId: string) {
    const tasks = this.list(projectId)
    if (!tasks.length) return
    const pending = this.pendingIn(projectId)
    for (const t of tasks) this.refreshOne(t, pending)
  }

  /** The workspaces in a project with an approval waiting on the user. */
  private pendingIn(projectId: string) {
    return new Set(this.d.store.approvals({ projectId, pendingOnly: true }).flatMap((a) => (a.workspaceId ? [a.workspaceId] : [])))
  }

  private refreshOne(task: Task, pending = this.pendingIn(task.projectId)): Task {
    const store = this.d.store
    const ws = task.workspaceId ? store.workspace(task.workspaceId) : undefined
    const agent = this.d.agents(task.projectId).find((a) => a.id === (ws?.agentId ?? task.agentId))
    const approvalPending = !!ws && pending.has(ws.id)
    const { column, state } = derive(task, { workspace: ws, agent, approvalPending })
    const completedAt = column === 'done' ? task.completedAt ?? ws?.mergedAt ?? Date.now() : task.completedAt
    const prev = store.task(task.projectId, task.id)
    const next: Task = { ...task, agentId: ws?.agentId ?? task.agentId, column, state, completedAt }
    if (prev && prev.column === next.column && prev.state === next.state && prev.workspaceId === next.workspaceId && prev.agentId === next.agentId && prev.completedAt === next.completedAt) return prev
    if (prev && column === 'done' && prev.column !== 'done' && !task.externalId) {
      bus.activity({ kind: 'task.completed', projectId: task.projectId, workspaceId: ws?.id, agentId: next.agentId, taskId: task.id, text: 'merged', object: ws?.prNumber ? `#${ws.prNumber}` : task.id })
    }
    return this.save({ ...next, updatedAt: Date.now() })
  }

  private save(t: Task): Task {
    this.d.store.saveTask(t)
    bus.push({ type: 'task', task: t })
    return t
  }
}
