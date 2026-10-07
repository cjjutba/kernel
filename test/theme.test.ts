import { describe, expect, it } from 'vitest'
import { resolveTheme } from '../src/renderer/src/ui/theme'

describe('resolveTheme', () => {
  it('keeps an explicit theme whatever the system says', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })
  it('follows the system for "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})
