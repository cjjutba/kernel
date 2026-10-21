import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOTTOM_MIN, bottomHeight, bottomLimits, ratioFor, TOP_MIN } from '../src/renderer/src/screens/workspace/bottomSplit'

let disk: Map<string, string>
/** A fresh copy of the store each time, as a new launch: it reads `disk` on first use. */
async function launch() {
  vi.resetModules()
  return import('../src/renderer/src/store')
}

beforeEach(() => {
  disk = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) })
})
afterEach(() => vi.unstubAllGlobals())

describe('the bottom drawer in the store', () => {
  it('starts a third of the chat column, collapsed in Kernel\'s chats and open in a teammate\'s', async () => {
    const { getState } = await launch()
    expect(getState().ui.bottomRatio).toBeCloseTo(1 / 3)
    expect(getState().ui.bottomCollapsed).toEqual({ lead: true, teammate: false })
  })

  it('keeps one size for every chat across a restart, and forgets it on a reset', async () => {
    const first = await launch()
    first.actions.ui.setBottomRatio(0.45)
    expect(disk.get('kernel.bottomPanelRatio')).toBe('0.45')
    const second = await launch()
    expect(second.getState().ui.bottomRatio).toBe(0.45)
    second.actions.ui.setBottomRatio(null)
    expect(disk.has('kernel.bottomPanelRatio')).toBe(false)
    expect(second.getState().ui.bottomRatio).toBeCloseTo(1 / 3)
  })

  it('falls back to a third when the saved size is junk', async () => {
    for (const junk of ['abc', '0', '-0.2', '1', '2', 'NaN']) {
      disk.set('kernel.bottomPanelRatio', junk)
      expect((await launch()).getState().ui.bottomRatio, junk).toBeCloseTo(1 / 3)
    }
  })

  it('keeps collapsed or open apart for Kernel\'s chats and for teammates', async () => {
    const first = await launch()
    first.actions.ui.setBottomCollapsed('lead', false)
    expect(disk.get('kernel.bottomCollapsed.lead')).toBe('0')
    expect(disk.has('kernel.bottomCollapsed.teammate')).toBe(false)
    first.actions.ui.setBottomCollapsed('teammate', true)
    const second = await launch()
    expect(second.getState().ui.bottomCollapsed).toEqual({ lead: false, teammate: true })
  })

  it('opens without saving while setup shows, and puts back what was saved when it goes', async () => {
    const { actions, getState } = await launch()
    actions.ui.setBottomCollapsed('teammate', true)
    actions.ui.setBottomCollapsed('teammate', false, false)
    expect(getState().ui.bottomCollapsed.teammate).toBe(false)
    expect(disk.get('kernel.bottomCollapsed.teammate')).toBe('1')
    actions.ui.restoreBottomCollapsed('teammate')
    expect(getState().ui.bottomCollapsed.teammate).toBe(true)
  })

  it('puts back what the user chose meanwhile, not what it was before setup', async () => {
    const { actions, getState } = await launch()
    actions.ui.setBottomCollapsed('teammate', false, false)
    actions.ui.setBottomCollapsed('teammate', true)
    actions.ui.setBottomCollapsed('teammate', false, false)
    actions.ui.restoreBottomCollapsed('teammate')
    expect(getState().ui.bottomCollapsed.teammate).toBe(true)
  })

  it('starts as usual when localStorage is blocked', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } })
    const { actions, getState } = await launch()
    expect(getState().ui.bottomCollapsed).toEqual({ lead: true, teammate: false })
    expect(() => actions.ui.setBottomRatio(0.5)).not.toThrow()
    expect(getState().ui.bottomRatio).toBe(0.5)
  })
})

describe('the chat column and its drawer', () => {
  it('gives the drawer a third of the chat column at 1440x900', () => {
    expect(bottomHeight(1 / 3, 816)).toBe(272)
  })
  it('keeps the chat at 320px and the drawer at its tab bar plus 120px', () => {
    expect(bottomLimits(816)).toEqual({ min: BOTTOM_MIN, max: 816 - TOP_MIN })
    expect(bottomHeight(0.05, 816)).toBe(BOTTOM_MIN)
    expect(bottomHeight(0.95, 816)).toBe(816 - TOP_MIN)
  })
  it('keeps the bottom its minimum in a column too short for both', () => {
    expect(bottomLimits(250)).toEqual({ min: BOTTOM_MIN, max: BOTTOM_MIN })
    expect(bottomHeight(1 / 3, 250)).toBe(BOTTOM_MIN)
  })
  it('saves a dragged height as a share, so a window of another height keeps the proportion', () => {
    const ratio = ratioFor(408, 816)
    expect(ratio).toBe(0.5)
    expect(bottomHeight(ratio, 1000)).toBe(500)
  })
})
