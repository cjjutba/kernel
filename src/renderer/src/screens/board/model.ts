import type { ActivityEvent, AgentDef, Approval, PrState, Task, TaskColumn, Workspace } from '@shared/types'

export const COLUMNS: { key: TaskColumn; name: string; gate: boolean }[] = [
  { key: 'spec', name: 'Spec', gate: true },
  { key: 'plan', name: 'Plan', gate: true },
  { key: 'build', name: 'Building', gate: false },
  { key: 'qa', name: 'QA', gate: false },
  { key: 'review', name: 'Review', gate: true },
  { key: 'done', name: 'Done', gate: false }
]

export const columnName = (c: TaskColumn) => COLUMNS.find((x) => x.key === c)?.name ?? c

const prWords: Partial<Record<PrState, string>> = {
  creating: 'opening', draft: 'draft', open: 'open', checks: 'checks running', cifail: 'checks failing', changes: 'changes requested',
  conflict: 'merge conflict', resolving: 'resolving conflicts', ready: 'ready to merge', merging: 'merging', merged: 'merged', closed: 'closed'
}

/** "#41 · ready to merge", or nothing before a PR exists. */
export function prLine(ws?: Workspace): string | undefined {
  if (!ws?.prNumber) return undefined
  const word = prWords[ws.prState]
  return word ? `#${ws.prNumber} · ${word}` : `#${ws.prNumber}`
}

/** Why a blocked task is blocked, from the facts on its workspace. */
export function blockedReason(ws?: Workspace): string {
  if (ws?.status === 'failed') return 'Setup failed'
  if (ws?.prState === 'cifail') return 'Checks failing'
  if (ws?.prState === 'changes') return 'Changes requested'
  if (ws?.prState === 'conflict') return 'Merge conflict'
  return 'Blocked'
}

/** The small tag on a card: only states that need a person's eye get one. */
export function cardTag(t: Task, ws?: Workspace): string | undefined {
  if (t.state === 'needs') return 'Needs you'
  if (t.state === 'blocked') return blockedReason(ws)
  return undefined
}

/** The mono line at the foot of a card: branch while building, the PR in review, the PR title once done. */
export function cardMeta(t: Task, ws?: Workspace): string | undefined {
  if (!ws) return undefined
  if (t.column === 'review') return ws.prNumber ? `PR ${prLine(ws)}` : ws.branch
  if (t.column === 'done') return ws.prTitle ?? ws.branch
  if (t.column === 'build' || t.column === 'qa') return ws.branch
  return undefined
}

/** What is waiting on whom, for the drawer's Gate row. */
export function gateText(t: Task, ws: Workspace | undefined, approvals: Approval[]): string {
  if (ws && approvals.some((a) => a.status === 'pending' && a.workspaceId === ws.id)) return 'Waiting for your approval'
  if (t.state === 'blocked') return blockedReason(ws)
  if (t.state === 'needs' && ws?.prState === 'ready') return 'Ready for you to merge'
  if (t.column === 'plan') return 'Waiting for Rowan to hand it out'
  return 'None right now'
}

export type StepState = 'done' | 'in progress' | 'in review' | 'next'

/** The approved plan this task came from, each step with where its task is now. */
export function planSteps(task: Task, all: Task[]): { id: string; text: string; state: StepState; current: boolean }[] {
  const group = task.approvalId ? all.filter((x) => x.approvalId === task.approvalId) : []
  if (group.length) {
    return group.map((x) => ({
      id: x.id, text: x.title, current: x.id === task.id,
      state: x.column === 'done' ? 'done' : x.column === 'review' ? 'in review' : x.column === 'plan' ? 'next' : 'in progress'
    }))
  }
  return task.steps.map((s, i) => ({ id: String(i), text: s.text, current: false, state: s.state === 'doing' ? 'in progress' : s.state }))
}

/** Events for this task: logged against it, or against the workspace that builds it. Newest first. */
export function taskActivity(task: Task, events: ActivityEvent[], limit = 20): ActivityEvent[] {
  return events
    .filter((e) => e.kind !== 'agent.say' && (e.taskId === task.id || (!!task.workspaceId && e.workspaceId === task.workspaceId && e.kind !== 'tool.start' && e.kind !== 'tool.end')))
    .filter((e) => !e.roomId || e.roomId === task.roomId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}

/** "Kai added empty states", "You approved the plan". */
export function activityLine(e: ActivityEvent, agents: AgentDef[]): string {
  const who = e.actor === 'you' ? 'You' : e.actor === 'kernel' ? 'Kernel' : agents.find((a) => a.id === e.agentId)?.name ?? 'Someone'
  return [who, e.text, e.object].filter(Boolean).join(' ')
}

export const clock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
