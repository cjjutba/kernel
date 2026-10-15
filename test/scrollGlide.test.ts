import { describe, expect, it } from 'vitest'
import { bezier, createGlider, glideMs, easingOf, glideStep, GLIDE_EASING, type GlideEnv, type GlideView } from '../src/renderer/src/screens/workspace/scrollGlide'

const ease = easingOf(GLIDE_EASING)

/** A clock and a frame queue, stepped by hand at a chosen frame time. */
function clock(reduced = false) {
  let t = 0
  let next: (() => void) | undefined
  const env: GlideEnv = { now: () => t, raf: (cb) => { next = cb; return 1 }, caf: () => { next = undefined }, reduced: () => reduced, ease: () => ease }
  const frame = (ms: number) => { t += ms; const cb = next; next = undefined; cb?.() }
  return { env, frame, now: () => t }
}

const run = (frameMs: number, goal: (t: number) => number, until: number, opts: { from?: number } = {}) => {
  const c = clock()
  const view: GlideView = { scrollTop: opts.from ?? 0, clientHeight: 600 }
  const g = createGlider(() => view, c.env)
  const trace: Array<[number, number]> = []
  g.start({ goal: () => goal(c.now()) })
  trace.push([c.now(), view.scrollTop])
  while (c.now() < until) { c.frame(frameMs); trace.push([c.now(), view.scrollTop]) }
  return { trace, view, live: g.live() }
}

describe('glideStep', () => {
  it('follows the curve and lands on the goal at the end', () => {
    expect(glideStep(0, 100, 0, 0.5)).toBe(50)
    expect(glideStep(50, 100, 0.5, 1)).toBe(100)
    expect(glideStep(40, 100, 0.5, 0.5)).toBe(40)
  })

  it('takes the same share of what is left however the time is cut', () => {
    const whole = glideStep(0, 200, 0, 0.8)
    const half = glideStep(glideStep(0, 200, 0, 0.3), 200, 0.3, 0.8)
    expect(half).toBeCloseTo(whole, 9)
  })
})

describe('the glide at 60Hz and 120Hz', () => {
  it('is at the same place at the same time', () => {
    const slow = run(1000 / 60, () => 600, 300)
    const fast = run(1000 / 120, () => 600, 300)
    const at = (r: typeof slow, ms: number) => r.trace.reduce((best, p) => (Math.abs(p[0] - ms) < Math.abs(best[0] - ms) ? p : best))
    for (const ms of [50, 100, 150, 200, 250]) {
      const a = at(slow, ms)
      const b = at(fast, a[0])
      expect(Math.abs(a[1] - b[1])).toBeLessThan(0.01)
    }
  })

  it('eases into the end: the last frames move by less than a pixel step before it lands', () => {
    const r = run(1000 / 60, () => 600, 600)
    const moves = r.trace.slice(1).map((p, i) => p[1] - r.trace[i][1])
    const last = moves.filter((m) => m > 0).slice(-3)
    expect(Math.max(...last)).toBeLessThan(6)
    expect(r.view.scrollTop).toBe(600)
    expect(moves.every((m) => m >= 0)).toBe(true)
  })

  it('follows a goal that moves without restarting or jumping back', () => {
    const r = run(1000 / 60, (t) => (t < 100 ? 600 : 900), 700)
    const moves = r.trace.slice(1).map((p, i) => p[1] - r.trace[i][1])
    expect(moves.every((m) => m >= 0)).toBe(true)
    const still = run(1000 / 60, () => 900, 700)
    const peak = (r: typeof still) => Math.max(...r.trace.slice(1).map((p, i) => p[1] - r.trace[i][1]))
    expect(peak(r)).toBeLessThan(peak(still) * 1.5)
    expect(moves.slice(0, 15).every((m) => m > 0)).toBe(true)
    expect(r.view.scrollTop).toBe(900)
  })

  it('places the view at once under reduced motion', () => {
    const c = clock(true)
    const view: GlideView = { scrollTop: 0, clientHeight: 600 }
    createGlider(() => view, c.env).start({ goal: () => 500 })
    expect(view.scrollTop).toBe(500)
  })

  it('ends without calling done(true) when the run is over, and never again after cancel', () => {
    const c = clock()
    const view: GlideView = { scrollTop: 0, clientHeight: 600 }
    const g = createGlider(() => view, c.env)
    const calls: boolean[] = []
    let over = false
    g.start({ goal: () => 500, over: () => over, done: (l) => calls.push(l) })
    c.frame(16)
    over = true
    c.frame(16)
    expect(calls).toEqual([false])
    g.start({ goal: () => 500, done: (l) => calls.push(l) })
    g.cancel()
    c.frame(16)
    expect(calls).toEqual([false])
    expect(g.live()).toBe(false)
  })

  it('runs the cleanup of a glide that another start replaces mid-run', () => {
    const c = clock()
    const view: GlideView = { scrollTop: 0, clientHeight: 600 }
    const g = createGlider(() => view, c.env)
    const first: Array<[boolean, boolean | undefined]> = []
    const second: Array<[boolean, boolean | undefined]> = []
    g.start({ goal: () => 500, done: (l, r) => first.push([l, r]) })
    c.frame(16)
    g.start({ goal: () => 500, done: (l, r) => second.push([l, r]) })
    expect(first).toEqual([[false, true]])
    expect(second).toEqual([])
    c.frame(16)
    expect(first).toEqual([[false, true]])
    expect(g.live()).toBe(true)
  })
})

