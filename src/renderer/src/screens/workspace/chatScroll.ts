import { holdView } from './chatPlace'
import { browserGlide, createGlider, type GlideEnv, type GlideRun, type GlideView } from './scrollGlide'

/** The numbers a scroll position is read from, so the rules below run without a layout engine. */
export interface ScrollView { scrollTop: number; scrollHeight: number; clientHeight: number }

/** The reader counts as following the chat while the end is this close. */
export const PIN_PX = 80

/** How long the reader's input counts as scrolling with no scroll event after it. A pull past the end moves nothing and never fires scrollend. */
export const HAND_MS = 200

/** An open that hasn't settled by now is left where it is. */
export const PLACE_MS = 1500

const distFromEnd = (v: ScrollView) => v.scrollHeight - v.scrollTop - v.clientHeight

const rangeOf = (v: ScrollView) => Math.max(0, v.scrollHeight - v.clientHeight)

/**
 * Whether the chat keeps following its end after a scroll event (KERNEL-605). `before` is the view at the last scroll event, and `byHand` is
 * whether the reader's own input (wheel, touch, scrolling keys, the scrollbar, a jump from the chat rail) is behind this scroll.
 * - The view moving up unpins when the reader did it, even by a little, or the next streamed line would pull them straight back. A move nobody
 *   asked for unpins once it lands past PIN_PX, which is how the plan card opening a long plan at its top stops the following.
 * - The reader's scrolling never changes the scroll range. When it changed, layout moved the view, so input that came first doesn't make it theirs:
 *   a question answered by keyboard collapses its card and the browser clamps the view up, with `byHand` still set from the keys.
 * - A reader who is not following stays so when layout alone shrinks the range under them: a fold that clamps the view onto the end is not them scrolling there (KERNEL-953).
 * - Anything else only ever follows. The end within PIN_PX means following, and a thread that grew under a view at its end moves no scroll
 *   position, only the distance, which the size observer closes. Our own scroll to the end and the browser clamping or anchoring
 *   the view after rows resize therefore never unpin.
 */
export function followsAfterScroll(pinned: boolean, view: ScrollView, before: ScrollView, byHand: boolean): boolean {
  const own = byHand && rangeOf(view) === rangeOf(before)
  if (view.scrollTop < before.scrollTop && (own || distFromEnd(view) > PIN_PX)) return false
  if (!pinned && !byHand && rangeOf(view) < rangeOf(before)) return false
  return distFromEnd(view) <= PIN_PX ? true : pinned
}

/**
 * Whether following may move the view (KERNEL-629). Not while the reader's own gesture or its momentum is under way, and not when the view is already
 * at its end, since a jump there cuts the native rubber-band bounce short. Following resumes once the scroll lands.
 */
export const movesToEnd = (view: ScrollView, byHand: boolean) => !byHand && distFromEnd(view) >= 1

/**
 * What is moving the transcript, highest first (KERNEL-953). One is current at a time.
 * - `reader`: their wheel, touch, keys or scrollbar, until the gesture and its momentum end.
 * - `glide`: a scroll Kernel makes with the glider: Scroll to bottom, the chat rail's jump, a plan revealing itself.
 * - `place`: a chat opening at its spot or its end.
 * - `follow`: keeping the end in view as the thread or the view changes size.
 */
export type Intent = 'reader' | 'glide' | 'place' | 'follow'

export const PRIORITY: Record<Intent, number> = { follow: 0, place: 1, glide: 2, reader: 3 }

export interface ScrollBox extends ScrollView { scrollTop: number }

export interface ScrollEnv extends Pick<GlideEnv, 'now' | 'raf' | 'caf' | 'reduced' | 'ease'> {
  /** Called once per pair of movers when a write from an intent that is not current is dropped. Development only. */
  warn: (message: string) => void
}

export const browserScroll: ScrollEnv = {
  ...browserGlide,
  warn: (message) => { if (import.meta.env.DEV) console.warn(message) }
}

export interface ChatScrollOptions {
  box: () => ScrollBox | null
  /** Whether the Scroll to bottom button should show: the reader is away from the end and not following it. Called whenever that may have changed. */
  away?: (on: boolean) => void
  env?: ScrollEnv
}

interface Current {
  kind: Intent
  id: number
  from: number
  /** A place that puts the view at a spot and not at the end. */
  spot?: boolean
  hold?: ReturnType<typeof holdView>
  frame?: number
}

export interface PlaceRun {
  /** The scrollTop of the spot to put the view at. Left out, the view is put at the end. */
  spot?: () => number
  /** Called whenever the frames stop, and when they start again for a spot. */
  frames: (running: boolean) => void
}

