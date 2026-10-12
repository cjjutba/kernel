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
