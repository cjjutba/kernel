import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScrollActivity, type ScrollTarget } from '../src/renderer/src/ui/scrollIdle'

// The activity behind the scrollbar thumb: marked while scrolling, cleared 800ms after the last scroll, held while a native scrollbar is pressed (KERNEL-602 amended).
class Fake implements ScrollTarget {
  attrs = new Set<string>()
  setAttribute(name: string) { this.attrs.add(name) }
  removeAttribute(name: string) { this.attrs.delete(name) }
  get shown() { return this.attrs.has('data-scrolling') }
}

describe('createScrollActivity', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the thumb on activity and hides it 800ms after the last one', () => {
    const a = createScrollActivity(800)
    const el = new Fake()
    a.touch(el)
    expect(el.shown).toBe(true)
    vi.advanceTimersByTime(799)
    expect(el.shown).toBe(true)
    vi.advanceTimersByTime(1)
    expect(el.shown).toBe(false)
  })

  it('restarts the countdown on every touch', () => {
    const a = createScrollActivity(800)
    const el = new Fake()
    a.touch(el)
    vi.advanceTimersByTime(600)
    a.touch(el)
    vi.advanceTimersByTime(600)
    expect(el.shown).toBe(true)
    vi.advanceTimersByTime(200)
    expect(el.shown).toBe(false)
  })

  it('keeps each scroller on its own clock', () => {
    const a = createScrollActivity(800)
    const [one, two] = [new Fake(), new Fake()]
    a.touch(one)
    vi.advanceTimersByTime(500)
    a.touch(two)
    vi.advanceTimersByTime(300)
    expect([one.shown, two.shown]).toEqual([false, true])
  })

  it('holds the thumb up while pressed, however long, and hides 800ms after release', () => {
    const a = createScrollActivity(800)
    const el = new Fake()
    a.hold(el)
    vi.advanceTimersByTime(60_000)
    expect(el.shown).toBe(true)
    a.touch(el) // scrolling while the thumb is dragged
    vi.advanceTimersByTime(5000)
    expect(el.shown).toBe(true)
    a.release(el)
    vi.advanceTimersByTime(799)
    expect(el.shown).toBe(true)
    vi.advanceTimersByTime(1)
    expect(el.shown).toBe(false)
  })

  it('ignores a release for something that was not held', () => {
    const a = createScrollActivity(800)
    const el = new Fake()
    a.release(el)
    expect(el.shown).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose clears every mark and timer', () => {
    const a = createScrollActivity(800)
    const [one, two] = [new Fake(), new Fake()]
    a.touch(one)
    a.hold(two)
    a.dispose()
    expect([one.shown, two.shown]).toEqual([false, false])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('installScrollIdle', () => {
  type Handler = (e: unknown) => void
  const listeners = new Map<string, Handler>()
  class El { attrs = new Set<string>(); setAttribute(n: string) { this.attrs.add(n) } removeAttribute(n: string) { this.attrs.delete(n) } }

  beforeEach(() => {
    vi.useFakeTimers()
    listeners.clear()
    vi.stubGlobal('Element', El)
    vi.stubGlobal('document', { addEventListener: (t: string, h: Handler) => listeners.set(t, h), removeEventListener: () => {} })
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('a pointer move does not mark a scroller, a scroll does, and it clears 800ms after the last scroll', async () => {
    const { installScrollIdle } = await import('../src/renderer/src/ui/scrollIdle')
    const stop = installScrollIdle()
    const el = new El()
    listeners.get('pointermove')!({ target: el, buttons: 0 })
    vi.advanceTimersByTime(100)
    expect(el.attrs.has('data-scrolling')).toBe(false)
    listeners.get('scroll')!({ target: el })
    expect(el.attrs.has('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(799)
    expect(el.attrs.has('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(el.attrs.has('data-scrolling')).toBe(false)
    stop()
  })
})

describe('installScrollIdle on nested scrollers', () => {
  it('listens for scroll in the capture phase, which is how a nested scroller is seen, since scroll does not bubble', async () => {
    const added = new Map<string, boolean>()
    const handlers = new Map<string, (e: unknown) => void>()
    vi.stubGlobal('Element', class { attrs = new Set<string>(); setAttribute(n: string) { this.attrs.add(n) } removeAttribute(n: string) { this.attrs.delete(n) } })
    vi.stubGlobal('document', { addEventListener: (t: string, h: (e: unknown) => void, o?: { capture?: boolean }) => { added.set(t, o?.capture === true); handlers.set(t, h) }, removeEventListener: () => {} })
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
    const { installScrollIdle } = await import('../src/renderer/src/ui/scrollIdle')
    const stop = installScrollIdle()
    expect(added.get('scroll')).toBe(true)
    // The listener is on the document, so a nested element's scroll reaches it only through capture and is marked on the element that scrolled.
    const El = (globalThis as unknown as { Element: new () => { attrs: Set<string> } }).Element
    const nested = new El()
    handlers.get('scroll')!({ target: nested })
    expect(nested.attrs.has('data-scrolling')).toBe(true)
    stop()
    vi.unstubAllGlobals()
  })
})

describe('the scrollbar block in tokens.css', () => {
  it('shows the thumb for data-scrolling only, so a pointer resting on an area does not keep it', () => {
    const css = readFileSync(new URL('../src/renderer/src/tokens.css', import.meta.url), 'utf8')
    expect(css).toMatch(/:where\(\[data-scrolling\]\) \{ --scroll-thumb: var\(--line-4\);/)
    expect(css).toMatch(/transition: --scroll-thumb 200ms ease-out;/)
    expect(css).not.toMatch(/:where\([^)]*:hover[^)]*\) \{ --scroll-thumb/)
  })
})
