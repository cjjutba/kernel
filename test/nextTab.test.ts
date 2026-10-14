import { describe, expect, it } from 'vitest'
import { nextTab } from '../src/renderer/src/screens/workspace/nextTab'

describe('nextTab (KERNEL-719)', () => {
  const order = ['1', '2', '3']

  it('returns to the tab used before the one closed', () => {
    expect(nextTab(order, ['3', '2', '1'], ['3'], '3')).toBe('2')
    expect(nextTab(order, ['2', '3', '1'], ['2'], '2')).toBe('3')
  })

  it('skips remembered tabs that are gone', () => {
    expect(nextTab(order, ['3', 'gone', '1'], ['3'], '3')).toBe('1')
  })

  it('opens the tab to the left without usable history, or to the right for the first tab', () => {
    expect(nextTab(order, undefined, ['3'], '3')).toBe('2')
    expect(nextTab(order, ['gone'], ['2'], '2')).toBe('1')
    expect(nextTab(order, [], ['1'], '1')).toBe('2')
  })

  it('keeps the selection when the closing tab is not the open one', () => {
    expect(nextTab(order, ['3', '2'], ['1'], '3')).toBe('3')
    expect(nextTab(order, ['3'], ['gone'], '2')).toBe('2')
  })

  it('stays on the tab kept by Close other tabs', () => {
    expect(nextTab(order, ['1', '2', '3'], ['1', '3'], '2')).toBe('2')
  })

  it('stays inside the open Lead chat\'s own tabs when the order is only those', () => {
    // t1's tabs are a1, a2; b1 belongs to another chat and is not in the order, though it was used last.
    expect(nextTab(['a1', 'a2'], ['a2', 'b1', 'a1'], ['a2'], 'a2')).toBe('a1')
  })

  it('returns nothing when no tab is left', () => {
    expect(nextTab(['1'], ['1'], ['1'], '1')).toBeUndefined()
  })
})
