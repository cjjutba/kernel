import { describe, expect, it, vi } from 'vitest'
import { FONT_ZOOM } from '../src/main/features/appearance'
import { FLOOR_LEVEL, LIGHT_HEIGHT, LIGHTS_WIDTH, followPageZoom, handZoom, lightsFor, placeLights, settleZoom, zoomStepOf, zoomWindow } from '../src/main/windowZoom'

const key = (k: string, extra: Partial<{ type: string; meta: boolean; control: boolean; alt: boolean }> = {}) => ({ type: 'keyDown', key: k, meta: true, control: false, alt: false, ...extra })

describe('zoomStepOf', () => {
  it('maps ⌘+, ⌘=, ⌘- and ⌘0', () => {
    expect(zoomStepOf(key('+'))).toBe('in')
    expect(zoomStepOf(key('='))).toBe('in')
    expect(zoomStepOf(key('-'))).toBe('out')
    expect(zoomStepOf(key('0'))).toBe('reset')
  })
  it('leaves a key without ⌘, with ctrl or alt, a key up and every other key alone', () => {
    expect(zoomStepOf(key('+', { meta: false }))).toBeNull()
    expect(zoomStepOf(key('+', { control: true }))).toBeNull()
    expect(zoomStepOf(key('-', { alt: true }))).toBeNull()
    expect(zoomStepOf(key('0', { type: 'keyUp' }))).toBeNull()
    expect(zoomStepOf(key('w'))).toBeNull()
  })
})

/** A window whose page zooms like Chromium's, 1.2 a level, and that records where its traffic lights go. */
const window_ = (taken: boolean | Error = false, level = 1) => {
  const wc = {
    executeJavaScript: vi.fn(async (_code: string) => { if (taken instanceof Error) throw taken; return taken }),
    getZoomLevel: vi.fn(() => level),
    setZoomLevel: vi.fn((l: number) => { level = l }),
    getZoomFactor: vi.fn(() => 1.2 ** level),
    isDestroyed: () => false
  }
  return { webContents: wc, setWindowButtonPosition: vi.fn() }
}

// KERNEL-901: the native traffic lights don't zoom with the page, so every zoom moves them onto the top row's center line, y 31 at 100%.
describe('the traffic lights', () => {
  const steps = Array.from({ length: 18 }, (_, i) => FLOOR_LEVEL + i * 0.5)

  it('sit on the top row at 100%, 20 from the left', () => {
    expect(lightsFor(1)).toEqual({ x: 20, y: 31 - LIGHT_HEIGHT / 2 })
  })

  it('land on whole points centered on 31 times the zoom at every allowed step', () => {
    for (const level of steps) {
      const z = 1.2 ** level
      const { x, y } = lightsFor(z)
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true)
      expect(Math.abs(y + LIGHT_HEIGHT / 2 - 31 * z)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(x - 20 * z)).toBeLessThanOrEqual(0.5)
      // Clear of the sidebar toggle at 87 times the zoom.
      expect(x + LIGHTS_WIDTH).toBeLessThan(87 * z)
    }
  })

  it('stop zooming out at the floor, which is 100% while the lights overflow the hidden sidebar header there', () => {
    expect(20 + LIGHTS_WIDTH + 8).toBeGreaterThan(78)
    const w = window_(false, FLOOR_LEVEL)
    zoomWindow(w as never, 'out', 1)
    expect(w.webContents.setZoomLevel).toHaveBeenCalledWith(FLOOR_LEVEL)
    expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2 ** FLOOR_LEVEL))
  })

  it('follow each zoom step, and go back to the 100% place on Actual Size', () => {
    const w = window_(false, 0)
    zoomWindow(w as never, 'in', 1)
    expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2 ** 0.5))
    zoomWindow(w as never, 'in', 1)
    expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2))
    zoomWindow(w as never, 'reset', 1)
    expect(w.webContents.setZoomLevel).toHaveBeenLastCalledWith(0)
    expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1))
  })

  it('follow a zoom the page already has, raising a saved one below the floor', () => {
    const zoomed = window_(false, 2)
    placeLights(zoomed as never, 1)
    expect(zoomed.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2 ** 2))
    const low = window_(false, -1)
    settleZoom(low as never, 1)
    expect(low.webContents.setZoomLevel).toHaveBeenCalledWith(FLOOR_LEVEL)
    expect(low.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2 ** FLOOR_LEVEL))
  })
})

