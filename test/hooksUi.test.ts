import { describe, expect, it } from 'vitest'
import type { HookStatus } from '@shared/types'
import { needsHookCheck } from '../src/renderer/src/screens/onboarding/hookCheck'
import { problemCard } from '../src/renderer/src/screens/onboarding/CheckHooks'

const status = (o: Partial<HookStatus>): HookStatus => ({ port: 7420, listening: true, installed: false, events: [], ...o })

describe('a workspace run in onboarding (KERNEL-679)', () => {
  it('finishes onboarding without Check hooks, which other builds still go through while hooks are not installed', () => {
    expect(needsHookCheck(status({ build: 'run', problem: { kind: 'workspace-run' } }))).toBe(false)
    expect(needsHookCheck(status({ build: 'dev' }))).toBe(true)
    expect(needsHookCheck(status({ problem: { kind: 'off', file: '/u/settings.json' } }))).toBe(true)
    expect(needsHookCheck(status({ installed: true }))).toBe(false)
    expect(needsHookCheck(null)).toBe(false)
  })

  it('says hooks are off in Check hooks, with no fix and no button to try again', () => {
    const c = problemCard({ kind: 'workspace-run' })
    expect(c.title).toEqual(['Hooks are off in a workspace run'])
    expect(c.fixLabel).toBeUndefined()
    expect(c.retry).toBeUndefined()
  })
})
