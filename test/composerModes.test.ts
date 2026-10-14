import { describe, expect, it } from 'vitest'
import { cyclePatch, modePatch } from '../src/renderer/src/screens/workspace/composer/modes'

describe('Shift+Tab into Plan (KERNEL-772)', () => {
  it('puts back a chat that had no mode of its own', () => {
    const patch = cyclePatch(undefined, 'plan')
    expect(patch).toEqual({ plan: true, mode: undefined })
    expect('mode' in patch).toBe(true)
  })
  it('puts back the chat\'s own mode', () => {
    expect(cyclePatch('auto', 'plan')).toEqual({ plan: true, mode: 'auto' })
  })
  it('saves a mode past Plan as a pick does', () => {
    expect(cyclePatch(undefined, 'auto')).toEqual({ mode: 'auto', plan: false })
    expect(cyclePatch('default', 'bypassPermissions')).toEqual({ mode: 'bypassPermissions', plan: false })
  })
  it('leaves mode alone when Plan is picked from the menu', () => {
    expect(modePatch('plan')).toEqual({ plan: true })
    expect(modePatch('acceptEdits')).toEqual({ mode: 'acceptEdits', plan: false })
  })
})
