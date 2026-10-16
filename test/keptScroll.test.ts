// @vitest-environment happy-dom
import { act, createElement as h, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  aliveOf, deadKeys, flushSpots, getSpot, MAX_SPOTS, pruneSpots, readSpot, resetSpots, setSpot, spotKey, spotKeys, spotTop, STORAGE_KEY, useKeptScroll, type Spot
} from '../src/renderer/src/ui/keptScroll'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Happy-dom has no layout, so a scroller here is a column of rows whose heights are in `data-h`, in a view `view.h` tall.
const view = { h: 100 }
const tops = new WeakMap<object, number>()
const sizes = (el: Element) => [...el.children].map((c) => Number((c as HTMLElement).dataset.h ?? 0))
const total = (el: Element) => sizes(el).reduce((a, b) => a + b, 0)
const range = (el: Element) => Math.max(0, total(el) - view.h)
const protoOf = HTMLElement.prototype
const saved = Object.getOwnPropertyDescriptors(protoOf)

beforeAll(() => {
  Object.defineProperty(protoOf, 'scrollTop', { configurable: true, get() { return tops.get(this) ?? 0 }, set(n: number) { if ((this as HTMLElement).dataset.view) tops.set(this, Math.max(0, Math.min(range(this), n))) } })
  Object.defineProperty(protoOf, 'scrollHeight', { configurable: true, get() { return total(this) } })
  Object.defineProperty(protoOf, 'clientHeight', { configurable: true, get() { return (this as HTMLElement).dataset.view ? view.h : 0 } })
  protoOf.getBoundingClientRect = function (this: HTMLElement) {
    const box = (top: number, height: number) => ({ top, height, left: 0, width: 100, right: 100, bottom: top + height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    if (this.dataset.view) return box(0, view.h)
    const parent = this.parentElement!
    const at = [...parent.children].indexOf(this)
    const before = sizes(parent).slice(0, at).reduce((a, b) => a + b, 0)
    return box(before - (tops.get(parent) ?? 0), Number(this.dataset.h))
  }
})
afterAll(() => { for (const k of ['scrollTop', 'scrollHeight', 'clientHeight', 'getBoundingClientRect'] as const) { if (saved[k]) Object.defineProperty(protoOf, k, saved[k]); else delete (protoOf as unknown as Record<string, unknown>)[k] } })

interface Row { id: string; h: number }
const rows = (n: number, h = 50, from = 0): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${from + i}`, h }))

function Probe({ k, ready = true, list, target }: { k: string; ready?: boolean; list: Row[]; target?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useKeptScroll(ref, { key: k, ready, target })
  return h('div', { ref, 'data-view': '1' }, list.map((r) => h('div', { key: r.id, 'data-keep-id': r.id, 'data-h': r.h })))
}

let root: Root | null = null
const host = () => document.querySelector('[data-view]') as HTMLElement
const mount = (props: Parameters<typeof Probe>[0]) => {
  document.body.innerHTML = '<div id="app"></div>'
  root = createRoot(document.getElementById('app')!)
  act(() => root!.render(h(Probe, props)))
}
const leave = () => { act(() => root!.unmount()); root = null }
/** Frames pass until a restore has settled. */
const settle = () => act(() => { vi.advanceTimersByTime(800) })
const scrollTo = (n: number) => { const el = host(); el.scrollTop = n; act(() => { el.dispatchEvent(new Event('scroll')) }) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'performance'] })
  view.h = 100
  localStorage.clear()
  resetSpots()
})
afterEach(() => { if (root) leave(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('readSpot and spotTop', () => {
  const items = [{ id: 'a', start: 0, size: 40 }, { id: 'b', start: 40, size: 40 }, { id: 'c', start: 80, size: 40 }, { id: 'd', start: 120, size: 40 }]

  it('anchors on the item at the top plus two above it', () => {
    const s = readSpot(items, 130, 500)
    expect(s.anchors).toEqual([{ id: 'd', offset: 10 }, { id: 'c', offset: 50 }, { id: 'b', offset: 90 }])
    expect(s.end).toBe(false)
  })

  it('falls back through the anchors, then to the raw position, and clamps', () => {
    const s = readSpot(items, 130, 500)
    expect(spotTop(s, (id) => ({ d: 220, c: 180 })[id], 500)).toBe(230)
    expect(spotTop(s, (id) => ({ c: 180 })[id], 500)).toBe(230)
    expect(spotTop(s, () => undefined, 500)).toBe(130)
    expect(spotTop(s, () => undefined, 60)).toBe(60)
    expect(spotTop(s, () => 10_000, 500)).toBe(500)
  })

  it('counts within 2px of the end as the end, and reopens at the new end', () => {
    expect(readSpot(items, 398, 400).end).toBe(true)
    expect(readSpot(items, 397, 400).end).toBe(false)
    expect(spotTop(readSpot(items, 400, 400), () => 0, 900)).toBe(900)
  })
})

describe('useKeptScroll', () => {
  it('lands on the same pixel through 50 cycles of leaving and coming back', () => {
    mount({ k: 'prs:open', list: rows(200) })
    scrollTo(1234)
    const first = getSpot('prs:open')
    for (let i = 0; i < 50; i++) {
      leave()
      mount({ k: 'prs:open', list: rows(200) })
      settle()
      expect(host().scrollTop).toBe(1234)
    }
    expect(getSpot('prs:open')).toEqual(first)
  })

  it('holds the anchor when items are added above and falls back when one is gone', () => {
    mount({ k: 'k', list: rows(200) })
    scrollTo(1240)
    leave()
    mount({ k: 'k', list: [...rows(3, 50, 1000), ...rows(200)] })
    settle()
    expect(host().scrollTop).toBe(1240 + 150)
    leave()
    // r24 is the top item (1240 / 50), gone: r23 above it takes over, 40px into it.
    mount({ k: 'k', list: [...rows(24), ...rows(175, 50, 25)] })
    settle()
    expect(host().scrollTop).toBe(23 * 50 + 90)
  })

  it('applies the anchor and offset after a resize', () => {
    mount({ k: 'k', list: rows(200) })
    scrollTo(1240)
    leave()
    view.h = 400
    mount({ k: 'k', list: rows(200) })
    settle()
    expect(host().scrollTop).toBe(1240)
  })

  it('clamps a shorter view to its end and keeps the saved spot until the reader moves', () => {
    mount({ k: 'k', list: rows(200) })
    scrollTo(1240)
    const before = getSpot('k')
    leave()
    mount({ k: 'k', list: rows(10) })
    settle()
    expect(host().scrollTop).toBe(400)
    scrollTo(400)
    leave()
    expect(getSpot('k')).toEqual(before)
  })

  it('reopens a view left at its end at its new end', () => {
    mount({ k: 'k', list: rows(20) })
    scrollTo(900)
    expect(getSpot('k')?.end).toBe(true)
    leave()
    mount({ k: 'k', list: rows(30) })
    settle()
    expect(host().scrollTop).toBe(1400)
  })

  it('does not save before ready, and restores once it is', () => {
    setSpot('k', readSpot([{ id: 'r10', start: 500, size: 50 }], 520, 9000))
    mount({ k: 'k', ready: false, list: [] })
    scrollTo(0)
    expect(getSpot('k')?.anchors[0]).toEqual({ id: 'r10', offset: 20 })
    act(() => root!.render(h(Probe, { k: 'k', ready: true, list: rows(200) })))
    settle()
    expect(host().scrollTop).toBe(520)
  })

  it('does not save while a restore is still correcting', () => {
    mount({ k: 'k', list: rows(200) })
    scrollTo(1000)
    const before = getSpot('k')
    leave()
    mount({ k: 'k', list: rows(200) })
    scrollTo(30)
    expect(getSpot('k')).toEqual(before)
  })

  it('stops a restore at once when the reader scrolls', () => {
    mount({ k: 'k', list: rows(200) })
    scrollTo(1000)
    leave()
    mount({ k: 'k', list: rows(200) })
    const el = host()
    act(() => { el.dispatchEvent(new Event('wheel')) })
    el.scrollTop = 300
    settle()
    expect(el.scrollTop).toBe(300)
  })

  it('leaves the saved spot alone when the view is going somewhere on purpose', () => {
    mount({ k: 'k', list: rows(200) })
    scrollTo(1000)
    leave()
    mount({ k: 'k', list: rows(200), target: true })
    settle()
    expect(host().scrollTop).toBe(0)
  })

  it('starts a key it has no spot for at the top', () => {
    mount({ k: 'prs:open', list: rows(200) })
    scrollTo(1000)
    act(() => root!.render(h(Probe, { k: 'prs:merged', list: rows(200) })))
    settle()
    expect(host().scrollTop).toBe(0)
    act(() => root!.render(h(Probe, { k: 'prs:open', list: rows(200) })))
    settle()
    expect(host().scrollTop).toBe(1000)
  })
})

describe('the spot store', () => {
  const spot = (n: number): Spot => ({ anchors: [{ id: `r${n}`, offset: 0 }], pos: n, end: false })

  it('keeps at most 300 spots and drops the least recently used first', () => {
    for (let i = 0; i < MAX_SPOTS; i++) setSpot(`prs:${i}`, spot(i))
    getSpot('prs:0')
    setSpot('prs:new', spot(1))
    expect(spotKeys()).toHaveLength(MAX_SPOTS)
    expect(getSpot('prs:1')).toBeUndefined()
    expect(getSpot('prs:0')).toBeDefined()
  })

  it('writes to localStorage after a short delay under a versioned key, and reads it back', () => {
    setSpot('prs:open', spot(7))
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    act(() => { vi.advanceTimersByTime(500) })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).v).toBe(1)
    resetSpots()
    expect(getSpot('prs:open')).toEqual(spot(7))
  })

  it('ignores spots saved under another version', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, spots: [['prs:open', spot(7)]] }))
    expect(getSpot('prs:open')).toBeUndefined()
    localStorage.setItem(STORAGE_KEY, '{not json')
    resetSpots()
    expect(spotKeys()).toEqual([])
  })

  it('keeps working when localStorage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => { setSpot('prs:open', spot(3)); flushSpots() }).not.toThrow()
    expect(getSpot('prs:open')).toEqual(spot(3))
  })

  it('builds keys', () => {
    expect(spotKey.prs('open')).toBe('prs:open')
    expect(spotKey.issues('p1')).toBe('issues:p1')
    expect(spotKey.settings('project', 'scripts', 'p1')).toBe('settings:project:p1:scripts')
    expect(spotKey.panel('w1', 'changes')).toBe('panel:w1:changes')
    expect(spotKey.chat('c1')).toBe('chat:c1')
  })

  describe('pruning', () => {
    const store = {
      projects: [{ id: 'p1', archived: false }, { id: 'p2', archived: true }],
      workspaces: [{ id: 'w1', status: 'ready' }, { id: 'w2', status: 'archived' }],
      chats: { w1: [{ id: 'c1', closed: false }, { id: 'c2', closed: true }], w2: [{ id: 'c3', closed: false }] }
    } as unknown as Parameters<typeof aliveOf>[0]
    const keys = ['prs:open', 'issues:p1', 'issues:p2', 'issues:gone', 'settings:project:p2:scripts', 'panel:w1:changes', 'panel:w2:changes', 'chat:c1', 'chat:c2', 'chat:c3', 'chat:nope']

    it('drops archived and deleted projects, workspaces and chats', () => {
      expect(deadKeys(keys, aliveOf(store))).toEqual(['issues:p2', 'issues:gone', 'settings:project:p2:scripts', 'panel:w2:changes', 'chat:c2', 'chat:c3', 'chat:nope'])
    })

    it('judges nothing that has not loaded yet', () => {
      expect(deadKeys(keys, aliveOf({ projects: [], workspaces: [], chats: {} }))).toEqual([])
      // w1's chats have not arrived, so a chat key can't be judged.
      expect(deadKeys(['chat:c1'], aliveOf({ ...store, chats: {} }))).toEqual([])
    })

    it('removes them from the store', () => {
      keys.forEach((k, i) => setSpot(k, spot(i)))
      pruneSpots(aliveOf(store))
      expect(spotKeys()).toEqual(['prs:open', 'issues:p1', 'panel:w1:changes', 'chat:c1'])
    })
  })
})
