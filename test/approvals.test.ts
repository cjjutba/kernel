import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'

const tempStore = async () => new Store(join(await mkdtemp(join(tmpdir(), 'kernel-approvals-')), 'kernel.db'))

describe('how a request ends (KERNEL-446)', () => {
  it("gives the waiter the user's answer and saves it on the row", async () => {
    const store = await tempStore()
    const approvals = new Approvals(store)
    const yes = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run pnpm db:reset' })
    const no = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run rm -rf dist' })
    approvals.decide(yes.approval.id, { behavior: 'allow' })
    approvals.decide(no.approval.id, { behavior: 'deny', message: 'Not today.' })
    expect(await yes.decision).toEqual({ behavior: 'allow' })
    expect(await no.decision).toEqual({ behavior: 'deny', message: 'Not today.' })
    expect(store.approval(yes.approval.id)?.status).toBe('allowed')
    expect(store.approval(no.approval.id)?.status).toBe('denied')
  })

  it('expires when its time runs out or its signal aborts, and the waiter gets null', async () => {
    const store = await tempStore()
    const approvals = new Approvals(store)
    const slow = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run pnpm db:reset' }, { timeoutMs: 20 })
    expect(await slow.decision).toBeNull()
    const abort = new AbortController()
    const dropped = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run rm -rf dist' }, { signal: abort.signal })
    abort.abort()
    expect(await dropped.decision).toBeNull()
    expect([slow, dropped].map((r) => store.approval(r.approval.id)?.status)).toEqual(['expired', 'expired'])
    // An answer that comes after the row expired reaches nobody and changes nothing.
    expect(approvals.decide(slow.approval.id, { behavior: 'allow' })).toBeUndefined()
    expect(store.approval(slow.approval.id)?.status).toBe('expired')
  })
})

describe('approvals whose turn or session is gone (KERNEL-563)', () => {
  it('expires the ones still waiting, marks an orphaned row expired, and leaves an answered one as it was', async () => {
    const store = await tempStore()
    const approvals = new Approvals(store)
    const waiting = approvals.request({ kind: 'question', source: 'sdk', roomId: 'r', title: 'Which database?' })
    const answered = approvals.request({ kind: 'question', source: 'sdk', roomId: 'r', title: 'Which store?' })
    approvals.decide(answered.approval.id, { behavior: 'answer', text: 'S3' })
    // A row saved as pending that no waiter in this run holds.
    const orphan = { ...waiting.approval, id: 'orphan', title: 'Run pnpm db:reset' }
    store.saveApproval(orphan)
    const ended = approvals.expireIds([waiting.approval.id, answered.approval.id, 'orphan', 'unknown'])
    expect(ended.map((a) => [a.title, a.status])).toEqual([['Which database?', 'expired'], ['Run pnpm db:reset', 'expired']])
    expect(await waiting.decision).toBeNull()
    expect(store.approval(answered.approval.id)).toMatchObject({ status: 'answered', answer: 'S3' })
    expect(store.approval('orphan')?.status).toBe('expired')
  })

  it('leaves everything to expirePending once Kernel quits', async () => {
    const store = await tempStore()
    const approvals = new Approvals(store)
    const waiting = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run pnpm db:reset' })
    approvals.expirePending()
    store.saveApproval({ ...waiting.approval, id: 'orphan' })
    expect(approvals.expireIds([waiting.approval.id, 'orphan'])).toEqual([])
    expect(store.approval('orphan')?.status).toBe('pending')
  })
})

describe('approvals while Kernel quits (KERNEL-215)', () => {
  it('ends what is waiting, then answers new requests at once without saving them', async () => {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-approvals-')), 'kernel.db'))
    const approvals = new Approvals(store)
    const waiting = approvals.request({ kind: 'tool', source: 'hook', roomId: 'r', title: 'Run pnpm db:reset' })
    expect(approvals.expirePending().map((a) => a.status)).toEqual(['expired'])
    expect(await waiting.decision).toBeNull()

    // A hook request that lands between that and the connections closing: no pending entry, nothing saved.
    const abort = new AbortController()
    const late = approvals.request({ kind: 'tool', source: 'hook', roomId: 'r', title: 'Run pnpm build' }, { signal: abort.signal })
    expect(await late.decision).toBeNull()
    expect(approvals.isPending(late.approval.id)).toBe(false)
    expect(store.approvals({}).map((a) => a.title)).toEqual(['Run pnpm db:reset'])
    // Its connection dropping after the database closed reaches nothing.
    store.db.close()
    expect(() => abort.abort()).not.toThrow()
  })
})

describe('plan cards outlive a quit (plan-cards-survive-restart)', () => {
  it('keeps a plan pending through quitting and at launch while its chat is open, and ends every other kind as before', async () => {
    const store = await tempStore()
    store.saveWorkspace({ id: 'ws', roomId: 'r', name: 'invoices', branch: 'feat/invoices', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kai', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    store.saveWorkspace({ id: 'gone', roomId: 'r', name: 'old', branch: 'feat/old', baseRef: 'main', path: '/tmp/old', mode: 'worktree', agentId: 'kai', port: 4301, status: 'archived', prState: 'none', createdAt: 1 })
    const chat = { kind: 'chat' as const, model: 'claude-sonnet-5-5', effort: 'low' as const, plan: true, createdAt: 1, title: 'Plan' }
    store.saveChat({ ...chat, id: 'open', workspaceId: 'ws' })
    store.saveChat({ ...chat, id: 'closed', workspaceId: 'ws', closed: true })
    store.saveChat({ ...chat, id: 'archived', workspaceId: 'gone' })
    const run = new Approvals(store)
    const abort = new AbortController()
    const plan = run.request({ kind: 'plan', source: 'sdk', roomId: 'r', workspaceId: 'ws', chatId: 'open', title: 'Plan' }, { signal: abort.signal })
    const tool = run.request({ kind: 'tool', source: 'sdk', roomId: 'r', workspaceId: 'ws', chatId: 'open', title: 'Run pnpm db:reset' })
    const question = run.request({ kind: 'question', source: 'sdk', roomId: 'r', workspaceId: 'ws', chatId: 'open', title: 'Which table?' })
    const closed = run.request({ kind: 'plan', source: 'sdk', roomId: 'r', workspaceId: 'ws', chatId: 'closed', title: 'Plan' })
    const archived = run.request({ kind: 'plan', source: 'sdk', roomId: 'r', workspaceId: 'gone', chatId: 'archived', title: 'Plan' })
    // The session stopping aborts the plan's turn: its waiter gets null, the card stays.
    run.quitting()
    abort.abort()
    expect(await plan.decision).toBeNull()
    run.expirePending()
    expect(await tool.decision).toBeNull()
    const status = (r: { approval: { id: string } }) => store.approval(r.approval.id)?.status
    expect([plan, tool, question, closed, archived].map(status)).toEqual(['pending', 'expired', 'expired', 'pending', 'pending'])
    // The next launch ends the ones whose chat is closed or archived, and keeps the open chat's plan for `settle`.
    const next = new Approvals(store)
    next.expireStale()
    expect([plan, closed, archived].map(status)).toEqual(['pending', 'expired', 'expired'])
    expect(next.waitingPlans('open', 'r').map((a) => a.id)).toEqual([plan.approval.id])
    expect(next.decide(plan.approval.id, { behavior: 'allow' })).toBeUndefined()
    expect(next.settle(plan.approval.id, { behavior: 'allow' })?.status).toBe('allowed')
    expect(next.waitingPlan(plan.approval.id)).toBeUndefined()
  })
})
