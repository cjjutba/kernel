import { describe, expect, it } from 'vitest'

type View = { scrollTop: number; scrollHeight: number; clientHeight: number }
type Raf = (step: () => void) => number
interface Hold { state: { settled: boolean; live: boolean }; resume: () => void; stop: () => void }
interface HoldOptions { put: () => number; ends: boolean; over: () => boolean; following: () => boolean; now: () => number; raf: Raf; caf: (id: number) => void; capMs: number; frames: (running: boolean) => void }
interface GlideRun { goal: () => number; far?: boolean; instant?: boolean; holdMs?: number; over?: () => boolean; done?: (landed: boolean, replaced?: boolean) => void }
interface Glider { start: (run: GlideRun) => void; cancel: () => void; live: () => boolean }
interface GlideEnv { now: () => number; raf: Raf; caf: (id: number) => void; reduced: () => boolean; ease: (view: View) => (x: number) => number }

const place = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/chatPlace' as string) as Promise<{ holdView: (o: HoldOptions) => Hold; restoreState: () => { see: (at: number) => boolean; settled: boolean } }>
const glide = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/scrollGlide' as string) as Promise<{ createGlider: (view: () => View | null, env: GlideEnv) => Glider; GLIDE_MAX_MS: number; easingOf: (css: string | undefined) => (x: number) => number }>
const follow = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/chatScroll' as string) as Promise<{ followsAfterScroll: (pinned: boolean, view: View, before: View, byHand: boolean) => boolean; movesToEnd: (view: View, byHand: boolean) => boolean }>
interface Owner { open: (run: { spot?: () => number; frames: (running: boolean) => void }) => void; resized: (h?: number) => void; reveal: (run: { goal: () => number; instant: boolean }) => void; intent: string | undefined; follow: () => void }
const scrollOwner = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/chatScroll' as string) as Promise<{ createChatScroll: (o: { box: () => View | null; env: GlideEnv & { warn: (m: string) => void } }) => Owner }>

type Mover = 'hold' | 'glide' | 'follow'
interface Write { frame: number; by: Mover; to: number }

/** One fake view, a clock that moves in 16ms frames, and a frame queue. Every write to `scrollTop` is recorded with the mover whose frame callback made it. */
function rig(init: Partial<View> = {}) {
  let t = 0
  let frame = 0
  let next = 1
  let by: Mover = 'follow'
  let who: () => string = () => by
  const queue = new Map<number, { cb: () => void; by: Mover }>()
  const writes: Write[] = []
  let top = init.scrollTop ?? 0
  const view: View = {
    get scrollTop() { return top },
    set scrollTop(v: number) { top = Math.max(0, Math.min(v, view.scrollHeight - view.clientHeight)); writes.push({ frame, by: who() as Mover, to: top }) },
    scrollHeight: init.scrollHeight ?? 3000,
    clientHeight: init.clientHeight ?? 800
  }
  const raf = (who: Mover): Raf => (cb) => { const id = next++; queue.set(id, { cb, by: who }); return id }
  const caf = (id: number) => { queue.delete(id) }
  const as = <T>(who_: Mover, fn: () => T): T => { const was = by; by = who_; try { return fn() } finally { by = was } }
  /** Runs the frames queued so far as one frame, 16ms later. A callback queued while it runs waits for the next. */
  const tick = (before?: () => void) => {
    t += 16
    frame++
    before?.()
    const now = [...queue]
    queue.clear()
    for (const [, q] of now) as(q.by, q.cb)
  }
  const end = () => view.scrollHeight - view.clientHeight
  const clash = () => {
    const by = new Map<number, Set<Mover>>()
    for (const w of writes) by.set(w.frame, (by.get(w.frame) ?? new Set()).add(w.by))
    return [...by].filter(([, movers]) => movers.size > 1).map(([f, movers]) => `frame ${f}: ${[...movers].join(' and ')}`)
  }
  const track = (fn: () => string) => { who = fn }
  return { view, writes, raf, caf, as, tick, track, now: () => t, frame: () => frame, queued: () => queue.size, end, clash }
}

