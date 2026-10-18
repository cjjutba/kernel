import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, Workspace } from '../src/shared/types'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { freePort } from './helpers'

const ws = (id: string, extra: Partial<Workspace> = {}) => ({ id, projectId: 'p', name: id, branch: id, baseRef: 'main', path: '/x', mode: 'worktree', agentId: 'sean', port: 1, status: 'ready', prState: 'open', prNumber: 1, createdAt: 1, ...extra }) as Workspace
const approval = (id: string, extra: Partial<Approval> = {}): Approval => ({ id, kind: 'tool', source: 'sdk', projectId: 'p', toolName: 'Bash', title: 'Run it', status: 'allowed', createdAt: 2, ...extra })

async function boot(dataDir?: string) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'kernel-data-')))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt') }))
  const k = new Kernel({ dataDir: dir, home })
  await k.start()
  return { k, dir }
}

describe('attention counter (KERNEL-1060, KERNEL-1067)', () => {
  it('counts what the user decided, including review workspaces, and survives a restart', async () => {
    const { k, dir } = await boot()
    k.store.saveProject({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
    k.store.saveWorkspace(ws('w1'))
    k.store.saveWorkspace(ws('w2'))
    k.store.saveWorkspace(ws('r1', { reviewOf: 'w1', prState: undefined }))
    k.store.saveWorkspace(ws('r-other', { reviewOf: 'elsewhere', prState: undefined }))
    k.store.saveApproval(approval('plan', { kind: 'plan', toolName: undefined, steps: [{ title: 'one', workspaceId: 'w1' }, { title: 'two', workspaceId: 'w2' }] }))
    k.store.saveApproval(approval('t1', { workspaceId: 'w1' }))
    k.store.saveApproval(approval('t2', { workspaceId: 'r1' }))
    k.store.saveApproval(approval('t3', { workspaceId: 'r1', status: 'denied' }))
    k.store.saveApproval(approval('q1', { kind: 'question', toolName: 'AskUserQuestion', workspaceId: 'w2', status: 'answered' }))
    k.store.saveApproval(approval('p1', { workspaceId: 'w2', toolName: 'ExitPlanMode' }))
    k.store.saveApproval(approval('gone', { workspaceId: 'w2', status: 'expired' }))
    k.store.saveApproval(approval('waiting', { workspaceId: 'r1', status: 'pending' }))
    k.store.saveApproval(approval('other', { workspaceId: 'elsewhere' }))
    // Lead questions: only an answered one that names the plan's work counts.
    k.store.saveApproval(approval('lq1', { kind: 'question', toolName: undefined, workspaceId: 'lead', status: 'answered', about: ['r1'] }))
    k.store.saveApproval(approval('lq2', { kind: 'question', toolName: undefined, workspaceId: 'lead', status: 'answered' }))
    k.store.saveApproval(approval('lq3', { kind: 'question', toolName: undefined, workspaceId: 'lead', status: 'answered', about: ['elsewhere'] }))
    k.store.saveApproval(approval('lq4', { kind: 'question', toolName: undefined, workspaceId: 'lead', status: 'expired', about: ['w1'] }))
    k.store.saveApproval(approval('other-review', { workspaceId: 'r-other' }))
    // Rows the teammate settled leave no mark.
    for (const id of ['w1', 'w2']) {
      bus.push({ type: 'pr', workspaceId: id, state: 'cifail' })
      bus.push({ type: 'pr', workspaceId: id, state: 'ready' })
    }
    expect(k.attention.plan('plan')).toEqual({ prsMerged: 0, needed: 6, byKind: { plan: 1, tool: 3, question: 2, blocker: 0, merge: 0 }, finished: false })

    // w1 merged by the user, w2 by auto-merge, which never calls userMerging.
    k.store.saveWorkspace(ws('w1', { prState: 'merged' }))
    k.attention.userMerging('w1')
    k.store.saveWorkspace(ws('w2', { prState: 'merged' }))
    expect(k.attention.plan('plan')).toEqual({ prsMerged: 2, needed: 7, byKind: { plan: 1, tool: 3, question: 2, blocker: 0, merge: 1 }, finished: true })

    k.store.saveWorkspace(ws('w1', { prState: 'merged', status: 'archived' }))
    await k.stop({ budgetMs: 0 })
    const again = await boot(dir)
    onTestFinished(() => again.k.stop({ budgetMs: 0 }))
    expect(again.k.attention.plan('plan')).toMatchObject({ prsMerged: 2, needed: 7, finished: true })
  })

  it('counts a user merge once the PR reads as merged, not before', async () => {
    const { k } = await boot()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    k.store.saveWorkspace(ws('w1'))
    k.store.saveApproval(approval('plan', { kind: 'plan', toolName: undefined, steps: [{ title: 'one', workspaceId: 'w1' }] }))
    k.attention.userMerging('w1')
    expect(k.attention.plan('plan').byKind.merge).toBe(0)
    // The refresh after the merge failed or lagged: the PR reads as merged later, and the user's merge counts then.
    k.store.saveWorkspace(ws('w1', { prState: 'merged' }))
    expect(k.attention.plan('plan').byKind.merge).toBe(1)
  })

  it('reports a plan with a task not yet handed off as not finished', async () => {
    const { k } = await boot()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    k.store.saveWorkspace(ws('w1', { prState: 'merged' }))
    k.store.saveApproval(approval('plan', { kind: 'plan', toolName: undefined, steps: [{ title: 'one', workspaceId: 'w1' }, { title: 'two' }] }))
    expect(k.attention.plan('plan')).toMatchObject({ prsMerged: 1, needed: 0, finished: false })
    expect(() => k.attention.plan('missing')).toThrow()
  })
})
