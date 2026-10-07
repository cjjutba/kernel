import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Approval, Workspace } from '../src/shared/types'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { Tasks, derive, nextTaskId } from '../src/main/services/tasks'

const agent = (id: string, name: string, role: string, lead = false): AgentDef => ({ id, name, role, description: '', lead, prompt: '', file: `.claude/agents/${id}.md` })
const agents = [agent('rowan', 'Rowan', 'Lead', true), agent('kai', 'Kai', 'Frontend'), agent('ivy', 'Ivy', 'QA')]
const ws = (extra: Partial<Workspace> = {}): Workspace => ({ id: 'w1', roomId: 'r', name: 'invoice-table', branch: 'wt/t-14', baseRef: 'main', path: '/x', mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'none', createdAt: 1, ...extra })

const open: Tasks[] = []
afterEach(() => { open.forEach((t) => t.detach()); open.length = 0 })

async function setup() {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-t-')), 'k.db'))
  store.saveRoom({ id: 'r', name: 'Client A', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
  const tasks = new Tasks({ store, agents: () => agents })
  tasks.attach()
  open.push(tasks)
  return { store, tasks }
}

const plan = (extra: Partial<Approval> = {}): Approval => ({
  id: 'p1', kind: 'plan', source: 'sdk', roomId: 'r', agentId: 'rowan', title: 'T-15 Export invoices as PDF', status: 'allowed', createdAt: 1,
  steps: [{ title: 'T-15a PDF renderer', taskId: 'T-15a', agentId: 'kai' }, { title: 'T-15b Snapshot tests', taskId: 'T-15b', agentId: 'ivy' }, { title: 'Write the release note', agentId: 'kai' }], ...extra
})

describe('task status', () => {
  const t = {}
  it('waits in Plan until a workspace exists', () => {
    expect(derive(t, { approvalPending: false })).toEqual({ column: 'plan', state: 'idle' })
  })
  it('builds while the workspace runs, and in QA for a QA agent', () => {
    expect(derive(t, { workspace: ws(), agent: { role: 'Frontend' }, approvalPending: false })).toEqual({ column: 'build', state: 'working' })
    expect(derive(t, { workspace: ws({ status: 'setup' }), agent: { role: 'QA' }, approvalPending: false })).toEqual({ column: 'qa', state: 'working' })
  })
  it('needs CJ while an approval waits, and a failed setup blocks', () => {
    expect(derive(t, { workspace: ws(), approvalPending: true })).toEqual({ column: 'build', state: 'needs' })
    expect(derive(t, { workspace: ws({ status: 'failed' }), approvalPending: false })).toEqual({ column: 'build', state: 'blocked' })
  })
  it('moves to Review when a PR opens, and blocks on failing checks, conflicts or requested changes', () => {
    expect(derive(t, { workspace: ws({ prState: 'open' }), approvalPending: false })).toEqual({ column: 'review', state: 'working' })
    expect(derive(t, { workspace: ws({ prState: 'ready' }), approvalPending: false })).toEqual({ column: 'review', state: 'needs' })
    for (const prState of ['cifail', 'conflict', 'changes'] as const) expect(derive(t, { workspace: ws({ prState }), approvalPending: false })).toEqual({ column: 'review', state: 'blocked' })
  })
  it('is Done once merged, even after the workspace is archived', () => {
    expect(derive(t, { workspace: ws({ prState: 'merged', status: 'archived' }), approvalPending: false })).toEqual({ column: 'done', state: 'done' })
  })
  it('goes back to Building when its PR is closed without merging', () => {
    expect(derive(t, { workspace: ws({ prState: 'closed' }), approvalPending: false })).toEqual({ column: 'build', state: 'working' })
  })
  it('numbers tasks per room', () => {
    expect(nextTaskId([])).toBe('T-01')
    expect(nextTaskId([{ id: 'T-14' }, { id: 'T-15a' }, { id: 'T-09' }])).toBe('T-16')
  })
})

describe('tasks service', () => {
  it('creates a task for each step of an approved plan, keeping step ids and numbering the rest', async () => {
    const { tasks } = await setup()
    bus.push({ type: 'approval', approval: plan() })
    const list = tasks.list('r')
    expect(list.map((x) => [x.id, x.title, x.column, x.parentId, x.agentId])).toEqual([
      ['T-15a', 'PDF renderer', 'plan', 'T-15', 'kai'], ['T-15b', 'Snapshot tests', 'plan', 'T-15', 'ivy'], ['T-16', 'Write the release note', 'plan', undefined, 'kai']
    ])
    bus.push({ type: 'approval', approval: plan() })
    expect(tasks.list('r')).toHaveLength(3)
  })

  it('ignores plans that are pending, denied or have no steps', async () => {
    const { tasks } = await setup()
    bus.push({ type: 'approval', approval: plan({ status: 'pending' }) })
    bus.push({ type: 'approval', approval: plan({ id: 'p2', status: 'allowed', steps: undefined }) })
    expect(tasks.list('r')).toEqual([])
  })

  it('links the next waiting task for an agent, then follows the workspace and its PR', async () => {
    const { store, tasks } = await setup()
    bus.push({ type: 'approval', approval: plan() })
    store.saveWorkspace(ws({ id: 'w1', agentId: 'kai' }))
    expect(tasks.link('r', 'kai', 'w1')).toMatchObject({ id: 'T-15a', workspaceId: 'w1', column: 'build', state: 'working' })
    store.saveWorkspace(ws({ id: 'w2', agentId: 'kai' }))
    expect(tasks.link('r', 'kai', 'w2')).toMatchObject({ id: 'T-16', workspaceId: 'w2' })
    expect(tasks.link('r', 'kai', 'w3')).toBeUndefined()

    const saved = store.workspace('w1')!
    store.saveWorkspace({ ...saved, prState: 'open', prNumber: 41 })
    bus.push({ type: 'pr', workspaceId: 'w1', state: 'open' })
    expect(store.task('r', 'T-15a')).toMatchObject({ column: 'review', state: 'working' })

    store.saveWorkspace({ ...store.workspace('w1')!, prState: 'merged', mergedAt: 99 })
    bus.push({ type: 'pr', workspaceId: 'w1', state: 'merged' })
    expect(store.task('r', 'T-15a')).toMatchObject({ column: 'done', state: 'done', completedAt: 99 })
  })

  it('shows Needs you while an approval for the workspace waits, and clears it when decided', async () => {
    const { store, tasks } = await setup()
    bus.push({ type: 'approval', approval: plan() })
    store.saveWorkspace(ws())
    tasks.link('r', 'kai', 'w1')
    const ask: Approval = { id: 'a1', kind: 'tool', source: 'sdk', roomId: 'r', workspaceId: 'w1', agentId: 'kai', title: 'Run pnpm install', status: 'pending', createdAt: 2 }
    store.saveApproval(ask)
    bus.push({ type: 'approval', approval: ask })
    expect(store.task('r', 'T-15a')?.state).toBe('needs')
    store.saveApproval({ ...ask, status: 'allowed' })
    bus.push({ type: 'approval', approval: { ...ask, status: 'allowed' } })
    expect(store.task('r', 'T-15a')?.state).toBe('working')
  })

  it('pushes a task event when a task moves, and not when nothing changed', async () => {
    const { store, tasks } = await setup()
    bus.push({ type: 'approval', approval: plan() })
    store.saveWorkspace(ws())
    tasks.link('r', 'kai', 'w1')
    const seen: string[] = []
    const on = (e: { type: string; task?: { id: string } }) => { if (e.type === 'task') seen.push(e.task!.id) }
    bus.on('push', on)
    tasks.refresh('r')
    expect(seen).toEqual([])
    store.saveWorkspace({ ...ws(), prState: 'open' })
    tasks.refresh('r')
    bus.off('push', on)
    expect(seen).toEqual(['T-15a'])
  })

  it('makes and closes tasks from hooks of sessions outside Kernel', async () => {
    const { tasks, store } = await setup()
    const ctx = { roomId: 'r', workspaceId: undefined, agentId: undefined }
    bus.emit('hook', { hook_event_name: 'TaskCreated', task_id: 'abc', session_id: 's1', task_subject: 'Fix the login redirect', teammate_name: 'kai' }, ctx)
    expect(tasks.list('r')).toMatchObject([{ id: 'T-01', title: 'Fix the login redirect', column: 'build', state: 'working', agentId: 'kai', externalId: 's1/abc' }])
    bus.emit('hook', { hook_event_name: 'TaskCreated', task_id: 'abc', session_id: 's1', task_subject: 'Fix the login redirect' }, ctx)
    expect(tasks.list('r')).toHaveLength(1)
    bus.emit('hook', { hook_event_name: 'TaskCompleted', task_id: 'abc', session_id: 's1', task_subject: 'Fix the login redirect' }, ctx)
    expect(store.task('r', 'T-01')).toMatchObject({ column: 'done', state: 'done' })
    expect(store.task('r', 'T-01')?.completedAt).toBeTypeOf('number')
  })

  it('keeps tasks from different sessions and teams apart when they reuse an id', async () => {
    const { tasks, store } = await setup()
    const ctx = { roomId: 'r' }
    bus.emit('hook', { hook_event_name: 'TaskCreated', task_id: '1', task_subject: 'First', session_id: 's1' }, ctx)
    bus.emit('hook', { hook_event_name: 'TaskCreated', task_id: '1', task_subject: 'Second', session_id: 's2' }, ctx)
    bus.emit('hook', { hook_event_name: 'TaskCreated', task_id: '1', task_subject: 'Third', session_id: 's3', team_name: 'blue' }, ctx)
    expect(tasks.list('r').map((t) => t.title)).toEqual(['First', 'Second', 'Third'])
    bus.emit('hook', { hook_event_name: 'TaskCompleted', task_id: '1', task_subject: 'Second', session_id: 's2' }, ctx)
    expect(tasks.list('r').map((t) => t.column)).toEqual(['build', 'done', 'build'])
    expect(store.task('r', 'T-01')?.completedAt).toBeUndefined()
  })

  it('opens a task for a completion it never saw created, and ignores hooks without a room', async () => {
    const { tasks } = await setup()
    bus.emit('hook', { hook_event_name: 'TaskCompleted', task_id: 'x1', task_subject: 'Tidy imports' }, { roomId: 'r' })
    bus.emit('hook', { hook_event_name: 'TaskCreated', task_id: 'x2', task_subject: 'Elsewhere' }, {})
    expect(tasks.list('r')).toMatchObject([{ title: 'Tidy imports', column: 'done' }])
  })
})
