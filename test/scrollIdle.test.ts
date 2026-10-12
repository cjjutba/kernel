import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScrollActivity, type ScrollTarget } from '../src/renderer/src/ui/scrollIdle'

// The activity behind the scrollbar thumb: marked while in use, cleared a second after the last use, held while a native scrollbar is pressed (KERNEL-602 amended).
class Fake implements ScrollTarget {
  attrs = new Set<string>()
  setAttribute(name: string) { this.attrs.add(name) }
  removeAttribute(name: string) { this.attrs.delete(name) }
  get shown() { return this.attrs.has('data-scrolling') }
}

describe('createScrollActivity', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the thumb on activity and hides it a second after the last one', () => {
    const a = createScrollActivity(1000)
    const el = new Fake()
    a.touch(el)
    expect(el.shown).toBe(true)
    vi.advanceTimersByTime(999)
    expect(el.shown).toBe(true)
    vi.advanceTimersByTime(1)
    expect(el.shown).toBe(false)
  })

  it('restarts the countdown on every touch', () => {
    const a = createScrollActivity(1000)
    const el = new Fake()
    a.touch(el)
    vi.advanceTimersByTime(800)
    a.touch(el)
    vi.advanceTimersByTime(800)
    expect(el.shown).toBe(true)
    vi.advanceTimersByTime(200)
    expect(el.shown).toBe(false)
  })

  it('keeps each scroller on its own clock', () => {
    const a = createScrollActivity(1000)
    const [one, two] = [new Fake(), new Fake()]
    a.touch(one)
    vi.advanceTimersByTime(600)
    a.touch(two)
    vi.advanceTimersByTime(400)
    expect([one.shown, two.shown]).toEqual([false, true])
  })

  it('holds the thumb up while pressed, however long, and fades a second after release', () => {
    const a = createScrollActivity(1000)
    const el = new Fake()
    a.hold(el)
    vi.advanceTimersByTime(60_000)
    expect(el.shown).toBe(true)
    a.touch(el) // scrolling while the thumb is dragged
    vi.advanceTimersByTime(5000)
    expect(el.shown).toBe(true)
    a.release(el)
    vi.advanceTimersByTime(999)
    expect(el.shown).toBe(true)
    vi.advanceTimersByTime(1)
    expect(el.shown).toBe(false)
  })

  it('ignores a release for something that was not held', () => {
    const a = createScrollActivity(1000)
    const el = new Fake()
    a.release(el)
    expect(el.shown).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose clears every mark and timer', () => {
    const a = createScrollActivity(1000)
    const [one, two] = [new Fake(), new Fake()]
    a.touch(one)
    a.hold(two)
    a.dispose()
    expect([one.shown, two.shown]).toEqual([false, false])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the scrollbar block in tokens.css', () => {
  it('shows the thumb for data-scrolling only, so a pointer resting on an area does not keep it', () => {
    const css = readFileSync(new URL('../src/renderer/src/tokens.css', import.meta.url), 'utf8')
    expect(css).toMatch(/:where\(\[data-scrolling\]\) \{ --scroll-thumb: var\(--line-4\);/)
    expect(css).not.toMatch(/:where\([^)]*:hover[^)]*\) \{ --scroll-thumb/)
  })
})