// KERNEL-972: Font size zooms the page's root in CSS on top of Electron's page zoom. The maintainer's window had a saved 120% and Large, so the row sat
// on 31 x 1.2 x 1.1 while the lights sat on 31 x 1.2, 3.5 high, whatever the page said about its zoom.
describe('the traffic lights with a Font size', () => {
  const center = (p: { y: number }) => p.y + LIGHT_HEIGHT / 2

  it('center on the row the Font size zooms, at a launch with a saved zoom', () => {
    for (const level of [0, 0.5, 1]) for (const font of Object.values(FONT_ZOOM)) {
      const w = window_(false, level)
      settleZoom(w as never, font)
      const placed = w.setWindowButtonPosition.mock.lastCall![0]
      expect(Math.abs(center(placed) - 31 * 1.2 ** level * font)).toBeLessThanOrEqual(0.5)
      expect(placed.x + LIGHTS_WIDTH).toBeLessThan(87 * 1.2 ** level * font)
    }
  })

  it('keep the Font size through every other way the zoom moves', async () => {
    const large = FONT_ZOOM.large
    const w = window_(false, 0)
    zoomWindow(w as never, 'in', large)
    expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2 ** 0.5 * large))
    w.webContents.setZoomLevel(1)
    await followPageZoom(() => w as never, () => large)({ sender: w.webContents })
    expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2 * large))
    placeLights(w as never, large)
    expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2 * large))
    await handZoom(w as never, 'reset', () => large)
    expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(large))
  })
})

// KERNEL-972: the page says its zoom changed, and main reads the zoom itself, so a change that skipped zoomWindow still moves the lights.
describe('followPageZoom', () => {
  it('moves the lights to the zoom the page already has', async () => {
    const w = window_(false, 0)
    const follow = followPageZoom((sender) => (sender === w.webContents ? w : null) as never, () => 1)
    for (const level of [0, 0.5, 1]) {
      w.webContents.setZoomLevel(level)
      expect(await follow({ sender: w.webContents })).toEqual({ ok: true })
      expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2 ** level))
    }
  })
  it('raises a zoom below the floor, as a launch does', async () => {
    const w = window_(false, -1)
    await followPageZoom(() => w as never, () => 1)({ sender: w.webContents })
    expect(w.webContents.setZoomLevel).toHaveBeenCalledWith(FLOOR_LEVEL)
    expect(w.setWindowButtonPosition).toHaveBeenLastCalledWith(lightsFor(1.2 ** FLOOR_LEVEL))
  })
  it('ignores a page that is not the main window', async () => {
    const w = window_(false, 1)
    expect(await followPageZoom(() => null, () => 1)({ sender: {} })).toEqual({ ok: true })
    expect(w.setWindowButtonPosition).not.toHaveBeenCalled()
  })
})

describe('handZoom', () => {
  const page = window_
  it('leaves the window alone when the page takes the key', async () => {
    const w = page(true)
    await handZoom(w as never, 'in', () => 1)
    expect(w.webContents.setZoomLevel).not.toHaveBeenCalled()
    expect(w.setWindowButtonPosition).not.toHaveBeenCalled()
    expect(w.webContents.executeJavaScript.mock.calls[0][0]).toContain("detail: 'in'")
  })
  it('zooms the window half a level when the page leaves the key, as the menu would', async () => {
    const up = page(false)
    await handZoom(up as never, 'in', () => 1)
    expect(up.webContents.setZoomLevel).toHaveBeenCalledWith(1.5)
    const down = page(false)
    await handZoom(down as never, 'out', () => 1)
    expect(down.webContents.setZoomLevel).toHaveBeenCalledWith(0.5)
  })
  it('puts the window back to 100% on ⌘0, and zooms it when the page cannot answer', async () => {
    const reset = page(false, 2)
    await handZoom(reset as never, 'reset', () => 1)
    expect(reset.webContents.setZoomLevel).toHaveBeenCalledWith(0)
    const broken = page(new Error('gone'))
    await handZoom(broken as never, 'in', () => 1)
    expect(broken.webContents.setZoomLevel).toHaveBeenCalledWith(1.5)
  })
})