/** What the thread does to the view when it grows or shrinks under a reader: following closes the distance when it may, as the thread's size observer does. */
const followEnd = (r: ReturnType<typeof rig>, f: Awaited<ReturnType<typeof follow>>, pinned: boolean, byHand = false) => {
  if (pinned && f.movesToEnd(r.view, byHand)) r.as('follow', () => { r.view.scrollTop = r.end() })
}

/** The owner over the rig's view. Each write is recorded with the intent that was current when it landed. */
async function owned(r: ReturnType<typeof rig>, init: { reduced?: boolean } = {}) {
  const { createChatScroll } = await scrollOwner()
  const { easingOf } = await glide()
  const warnings: string[] = []
  let o: Owner | undefined
  r.track(() => o?.intent ?? 'none')
  o = createChatScroll({ box: () => r.view, env: { now: r.now, raf: r.raf('follow'), caf: r.caf, reduced: () => !!init.reduced, ease: () => easingOf(undefined), warn: (m) => warnings.push(m) } })
  return { o, warnings }
}

describe('chat scroll races (KERNEL-952)', () => {
  describe('loops end within their cap', () => {
    it('an open at the end stops holding once capMs passes, however the thread keeps growing', async () => {
      const { holdView } = await place()
      const r = rig({ scrollTop: 0 })
      const capMs = 1500
      const hold = r.as('hold', () => holdView({ put: () => { r.view.scrollHeight += 40; r.view.scrollTop = r.end(); return r.view.scrollTop }, ends: true, over: () => false, following: () => true, now: r.now, raf: r.raf('hold'), caf: r.caf, capMs, frames: () => undefined }))
      for (let i = 0; i < 200 && r.queued(); i++) r.tick()
      expect(r.queued()).toBe(0)
      expect(r.now()).toBeLessThanOrEqual(capMs + 32)
      expect(hold.state.live).toBe(false)
    })

    it('a spot restore stops on its own once the view holds still', async () => {
      const { holdView } = await place()
      const r = rig({ scrollTop: 0 })
      r.as('hold', () => holdView({ put: () => { r.view.scrollTop = 1200; return r.view.scrollTop }, ends: false, over: () => false, following: () => false, now: r.now, raf: r.raf('hold'), caf: r.caf, capMs: 1500, frames: () => undefined }))
      for (let i = 0; i < 60 && r.queued(); i++) r.tick()
      expect(r.queued()).toBe(0)
      expect(r.frame()).toBeLessThanOrEqual(8)
    })

    it('a glide toward a goal that keeps moving still ends by GLIDE_MAX_MS', async () => {
      const { createGlider, GLIDE_MAX_MS, easingOf } = await glide()
      const r = rig()
      const g = createGlider(() => r.view, { now: r.now, raf: r.raf('glide'), caf: r.caf, reduced: () => false, ease: () => easingOf(undefined) })
      let landed: boolean | undefined
      r.as('glide', () => g.start({ goal: () => { r.view.scrollHeight += 60; return r.end() }, done: (l) => { landed = l } }))
      for (let i = 0; i < 1000 && r.queued(); i++) r.tick()
      expect(r.queued()).toBe(0)
      expect(r.now()).toBeLessThanOrEqual(GLIDE_MAX_MS + 32)
      expect(landed).toBeDefined()
    })

    it('a glide under reduced motion places the view in its first step and ends once the goal has held', async () => {
      const { createGlider, easingOf } = await glide()
      const r = rig()
      const g = createGlider(() => r.view, { now: r.now, raf: r.raf('glide'), caf: r.caf, reduced: () => true, ease: () => easingOf(undefined) })
      r.as('glide', () => g.start({ goal: () => r.end() }))
      expect(r.writes.map((w) => w.frame)).toEqual([0])
      for (let i = 0; i < 100 && r.queued(); i++) r.tick()
      expect(r.queued()).toBe(0)
      expect(r.writes).toHaveLength(1)
    })
  })

  describe('one mover writes the scroll position per frame', () => {
    // (a) A pending plan in a chat left at its end, to another tab and back. The open restore holds the view at the end while the thread settles, and the thread's growth is followed.
    it('(a) the open restore alone writes while a reopened chat settles its rows', async () => {
      const r = rig({ scrollTop: 0, scrollHeight: 2400 })
      const { o } = await owned(r)
      o.open({ frames: () => undefined })
      for (let i = 0; i < 12; i++) r.tick(() => { if (i < 6) { r.view.scrollHeight += 30; o.resized(r.view.scrollHeight) } })
      expect(r.clash()).toEqual([])
      expect(new Set(r.writes.map((w) => w.by))).toEqual(new Set(['place']))
      expect(Math.abs(r.end() - r.view.scrollTop)).toBeLessThan(1)
    })

    // (b) A pending plan taller than the view, read from its task list: the restore of that spot and a plan reveal both aim at the view.
    it('(b) a plan reveal takes over from a spot restore, and the restore writes nothing after it', async () => {
      const r = rig({ scrollTop: 0, scrollHeight: 4200 })
      const { o } = await owned(r)
      o.open({ spot: () => 3000, frames: () => undefined })
      r.tick()
      r.tick()
      // The reveal runs from an effect at the start of a frame after the one that opened the chat.
      const at = r.frame() + 1
      r.tick(() => o.reveal({ goal: () => 2600, instant: false }))
      for (let i = 0; i < 40; i++) r.tick(() => { if (i < 10) o.resized(r.view.scrollHeight) })
      expect(r.clash()).toEqual([])
      expect(r.writes.filter((w) => w.frame >= at).every((w) => w.by === 'glide')).toBe(true)
      expect(Math.abs(r.view.scrollTop - 2600)).toBeLessThan(1)
    })

    // (c) A revised plan (a new approval id) arriving while the reader is scrolled up: nothing may move the view.
    it('(c) a revised plan moves nothing while the reader is scrolled up', async () => {
      const { followsAfterScroll, movesToEnd } = await follow()
      const r = rig({ scrollTop: 1200, scrollHeight: 3000 })
      const before = { ...r.view, scrollTop: 1300 }
      const pinned = followsAfterScroll(true, r.view, before, true)
      expect(pinned).toBe(false)
      r.view.scrollHeight += 600
      for (let i = 0; i < 6; i++) r.tick(() => { if (pinned && movesToEnd(r.view, false)) r.view.scrollTop = r.end() })
      expect(r.writes).toEqual([])
    })

    // (d) The composer growing while at the end: the view is followed once per change, by one mover.
    it('(d) the composer growing under a view at its end is followed by one mover per frame', async () => {
      const f = await follow()
      const r = rig({ scrollTop: 2200, scrollHeight: 3000 })
      for (const grow of [120, 24, 24, 24, 140]) {
        r.tick(() => { r.view.clientHeight -= grow; followEnd(r, f, true) })
        expect(Math.abs(r.end() - r.view.scrollTop)).toBeLessThan(1)
      }
      expect(r.clash()).toEqual([])
      expect(new Set(r.writes.map((w) => w.frame)).size).toBe(r.writes.length)
    })

    // (e) A turn ending and folding its steps while the reader is scrolled up: the fold shrinks the thread and the browser clamps the view, which is not the reader scrolling.
    it('(e) a fold that clamps a scrolled up reader onto the end does not make them follow again', async () => {
      const { followsAfterScroll } = await follow()
      const r = rig({ scrollTop: 2000, scrollHeight: 3000 })
      const before = { ...r.view }
      r.view.scrollHeight -= 1400
      r.view.scrollTop = Math.min(r.view.scrollTop, r.end())
      r.writes.length = 0
      expect(followsAfterScroll(false, r.view, before, false)).toBe(false)
    })

    // (f) Case (a) under reduced motion: a reveal that places the view at once and the restore that holds it share the first frame.
    it('(f) under reduced motion the reveal replaces the open restore, so one mover writes each frame', async () => {
      const r = rig({ scrollTop: 0, scrollHeight: 2400 })
      const { o } = await owned(r, { reduced: true })
      o.open({ frames: () => undefined })
      r.tick(() => o.reveal({ goal: () => r.end() - 500, instant: true }))
      for (let i = 0; i < 12; i++) r.tick()
      expect(r.clash()).toEqual([])
      expect(r.writes.at(-1)?.by).toBe('glide')
    })
  })
})
