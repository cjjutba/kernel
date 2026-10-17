import { describe, expect, it } from 'vitest'
import type { Workspace } from '@shared/types'
import { setupGate, skipsSetup } from '../src/renderer/src/screens/workspace/setupGate'

// KERNEL-490: a chat with Kernel that isn't held stays open and shows its transcript while setup runs. A teammate's chat keeps
// KERNEL-430's rule: nothing goes out before its brief.

const ws: Workspace = { id: 'ws', projectId: 'project', name: 'invoice-table', branch: 'feat/x', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kai', port: 4300, status: 'setup', prState: 'none', createdAt: 1 }
const kernel: Workspace = { ...ws, agentId: 'kernel', lead: true, threadId: 'thread' }

describe('a chat while its workspace sets up', () => {
  it("skips setup only in a chat with Kernel with nothing held for it", () => {
    expect(skipsSetup(kernel, false)).toBe(true)
    expect(skipsSetup(kernel, true)).toBe(false)
    expect(skipsSetup(ws, false)).toBe(false)
    // The shared Lead workspace from before KERNEL-405 hosts no chat of its own.
    expect(skipsSetup({ ...kernel, threadId: undefined }, false)).toBe(false)
  })

  it("keeps a teammate's composer shut until its brief waits for setup, and shows SetupWait", () => {
    expect(setupGate({ status: 'setup', skips: false, held: false, empty: true })).toEqual({ wait: true, shut: true })
    expect(setupGate({ status: 'setup', skips: false, held: true, empty: true })).toEqual({ wait: true, shut: false })
    expect(setupGate({ status: 'failed', skips: false, held: true, empty: true })).toEqual({ wait: true, shut: false })
    expect(setupGate({ status: 'ready', skips: false, held: false, empty: true })).toEqual({ wait: false, shut: false })
  })

  it("keeps a teammate's chat with history open while setup runs, on its transcript (KERNEL-1018)", () => {
    expect(setupGate({ status: 'setup', skips: false, held: false, empty: false })).toEqual({ wait: false, shut: false })
    expect(setupGate({ status: 'setup', skips: false, held: true, empty: false })).toEqual({ wait: false, shut: false })
    expect(setupGate({ status: 'failed', skips: false, held: true, empty: false })).toEqual({ wait: false, shut: false })
  })

  it("keeps a chat with Kernel whose message went at once open, on its transcript, while setup runs", () => {
    expect(setupGate({ status: 'setup', skips: true, held: false, empty: false })).toEqual({ wait: false, shut: false })
    // Kernel opened it with no message: still the transcript, and what you send goes at once.
    expect(setupGate({ status: 'setup', skips: true, held: false, empty: true })).toEqual({ wait: false, shut: false })
    // Setup failed after Kernel answered: the transcript, with the banner above the composer.
    expect(setupGate({ status: 'failed', skips: true, held: false, empty: false })).toEqual({ wait: false, shut: false })
    // Setup failed with nothing sent: the card, for Run again and Send anyway.
    expect(setupGate({ status: 'failed', skips: true, held: false, empty: true })).toEqual({ wait: true, shut: false })
  })

  it('shows what a held chat with Kernel waits for, with the composer open, as before', () => {
    expect(setupGate({ status: 'setup', skips: skipsSetup(kernel, true), held: true, empty: true })).toEqual({ wait: true, shut: false })
  })
})
