import { describe, expect, it } from 'vitest'
import { collapsedWord } from '../src/renderer/src/screens/workspace/bottomWord'

// KERNEL-529: a collapsed bottom panel says what the scripts are doing, so you needn't open it to see whether the app is up.

const idle = { setupRunning: false, setupFailed: false, running: [], scripts: 1, noRun: false, port: 4312 }

describe('the collapsed bottom panel', () => {
  it('says idle with the port, or that there is no run script', () => {
    expect(collapsedWord(idle)).toBe('Idle, port 4312')
    expect(collapsedWord({ ...idle, scripts: 0, noRun: true })).toBe('No run script')
  })

  it('says running, naming the scripts when the room has several', () => {
    expect(collapsedWord({ ...idle, running: ['run'] })).toBe('Running')
    expect(collapsedWord({ ...idle, scripts: 3, running: ['web'] })).toBe('Running web')
    expect(collapsedWord({ ...idle, scripts: 3, running: ['web', 'api'] })).toBe('Running web, api')
  })

  it('puts setup first, while it runs and after it fails', () => {
    expect(collapsedWord({ ...idle, setupRunning: true, running: ['run'] })).toBe('Setting up')
    expect(collapsedWord({ ...idle, setupFailed: true })).toBe('Setup failed')
    expect(collapsedWord({ ...idle, setupFailed: true, running: ['run'] })).toBe('Setup failed')
  })
})
