import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'

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