/**
 * The one owner of the transcript's scroll position (KERNEL-953). Every move goes through an intent, and one intent is current at a time:
 * the reader beats a glide, a glide beats a place, a place beats a follow. A request at a lower priority than the current intent is dropped;
 * one at the same or higher priority replaces it and ends it. A write from an intent that isn't current is dropped, with one warning in
 * development naming both movers.
 *
 * Time limits: a place ends once it has settled (4 still frames) or after PLACE_MS, a glide after GLIDE_MAX_MS, the reader's when their gesture
 * lapses, and a follow writes only when the view is off the end, once now and once more a frame later.
 *
 * Browser scroll anchoring stays on. It is the one mover outside this owner: it holds a reader's rows in place when rows above them resize,
 * and only ever acts while the reader is the one scrolling or nothing is current.
 */
export function createChatScroll(o: ChatScrollOptions) {
  const env = o.env ?? browserScroll
  let cur: Current | undefined
  let seq = 0
  let pinned = true
  let handUntil = 0
  let opening = false
  let height = 0
  let seen: ScrollView = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }
  const warned = new Set<string>()

  const byHand = () => env.now() < handUntil
  const snap = (v: ScrollView): ScrollView => ({ scrollTop: v.scrollTop, scrollHeight: v.scrollHeight, clientHeight: v.clientHeight })
  const sync = () => {
    const box = o.box()
    o.away?.(!!box && !pinned && distFromEnd(box) > PIN_PX)
  }
  const setPinned = (on: boolean) => { pinned = on; sync() }

  // The glider writes through this view, so a glide that is no longer current can't move the transcript.
  const view: ScrollBox = {
    get scrollTop() { return o.box()?.scrollTop ?? 0 },
    set scrollTop(v: number) {
      const box = o.box()
      const c = current()
      if (!box) return
      if (c?.kind === 'glide') box.scrollTop = v
      else if (c) dropped('glide', c.kind)
    },
    get scrollHeight() { return o.box()?.scrollHeight ?? 0 },
    get clientHeight() { return o.box()?.clientHeight ?? 0 }
  }
  const glider = createGlider(() => (o.box() ? view : null), { ...env, ease: () => env.ease((o.box() ?? view) as GlideView) })

  const dropped = (mover: Intent, current: Intent) => {
    const key = `${mover}>${current}`
    if (warned.has(key)) return
    warned.add(key)
    env.warn(`chatScroll: a ${mover} write was dropped because ${current} is the current mover`)
  }

  const end = (c: Current, by?: Intent) => {
    if (cur !== c) return
    cur = undefined
    if (c.kind === 'place') c.hold?.stop()
    else if (c.kind === 'follow') { if (c.frame) env.caf(c.frame); c.frame = 0 }
    else if (c.kind === 'glide' && by !== 'glide') glider.cancel()
  }

  /** The current intent, after ending the ones whose time is up. */
  const current = (): Current | undefined => {
    const c = cur
    if (!c) return undefined
    const over = c.kind === 'reader' ? !byHand()
      : c.kind === 'place' ? c.hold?.state.live === false || env.now() - c.from >= PLACE_MS
      : c.kind === 'glide' ? !glider.live()
      : false
    if (over) { end(c); return undefined }
    return c
  }

  /** Makes `kind` current, ending what it replaces. Undefined when something of higher priority is current. */
  const begin = (kind: Intent): Current | undefined => {
    const c = current()
    if (c && PRIORITY[c.kind] > PRIORITY[kind]) return undefined
    if (c) end(c, kind)
    return (cur = { kind, id: ++seq, from: env.now() })
  }

  const write = (c: Current, to: number, remember = false): boolean => {
    const box = o.box()
    if (!box) return false
    const now = current()
    if (now !== c) {
      if (now) dropped(c.kind, now.kind)
      return false
    }
    box.scrollTop = to
    if (remember) seen = snap(box)
    return true
  }

  /** Follows the end now, and once more a frame later: rows far above the end are measured a frame after they first show, so the end moves once. */
  const follow = () => {
    if (!pinned) return
    const c = begin('follow')
    if (!c) return
    const move = () => { const box = o.box(); if (box && movesToEnd(box, byHand())) write(c, rangeOf(box)) }
    move()
    c.frame = env.raf(() => { c.frame = 0; if (cur === c && pinned) move(); end(c) })
  }

  const glide = (run: GlideRun): boolean => {
    const c = begin('glide')
    if (!c) return false
    glider.start({
      ...run,
      done: (landed, replaced) => {
        if (cur === c) cur = undefined
        run.done?.(landed, replaced)
      }
    })
    return true
  }

  /** Whatever the reader asked for with a click or a send takes over from anything under way, their own scrolling included. */
  const takeOver = () => {
    if (cur) end(cur)
    handUntil = 0
  }

  return {
    get pinned() { return pinned },
    /** Whether the reader's own input is behind the scrolling now. */
    byHand,
    /** What is moving the view right now, if anything. */
    get intent(): Intent | undefined { return current()?.kind },
    /** Whether an open is still putting the view back, so the spot to keep is not where the reader left it yet. */
    get correcting() { const c = current(); return c?.kind === 'place' && !!c.hold?.state.correcting },
    distFromEnd: () => { const box = o.box(); return box ? distFromEnd(box) : 0 },
    follow,

    /** The reader's wheel, touch, scrolling keys or scrollbar. It ends every other mover and holds the view where they leave it. */
    hand() {
      begin('reader')
      handUntil = env.now() + HAND_MS
    },

    /** A key or a click in the content: it stops a glide, without being scrolling itself. */
    interrupt() {
      const c = current()
      if (c?.kind === 'glide') end(c)
    },

    /** A scroll event. Reads whether the chat keeps following. A spot being put back is not the reader's scrolling (KERNEL-918). */
    scrolled() {
      const box = o.box()
      if (!box) return
      const hand = byHand()
      if (hand) handUntil = env.now() + HAND_MS
      const c = current()
      if (!(c?.kind === 'place' && c.spot)) pinned = followsAfterScroll(pinned, box, seen, hand)
      seen = snap(box)
      sync()
    },

    /** The scroll landed (scrollend). A glide's own scrolls end in between its frames, which doesn't mean it landed. */
    landed() {
      if (glider.live()) return
      this.interrupt()
      handUntil = 0
      if (pinned) follow()
    },

    /** Opens the chat at its end, or at a spot, and keeps putting the view there until it holds still. */
    open(run: PlaceRun) {
      const c = begin('place')
      if (!c) return
      c.spot = !!run.spot
      pinned = !run.spot
      c.hold = holdView({
        put: () => {
          const box = o.box()
          if (!box) return 0
          const to = Math.max(0, run.spot ? run.spot() : rangeOf(box))
          write(c, to, true)
          sync()
          return to
        },
        ends: !run.spot,
        over: () => current() !== c,
        following: () => pinned,
        now: env.now, raf: env.raf, caf: env.caf, capMs: PLACE_MS,
        frames: run.frames
      })
    },

    /** The thread or the view changed size. `h` is the thread's new height when it is the thread. */
    resized(h?: number) {
      if (h !== undefined) {
        // Opening a row at the end grows the thread under the reader's click, and following would scroll the row they opened out from under them (KERNEL-891).
        if (opening && h > height) pinned = false
        opening = false
        height = h
      }
      const c = current()
      if (c?.kind === 'place') { if (c.spot) c.hold?.resume(); return }
      if (pinned) follow()
      else sync()
    },

    /** A click on something that opens: the thread growing from it in the next two frames is the reader's, not the end's. */
    opened() {
      opening = true
      env.raf(() => env.raf(() => { opening = false }))
    },

    /** The reader sent a message: it ends every mover and the view follows the end at once. */
    sent() {
      takeOver()
      setPinned(true)
    },

    /** Scroll to bottom. */
    toEnd() {
      this.sent()
      const box = o.box()
      if (!box) return
      const goal = () => Math.max(0, rangeOf(box))
      // Already at the end, nothing would run.
      if (goal() - box.scrollTop <= 0) return
      glide({
        goal,
        far: true,
        done: (landed) => { if (!landed) return; setPinned(true); follow() }
      })
    },

    /** The chat rail's glide to a message the reader picked, which is the reader scrolling: it unpins, and following stays out of the way until it lands. */
    guide(goal: () => number, done: (landed: boolean, replaced?: boolean) => void) {
      takeOver()
      glide({ goal, done })
      handUntil = env.now() + HAND_MS
    },

    /** A plan revealing itself. Not while the reader is scrolling, and a place or a follow gives way to it. */
    reveal(run: { goal: () => number; instant: boolean; holdMs?: number }) {
      if (byHand()) return
      glide({ goal: run.goal, instant: run.instant, holdMs: run.holdMs, over: byHand })
    },

    /** Ends the glide where it is, as the chat rail does when the reader moves on. */
    cancelGlide() {
      const c = current()
      if (c?.kind === 'glide') end(c)
    },

    stop() {
      if (cur) end(cur)
      glider.cancel()
    }
  }
}

export type ChatScroll = ReturnType<typeof createChatScroll>
