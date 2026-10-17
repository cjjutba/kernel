import { describe, expect, it } from 'vitest'
import { setupGate, skipsSetup } from '../src/renderer/src/screens/workspace/setupGate'

// KERNEL-1012: a chat shows its transcript and stays open while setup runs unless main holds something for it. Only a held chat
// shows SetupWait, whoever it belongs to.

describe('a chat while its workspace sets up', () => {
  it('skips setup unless something is held for it', () => {
    expect(skipsSetup(false)).toBe(true)
    expect(skipsSetup(true)).toBe(false)
  })

  it("shows a teammate's transcript with the box open while setup runs, as nothing is held", () => {
    expect(setupGate({ status: 'setup', skips: skipsSetup(false), held: false, empty: true })).toEqual({ wait: false, shut: false })
    expect(setupGate({ status: 'setup', skips: skipsSetup(false), held: false, empty: false })).toEqual({ wait: false, shut: false })
  })

  it('shows SetupWait for a held chat with the box open, with Wait for setup on', () => {
    expect(setupGate({ status: 'setup', skips: skipsSetup(true), held: true, empty: true })).toEqual({ wait: true, shut: false })
    expect(setupGate({ status: 'failed', skips: skipsSetup(true), held: true, empty: true })).toEqual({ wait: true, shut: false })
  })

  it('keeps a held chat with history on its transcript (KERNEL-1018)', () => {
    expect(setupGate({ status: 'setup', skips: false, held: true, empty: false })).toEqual({ wait: false, shut: false })
    expect(setupGate({ status: 'failed', skips: false, held: true, empty: false })).toEqual({ wait: false, shut: false })
  })

  it('still draws the failed card when the worktree failed with nothing sent', () => {
    expect(setupGate({ status: 'failed', skips: true, held: false, empty: true })).toEqual({ wait: true, shut: false })
    expect(setupGate({ status: 'failed', skips: true, held: false, empty: false })).toEqual({ wait: false, shut: false })
  })
})
