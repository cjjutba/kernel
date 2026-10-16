import { describe, expect, it } from 'vitest'
import { createChatScroll, HAND_MS, PLACE_MS, PRIORITY, type ScrollBox } from '../src/renderer/src/screens/workspace/chatScroll'
import { easingOf } from '../src/renderer/src/screens/workspace/scrollGlide'

/** A view with a clock that moves 16ms a frame and a frame queue, the owner's `raf`, `caf` and `now` injected. */
function rig(init: Partial<ScrollBox> = {}) {
  let t = 0
  let next = 1
  const queue = new Map<number, () => void>()
  const writes: number[] = []
  const warnings: string[] = []
  let top = init.scrollTop ?? 0
  const view: ScrollBox = {
    get scrollTop() { return top },
    set scrollTop(v: number) { top = Math.max(0, Math.min(v, view.scrollHeight - view.clientHeight)); writes.push(top) },
    scrollHeight: init.scrollHeight ?? 3000,
    clientHeight: init.clientHeight ?? 800
  }
  const owner = createChatScroll({
    box: () => view,
    env: { now: () => t, raf: (cb) => { const id = next++; queue.set(id, cb); return id }, caf: (id) => { queue.delete(id) }, reduced: () => false, ease: () => easingOf(undefined), warn: (m) => warnings.push(m) }
  })
  const tick = (ms = 16) => { t += ms; const now = [...queue.values()]; queue.clear(); now.forEach((cb) => cb()) }
  const end = () => view.scrollHeight - view.clientHeight
  return { view, owner, writes, warnings, tick, end, queued: () => queue.size, wait: (ms: number) => { for (let n = 0; n < ms / 16; n++) tick() } }
}

describe('the chat scroll owner (KERNEL-953)', () => {
  it('ranks the reader over a glide, a glide over a place, a place over a follow', () => {
    expect(PRIORITY.reader).toBeGreaterThan(PRIORITY.glide)
    expect(PRIORITY.glide).toBeGreaterThan(PRIORITY.place)
    expect(PRIORITY.place).toBeGreaterThan(PRIORITY.follow)
  })

  it('follows a thread that grew under a view at its end, once, and writes nothing when it did not change', () => {
    const r = rig({ scrollTop: 2200 })
    r.owner.resized(3000)
    expect(r.writes).toEqual([])
    r.view.scrollHeight += 120
    r.owner.resized(3120)
    expect(r.writes).toEqual([r.end()])
    r.wait(64)
    expect(r.writes).toEqual([r.end()])
  })

  it('keeps the end in view when the composer shrinks the view (the scroller resizing)', () => {
    const r = rig({ scrollTop: 2200 })
    r.view.clientHeight -= 140
    r.owner.resized()
    expect(r.view.scrollTop).toBe(r.end())
  })

  it('does not follow a reader who scrolled up', () => {
    const r = rig({ scrollTop: 2200 })
    r.owner.scrolled()
    r.owner.hand()
    r.view.scrollTop = 1000
    r.writes.length = 0
    r.owner.scrolled()
    r.wait(HAND_MS + 64)
    r.view.scrollHeight += 300
    r.owner.resized(3300)
    expect(r.owner.pinned).toBe(false)
    expect(r.writes).toEqual([])
  })

  it('drops a follow while the reader is scrolling and takes it up again once they let go', () => {
    const r = rig({ scrollTop: 2200 })
    r.owner.hand()
    r.view.scrollHeight += 100
    r.owner.resized(3100)
    expect(r.writes).toEqual([])
    expect(r.owner.intent).toBe('reader')
    r.wait(HAND_MS + 32)
    expect(r.owner.intent).toBeUndefined()
    r.owner.landed()
    expect(r.view.scrollTop).toBe(r.end())
  })

  it('a place beats a follow, and a follow cannot write while it is current', () => {
    const r = rig({ scrollTop: 0 })
    r.owner.open({ frames: () => undefined })
    expect(r.owner.intent).toBe('place')
    r.view.scrollHeight += 60
    r.owner.resized(3060)
    r.owner.follow()
    expect(r.owner.intent).toBe('place')
    expect(r.writes).toEqual([2200])
    r.tick()
    expect(r.view.scrollTop).toBe(r.end())
  })

  it('an open at the end settles after 4 still frames and gives way to following', () => {
    const r = rig({ scrollTop: 0 })
    r.owner.open({ frames: () => undefined })
    r.wait(16 * 8)
    expect(r.queued()).toBe(0)
    expect(r.owner.intent).toBeUndefined()
    r.view.scrollHeight += 90
    r.owner.resized(3090)
    expect(r.view.scrollTop).toBe(r.end())
  })

  it('an open that never settles ends after PLACE_MS', () => {
    const r = rig({ scrollTop: 0 })
    r.owner.open({ spot: () => { r.view.scrollHeight += 40; return 1000 }, frames: () => undefined })
    r.owner.resized(1)
    for (let n = 0; n < 200 && r.owner.intent === 'place'; n++) { r.view.scrollHeight += 40; r.owner.resized(1); r.tick() }
    expect(r.owner.intent).toBeUndefined()
    expect(r.queued()).toBe(0)
  })

  it('the reader ends a glide, and the glide cannot write afterwards', () => {
    const r = rig({ scrollTop: 0 })
    r.owner.toEnd()
    expect(r.owner.intent).toBe('glide')
    r.tick()
    r.owner.hand()
    expect(r.owner.intent).toBe('reader')
    const at = r.view.scrollTop
    r.wait(160)
    expect(r.view.scrollTop).toBe(at)
  })

  it('a reveal is dropped while the reader is scrolling, and replaces a place otherwise', () => {
    const r = rig({ scrollTop: 0 })
    r.owner.open({ spot: () => 1200, frames: () => undefined })
    r.owner.hand()
    r.owner.reveal({ goal: () => 500, instant: true })
    expect(r.owner.intent).toBe('reader')
    r.wait(HAND_MS + 32)
    r.owner.reveal({ goal: () => 500, instant: true })
    expect(r.owner.intent).toBe('glide')
    expect(r.view.scrollTop).toBe(500)
  })

  it('Scroll to bottom glides to the end and pins the chat', () => {
    const r = rig({ scrollTop: 2200 })
    r.owner.scrolled()
    r.owner.hand()
    r.view.scrollTop = 0
    r.owner.scrolled()
    expect(r.owner.pinned).toBe(false)
    r.owner.toEnd()
    r.wait(1500)
    expect(r.view.scrollTop).toBe(r.end())
    expect(r.owner.pinned).toBe(true)
  })

  it('opening a row at the end unpins when the thread grows from the click', () => {
    const r = rig({ scrollTop: 2200 })
    r.owner.resized(3000)
    r.owner.opened()
    r.view.scrollHeight += 200
    r.owner.resized(3200)
    expect(r.owner.pinned).toBe(false)
    expect(r.view.scrollTop).toBe(2200)
  })
})
