import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWidth, releasedAs } from '../src/renderer/src/components/ResizeHandle'
import { SIDEBAR_HIDE_BELOW, SIDEBAR_KEY, SIDEBAR_MIN, sidebarDefault, sidebarLimit } from '../src/renderer/src/components/sidebar/useSidebarWidth'

afterEach(() => vi.unstubAllGlobals())

describe('releasedAs', () => {
  it('hides below the threshold and commits at or above it', () => {
    expect(releasedAs(SIDEBAR_HIDE_BELOW - 1, SIDEBAR_HIDE_BELOW)).toBe('hide')
    expect(releasedAs(SIDEBAR_HIDE_BELOW, SIDEBAR_HIDE_BELOW)).toBe('commit')
  })
  it('clamps instead of hiding when there is no threshold, as in Settings', () => {
    expect(releasedAs(0, undefined)).toBe('commit')
    expect(releasedAs(SIDEBAR_MIN - 100, undefined)).toBe('commit')
  })
})

describe('the width the sidebar and the Settings nav share', () => {
  it('reads the one saved key, so a width saved by either is what the other shows', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === SIDEBAR_KEY ? '360' : null) })
    expect(readWidth(SIDEBAR_KEY, SIDEBAR_MIN, 480)).toBe(360)
  })
  it('falls back to the default when nothing is saved', () => {
    vi.stubGlobal('localStorage', { getItem: () => null })
    expect(readWidth(SIDEBAR_KEY, SIDEBAR_MIN, 480)).toBeNull()
    expect(sidebarDefault()).toBe(236)
  })
  it('caps the limit by the window but never below the minimum', () => {
    vi.stubGlobal('window', { innerWidth: 1440 })
    expect(sidebarLimit()).toBe(480)
    vi.stubGlobal('window', { innerWidth: 600 })
    expect(sidebarLimit()).toBe(SIDEBAR_MIN)
  })
})
