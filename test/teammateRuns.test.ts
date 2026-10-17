import { describe, expect, it } from 'vitest'
import { teammateRunsIn } from '../src/shared/teammateRuns'

// KERNEL-1004: the Lead's runs_in, then the project's setting, then the app's. `lead` follows the Lead chat.

const app = (teammatesRunIn: 'kernel' | 'terminal' | 'lead') => ({ terminal: { teammatesRunIn } })
const project = (teammatesRunIn: 'kernel' | 'terminal' | 'lead') => ({ terminal: { teammatesRunIn } })

describe('teammateRunsIn', () => {
  it('runs in Kernel when nothing says otherwise', () => {
    expect(teammateRunsIn({ leadIsTerminal: true })).toBe('kernel')
    expect(teammateRunsIn({ app: {}, project: {}, leadIsTerminal: false })).toBe('kernel')
  })

  it('takes the app setting', () => {
    expect(teammateRunsIn({ app: app('terminal'), leadIsTerminal: false })).toBe('terminal')
    expect(teammateRunsIn({ app: app('kernel'), leadIsTerminal: true })).toBe('kernel')
  })

  it('lets the project override the app', () => {
    expect(teammateRunsIn({ app: app('kernel'), project: project('terminal'), leadIsTerminal: false })).toBe('terminal')
    expect(teammateRunsIn({ app: app('terminal'), project: project('kernel'), leadIsTerminal: false })).toBe('kernel')
  })

  it('lets runs_in override the project and the app', () => {
    expect(teammateRunsIn({ runsIn: 'kernel', app: app('terminal'), project: project('terminal'), leadIsTerminal: true })).toBe('kernel')
    expect(teammateRunsIn({ runsIn: 'terminal', app: app('kernel'), project: project('kernel'), leadIsTerminal: false })).toBe('terminal')
  })

  it('follows the Lead for lead, at the project or the app level', () => {
    expect(teammateRunsIn({ app: app('lead'), leadIsTerminal: true })).toBe('terminal')
    expect(teammateRunsIn({ app: app('lead'), leadIsTerminal: false })).toBe('kernel')
    expect(teammateRunsIn({ app: app('kernel'), project: project('lead'), leadIsTerminal: true })).toBe('terminal')
    expect(teammateRunsIn({ app: app('terminal'), project: project('lead'), leadIsTerminal: false })).toBe('kernel')
  })

  it('ignores a value it does not know', () => {
    expect(teammateRunsIn({ runsIn: 'lead', app: app('terminal'), leadIsTerminal: false })).toBe('terminal')
    expect(teammateRunsIn({ app: { terminal: { teammatesRunIn: 'elsewhere' as never } }, project: project('terminal'), leadIsTerminal: false })).toBe('terminal')
  })
})
