import { afterEach, describe, expect, it, vi } from 'vitest'
import { draggedSize, keyedSize, readWidth, releasedAs } from '../src/renderer/src/components/ResizeHandle'
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
    expect(sidebarDefault()).toBe(300)
  })
  it('caps the limit by the window but never below the minimum', () => {
    vi.stubGlobal('window', { innerWidth: 1440 })
    expect(sidebarLimit()).toBe(480)
    vi.stubGlobal('window', { innerWidth: 600 })
    expect(sidebarLimit()).toBe(SIDEBAR_MIN)
  })
})

describe('a top edge, as on the bottom drawer', () => {
  it('grows with ArrowUp and shrinks with ArrowDown, and takes the big step with Shift', () => {
    expect(keyedSize('top', 'ArrowUp', false, 272, 160, 600)).toBe(280)
    expect(keyedSize('top', 'ArrowDown', false, 272, 160, 600)).toBe(264)
    expect(keyedSize('top', 'ArrowUp', true, 272, 160, 600)).toBe(304)
    expect(keyedSize('top', 'ArrowDown', true, 272, 160, 600)).toBe(240)
  })
  it('ignores the keys a vertical edge has no use for', () => {
    expect(keyedSize('top', 'ArrowLeft', false, 272, 160, 600)).toBeNull()
    expect(keyedSize('top', 'ArrowRight', false, 272, 160, 600)).toBeNull()
    expect(keyedSize('left', 'ArrowUp', false, 320, 320, 720)).toBeNull()
  })
  it('goes to the smallest on Home and the largest on End', () => {
    expect(keyedSize('top', 'Home', false, 272, 160, 600)).toBe(160)
    expect(keyedSize('top', 'End', false, 272, 160, 600)).toBe(600)
  })
  it('grows when dragged up and shrinks when dragged down', () => {
    expect(draggedSize('top', 272, 500, 450)).toBe(322)
    expect(draggedSize('top', 272, 500, 540)).toBe(232)
  })
  it('leaves the left and right edges as they were', () => {
    expect(keyedSize('right', 'ArrowRight', false, 236, 200, 480)).toBe(244)
    expect(keyedSize('right', 'ArrowLeft', false, 236, 200, 480)).toBe(228)
    expect(keyedSize('left', 'ArrowLeft', false, 400, 320, 720)).toBe(408)
    expect(keyedSize('left', 'ArrowRight', true, 400, 320, 720)).toBe(368)
    expect(draggedSize('right', 236, 100, 140)).toBe(276)
    expect(draggedSize('left', 400, 900, 860)).toBe(440)
  })
})
