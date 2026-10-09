import { beforeEach, describe, expect, it, vi } from 'vitest'

// KERNEL-132: the open workspace tells an archive the user made from one Kernel made on its own.

const call = vi.fn()
vi.mock('../src/renderer/src/api', () => ({ call: (...args: unknown[]) => call(...args) }))
const { archiveByHand, archivedByHand, restoredFromHistory } = await import('../src/renderer/src/screens/workspace/byHand')

describe('archiving by hand', () => {
  beforeEach(() => call.mockReset())

  it('marks the workspace before the archive returns, since its archived status can arrive first', async () => {
    let seen: boolean | undefined
    call.mockImplementation(async () => { seen = archivedByHand('w1'); return { ok: true } })
    await archiveByHand({ workspaceId: 'w1', deleteBranch: true })
    expect(call).toHaveBeenCalledWith('workspaces.archive', { workspaceId: 'w1', deleteBranch: true })
    expect(seen).toBe(true)
    expect(archivedByHand('w1')).toBe(true)
    expect(archivedByHand('w2')).toBe(false)
  })

  it('drops the mark when the archive fails, and when the workspace comes back from History', async () => {
    call.mockRejectedValueOnce(new Error('busy'))
    await expect(archiveByHand({ workspaceId: 'w3' })).rejects.toThrow('busy')
    expect(archivedByHand('w3')).toBe(false)
    call.mockResolvedValue({ ok: true })
    await archiveByHand({ workspaceId: 'w4' })
    restoredFromHistory('w4')
    expect(archivedByHand('w4')).toBe(false)
  })
})
