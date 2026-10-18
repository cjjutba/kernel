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

describe('attention counter (KERNEL-1060)', () => {
  it('counts what a plan with two tasks needed, a blocker and a merge each, and survives a restart', async () => {
    const { k, dir } = await boot()
    k.store.saveProject({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
    k.store.saveWorkspace(ws('w1'))
    k.store.saveWorkspace(ws('w2'))
    k.store.saveApproval(approval('plan', { kind: 'plan', toolName: undefined, steps: [{ title: 'one', workspaceId: 'w1' }, { title: 'two', workspaceId: 'w2' }] }))
    k.store.saveApproval(approval('t1', { workspaceId: 'w1' }))
    k.store.saveApproval(approval('q1', { kind: 'question', toolName: 'AskUserQuestion', workspaceId: 'w2', status: 'answered' }))
    k.store.saveApproval(approval('p1', { workspaceId: 'w2', toolName: 'ExitPlanMode' }))
    k.store.saveApproval(approval('gone', { workspaceId: 'w2', status: 'expired' }))
    k.store.saveApproval(approval('other', { workspaceId: 'elsewhere' }))
    for (const id of ['w1', 'w2']) {
      bus.push({ type: 'pr', workspaceId: id, state: 'cifail' })
      bus.push({ type: 'pr', workspaceId: id, state: 'ready' })
    }
    expect(k.attention.plan('plan')).toEqual({ prsMerged: 0, needed: 7, byKind: { plan: 1, tool: 1, question: 1, blocker: 2, merge: 2 }, finished: false })

    k.store.saveWorkspace(ws('w1', { prState: 'merged' }))
    expect(k.attention.plan('plan')).toMatchObject({ prsMerged: 1, finished: false })
    k.store.saveWorkspace(ws('w2', { prState: 'merged' }))
    k.store.saveWorkspace(ws('w1', { prState: 'merged', status: 'archived' }))
    k.notifications.prune()
    expect(k.attention.plan('plan')).toMatchObject({ prsMerged: 2, needed: 7, finished: true })

    await k.stop({ budgetMs: 0 })
    const again = await boot(dir)
    onTestFinished(() => again.k.stop({ budgetMs: 0 }))
    expect(again.k.attention.plan('plan')).toMatchObject({ prsMerged: 2, needed: 7, finished: true })
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
