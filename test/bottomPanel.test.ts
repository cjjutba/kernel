import { describe, expect, it } from 'vitest'
import { bottomFolds, foldedWord } from '../src/renderer/src/screens/workspace/bottomPanel'

// KERNEL-529: the Run panel folds to its tab row while nothing runs, and opens on the first line of output.

const idle = { tab: 'run' as const, lines: 0, running: false, setupBusy: false, starting: false, setupHolds: false }

describe('the Run panel folding', () => {
  it('folds on Run and Setup while nothing runs and nothing has printed', () => {
    expect(bottomFolds(idle)).toBe(true)
    expect(bottomFolds({ ...idle, tab: 'setup' })).toBe(true)
  })

  it('opens on output, a running or starting script, or a setup in progress', () => {
    expect(bottomFolds({ ...idle, lines: 1 })).toBe(false)
    expect(bottomFolds({ ...idle, running: true })).toBe(false)
    expect(bottomFolds({ ...idle, starting: true })).toBe(false)
    expect(bottomFolds({ ...idle, tab: 'setup', setupBusy: true })).toBe(false)
    // A run script running doesn't hold the Setup tab open, and setup running doesn't hold Run open.
    expect(bottomFolds({ ...idle, tab: 'setup', running: true })).toBe(true)
    expect(bottomFolds({ ...idle, setupBusy: true })).toBe(true)
  })

  it('never folds the Terminal, or a workspace whose setup fills the panel', () => {
    expect(bottomFolds({ ...idle, tab: 'terminal' })).toBe(false)
    expect(bottomFolds({ ...idle, setupHolds: true })).toBe(false)
  })

  it('says what the folded row waits for', () => {
    expect(foldedWord('run', { noRun: true, noSetup: false, port: 4312 })).toBe('No run script')
    expect(foldedWord('run', { noRun: false, noSetup: false, port: 4312 })).toBe('Idle, port 4312')
    expect(foldedWord('setup', { noRun: false, noSetup: true, port: 4312 })).toBe('No setup script')
    expect(foldedWord('setup', { noRun: false, noSetup: false, port: 4312 })).toBe('No output yet')
  })
})