describe('bezier', () => {
  it('is 0 to 1 and eases in and out for the glide curve', () => {
    const f = bezier(0.45, 0, 0.05, 1)
    expect(f(0)).toBe(0)
    expect(f(1)).toBe(1)
    expect(f(0.1)).toBeLessThan(0.1)
    expect(f(0.9)).toBeGreaterThan(0.9)
  })
})

describe('one glide for Scroll to bottom and a rail jump (KERNEL-891)', () => {
  const frames = [1000 / 60, 1000 / 120]
  const atTime = (r: ReturnType<typeof run>, ms: number) => r.trace.reduce((best, p) => (Math.abs(p[0] - ms) < Math.abs(best[0] - ms) ? p : best))

  it('takes longer for a longer jump, up to a cap', () => {
    expect(glideMs(60)).toBeLessThan(glideMs(600))
    expect(glideMs(600)).toBeLessThan(glideMs(3000))
    expect(glideMs(100000)).toBe(700)
    expect(glideMs(1)).toBe(120)
  })

  it('lands on the end after the same time at 60Hz and 120Hz, for a short and a long distance', () => {
    for (const goal of [90, 1500]) {
      const [a, b] = frames.map((f) => run(f, () => goal, 1200))
      expect(a.view.scrollTop).toBe(goal)
      expect(b.view.scrollTop).toBe(goal)
      for (const ms of [40, 80, 120]) expect(Math.abs(atTime(a, ms)[1] - atTime(b, atTime(a, ms)[0])[1])).toBeLessThan(0.01)
    }
  })

  it('reaches the end of a target that keeps moving without going back or snapping, at either frame rate', () => {
    for (const f of frames) {
      const r = run(f, (t) => 800 + Math.min(t, 300), 1500)
      const moves = r.trace.slice(1).map((p, i) => p[1] - r.trace[i][1])
      expect(moves.every((m) => m >= 0)).toBe(true)
      expect(r.view.scrollTop).toBe(1100)
      const tail = moves.filter((m) => m > 0).slice(-3)
      expect(Math.max(...tail)).toBeLessThan(8)
    }
  })

  it('moves every frame of the glide and never by more than the distance left', () => {
    const r = run(1000 / 60, () => 600, 700)
    const moves = r.trace.slice(1).map((p, i) => p[1] - r.trace[i][1])
    expect(moves.filter((m) => m > 0).length).toBeGreaterThan(10)
    r.trace.forEach((p) => expect(p[1]).toBeLessThanOrEqual(600))
  })
})
