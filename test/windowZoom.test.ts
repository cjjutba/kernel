import { describe, expect, it, vi } from 'vitest'
import { handZoom, zoomStepOf } from '../src/main/windowZoom'

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

describe('handZoom', () => {
  const page = (taken: boolean | Error, level = 1) => {
    const wc = {
      executeJavaScript: vi.fn(async (_code: string) => { if (taken instanceof Error) throw taken; return taken }),
      getZoomLevel: vi.fn(() => level),
      setZoomLevel: vi.fn(),
      isDestroyed: () => false
    }
    return wc
  }
  it('leaves the window alone when the page takes the key', async () => {
    const wc = page(true)
    await handZoom(wc as never, 'in')
    expect(wc.setZoomLevel).not.toHaveBeenCalled()
    expect(wc.executeJavaScript.mock.calls[0][0]).toContain("detail: 'in'")
  })
  it('zooms the window half a level when the page leaves the key, as the menu would', async () => {
    const up = page(false)
    await handZoom(up as never, 'in')
    expect(up.setZoomLevel).toHaveBeenCalledWith(1.5)
    const down = page(false)
    await handZoom(down as never, 'out')
    expect(down.setZoomLevel).toHaveBeenCalledWith(0.5)
  })
  it('puts the window back to 100% on ⌘0, and zooms it when the page cannot answer', async () => {
    const reset = page(false, 2)
    await handZoom(reset as never, 'reset')
    expect(reset.setZoomLevel).toHaveBeenCalledWith(0)
    const broken = page(new Error('gone'))
    await handZoom(broken as never, 'in')
    expect(broken.setZoomLevel).toHaveBeenCalledWith(1.5)
  })
})
