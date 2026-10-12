import { describe, expect, it } from 'vitest'
import type { Workspace } from '@shared/types'
import { setupGate, skipsSetup } from '../src/renderer/src/screens/workspace/setupGate'

// KERNEL-490: a chat with Rowan that isn't held stays open and shows its transcript while setup runs. A teammate's chat keeps
// KERNEL-430's rule: nothing goes out before its brief.

const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-table', branch: 'feat/x', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kai', port: 4300, status: 'setup', prState: 'none', createdAt: 1 }
const rowan: Workspace = { ...ws, agentId: 'rowan', lead: true, threadId: 'thread' }

describe('a chat while its workspace sets up', () => {
  it("skips setup only in a chat with Rowan with nothing held for it", () => {
    expect(skipsSetup(rowan, false)).toBe(true)
    expect(skipsSetup(rowan, true)).toBe(false)
    expect(skipsSetup(ws, false)).toBe(false)
    // The shared Lead workspace from before KERNEL-405 hosts no chat of its own.
    expect(skipsSetup({ ...rowan, threadId: undefined }, false)).toBe(false)
  })

  it("keeps a teammate's composer shut until its brief waits for setup, and shows SetupWait", () => {
    expect(setupGate({ status: 'setup', skips: false, held: false, empty: true })).toEqual({ wait: true, shut: true })
    expect(setupGate({ status: 'setup', skips: false, held: true, empty: true })).toEqual({ wait: true, shut: false })
    expect(setupGate({ status: 'failed', skips: false, held: true, empty: true })).toEqual({ wait: true, shut: false })
    expect(setupGate({ status: 'ready', skips: false, held: false, empty: true })).toEqual({ wait: false, shut: false })
  })

  it("keeps a chat with Rowan whose message went at once open, on its transcript, while setup runs", () => {
    expect(setupGate({ status: 'setup', skips: true, held: false, empty: false })).toEqual({ wait: false, shut: false })
    // Kernel opened it with no message: still the transcript, and what you send goes at once.
    expect(setupGate({ status: 'setup', skips: true, held: false, empty: true })).toEqual({ wait: false, shut: false })
    // Setup failed after Rowan answered: the transcript, with the banner above the composer.
    expect(setupGate({ status: 'failed', skips: true, held: false, empty: false })).toEqual({ wait: false, shut: false })
    // Setup failed with nothing sent: the card, for Run again and Send anyway.
    expect(setupGate({ status: 'failed', skips: true, held: false, empty: true })).toEqual({ wait: true, shut: false })
  })

  it('shows what a held chat with Rowan waits for, with the composer open, as before', () => {
    expect(setupGate({ status: 'setup', skips: skipsSetup(rowan, true), held: true, empty: true })).toEqual({ wait: true, shut: false })
  })
})
