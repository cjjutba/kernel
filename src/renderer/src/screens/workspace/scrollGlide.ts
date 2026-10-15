/**
 * How long a glide of `distance` pixels takes, and its curve, fitted to Chromium's own smooth scroll (about 420ms for 600px, 165ms for 110px). The curve is
 * `--ease-glide` in tokens.css (KERNEL-859); `GLIDE_EASING` is the fallback when the token can't be read.
 */
export const glideMs = (distance: number) => Math.round(Math.min(700, Math.max(120, Math.sqrt(Math.abs(distance)) * 17)))
export const GLIDE_EASING = 'cubic-bezier(0.45, 0, 0.05, 1)'

/** A glide first jumps to one screen above its goal when the goal is more than this many screens away (KERNEL-833). */
export const GLIDE_FAR = 1.5

/** A glide ends once its goal has held within a pixel this long, and gives up this long after it started. */
export const GLIDE_CALM_MS = 200
export const GLIDE_MAX_MS = 5000

/** Where a glide starts: the view itself, or one screen above its goal when that is further off than GLIDE_FAR screens. */
export const glideStart = (scrollTop: number, goal: number, clientHeight: number) => (goal - scrollTop > GLIDE_FAR * clientHeight ? goal - clientHeight : scrollTop)

/** The curve y(x) of `cubic-bezier(x1, y1, x2, y2)`, solved for x by bisection. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const at = (a: number, b: number, t: number) => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (at(x1, x2, mid) < x) lo = mid
      else hi = mid
    }
    return at(y1, y2, (lo + hi) / 2)
  }
}

const NUMBER = '(-?\\d*\\.?\\d+)'
const BEZIER = new RegExp(`cubic-bezier\\(\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*\\)`)

/** The curve a CSS `cubic-bezier(...)` names, or the glide's own when the text names none. */
export function easingOf(css: string | undefined): (x: number) => number {
  const m = BEZIER.exec(css ?? '') ?? BEZIER.exec(GLIDE_EASING)!
  return bezier(+m[1], +m[2], +m[3], +m[4])
}

/**
 * Where one frame of a glide puts the view. `from` and `to` are how far along the eased curve the glide was at the last frame and is at this one (0 to 1).
 * The view takes `to - from` of what the curve had left, so a goal that moves is followed from where the view is, with no restart and no jump, and a goal that holds
 * still gives exactly the curve itself at any frame rate: two half-length frames land where one whole frame does.
 */
export const glideStep = (scrollTop: number, goal: number, from: number, to: number) => {
  if (to >= 1 || from >= 1) return goal
  if (to <= from) return scrollTop
  return scrollTop + ((goal - scrollTop) * (to - from)) / (1 - from)
}

export interface GlideView { scrollTop: number; clientHeight: number; scrollHeight?: number }

export interface GlideEnv {
  now: () => number
  raf: (cb: () => void) => number
  caf: (id: number) => void
  reduced: () => boolean
  ease: (view: GlideView) => (x: number) => number
}

const clampGoal = (view: GlideView, goal: number) => (view.scrollHeight === undefined ? goal : Math.max(0, Math.min(goal, view.scrollHeight - view.clientHeight)))

const cssEase = (view: GlideView) => {
  const el = view as Partial<Element>
  return easingOf(typeof getComputedStyle === 'function' && el.nodeType === 1 ? getComputedStyle(el as Element).getPropertyValue('--ease-glide') : undefined)
}

export const browserGlide: GlideEnv = {
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  reduced: () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  ease: cssEase
}

export interface GlideRun {
  /** Where the view should end up, asked again every frame so a goal that moves is followed. */
  goal: () => number
  /** Jump to one screen above a goal that is far away, then glide the rest. */
  far?: boolean
  /** Place the view with no motion, still following the goal until it holds. */
  instant?: boolean
  /** Keep following the goal for at least this long, even if it holds still. */
  holdMs?: number
  /** True when the glide is no longer wanted (the reader took over, the target is gone). It ends without calling `done(true)`. */
  over?: () => boolean
  /** Called once when the run ends. `replaced` is true when another `start` took over mid-run, so its cleanup still runs. `cancel` calls nothing. */
  done?: (landed: boolean, replaced?: boolean) => void
}

export interface Glider {
  /** Starts a glide, replacing the one under way. The first step runs now. */
  start: (run: GlideRun) => void
  /** Ends the glide where it is. Nothing is called. */
  cancel: () => void
  live: () => boolean
}

/**
 * The one engine for every scroll Kernel makes on its own (KERNEL-862): a send, Scroll to bottom, the chat rail, Approve and a plan revealing itself. It is time-based, so
 * a 120Hz screen takes the same time as a 60Hz one. It follows its goal from where the view is, never restarts, eases into the end with no snap, and places the view at once
 * under reduced motion. When a glide has run its length and the goal has moved on, the view eases on to it in a new, shorter glide that starts at rest.
 */
export function createGlider(view: () => GlideView | null, env: GlideEnv = browserGlide): Glider {
  let frame = 0
  let running = false
  let run: GlideRun | undefined
  let token = 0

  const cancel = () => {
    token++
    running = false
    run = undefined
    env.caf(frame)
  }

  const start = (next: GlideRun) => {
    const replaced = run
    cancel()
    replaced?.done?.(false, true)
    const mine = token
    const el = view()
    if (!el) { next.done?.(false); return }
    run = next
    running = true
    const began = env.now()
    const instant = !!next.instant || env.reduced()
    const ease = instant ? undefined : env.ease(el)
    if (next.far && !instant) el.scrollTop = glideStart(el.scrollTop, clampGoal(el, next.goal()), el.clientHeight)
    let segment = began
    let ms = glideMs(clampGoal(el, next.goal()) - el.scrollTop)
    let before = 0
    let held = NaN

    const finish = (landed: boolean) => {
      if (token !== mine) return
      running = false
      run = undefined
      next.done?.(landed)
    }

    const step = () => {
      if (token !== mine) return
      const box = view()
      if (!box || next.over?.()) { finish(false); return }
      const now = env.now()
      const goal = clampGoal(box, next.goal())
      if (!ease) {
        if (Math.abs(goal - box.scrollTop) >= 1) box.scrollTop = goal
      } else {
        if (before >= 1 && Math.abs(goal - box.scrollTop) >= 1) {
          segment = now
          ms = glideMs(goal - box.scrollTop)
          before = 0
        }
        const to = ease(Math.min(1, (now - segment) / ms))
        const target = glideStep(box.scrollTop, goal, before, to)
        before = to
        if (target !== box.scrollTop) box.scrollTop = target
      }
      if (Math.abs(goal - box.scrollTop) < 1) {
        if (Number.isNaN(held)) held = now
      } else held = NaN
      const calm = !Number.isNaN(held) && now - held >= GLIDE_CALM_MS && now - began >= (next.holdMs ?? 0)
      if (calm || now - began >= GLIDE_MAX_MS) { finish(true); return }
      frame = env.raf(step)
    }
    step()
  }

  return { start, cancel, live: () => running }
}
