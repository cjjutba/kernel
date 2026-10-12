/** How long after the last activity the thumb stays up. */
const IDLE_MS = 1000
/** How long a list of scrollers found under the pointer is trusted before it is read again, since content can start to overflow while the pointer moves. */
const SCROLLERS_MS = 250

/** The part of an element the activity needs, so a test can stand in for a DOM node. */
export interface ScrollTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/**
 * Which scrollers show their thumb. `touch` sets `data-scrolling` on an element and clears it IDLE_MS after the last touch, `hold` keeps it set while a
 * native scrollbar is pressed, and `release` starts the countdown again. State is a timer per element, never React state, so no activity renders anything.
 */
export function createScrollActivity(idleMs = IDLE_MS) {
  const timers = new Map<ScrollTarget, ReturnType<typeof setTimeout>>()
  const held = new Set<ScrollTarget>()
  const clear = (el: ScrollTarget) => {
    clearTimeout(timers.get(el))
    timers.delete(el)
  }
  const touch = (el: ScrollTarget) => {
    el.setAttribute('data-scrolling', '')
    clear(el)
    if (held.has(el)) return
    timers.set(el, setTimeout(() => {
      timers.delete(el)
      el.removeAttribute('data-scrolling')
    }, idleMs))
  }
  return {
    touch,
    hold(el: ScrollTarget) {
      held.add(el)
      clear(el)
      el.setAttribute('data-scrolling', '')
    },
    release(el: ScrollTarget) {
      if (held.delete(el)) touch(el)
    },
    /** Clears every element and timer. */
    dispose() {
      for (const el of [...timers.keys(), ...held]) {
        clear(el)
        el.removeAttribute('data-scrolling')
      }
      held.clear()
    },
  }
}

/** Whether `el` draws a scrollbar right now, and so has a thumb to show. */
function hasScrollbar(el: Element): boolean {
  const s = getComputedStyle(el)
  if (s.scrollbarWidth === 'none') return false
  const scrollsY = (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
  const scrollsX = (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth
  return scrollsY || scrollsX
}

/** Whether a press at (x, y) landed on one of `el`'s own scrollbars, which is where the pointer events of a native scrollbar are aimed. */
function onScrollbar(el: Element, x: number, y: number): boolean {
  const r = el.getBoundingClientRect()
  return x - r.left - el.clientLeft >= el.clientWidth || y - r.top - el.clientTop >= el.clientHeight
}

/**
 * Shows a scroller's thumb through `data-scrolling` while the area is in use, and for a second after (KERNEL-597, KERNEL-602, amended by
 * feat-fade-scrollbars-after-pointer-and). In use means it scrolls, by wheel, keys, touch or dragging the thumb, the pointer moves over it, or its native scrollbar is held.
 * A pointer that rests on an area does not count, so the thumb fades after a second even under a stationary pointer. A scroll event doesn't bubble but does
 * capture, and so do the pointer events used here, so one listener each on the document sees every scroller in the app, sidebar, chat, Settings, modals and
 * popovers alike. A pointer move marks the scrollers that hold the element under it, from the nearest outwards, and never one that doesn't. Chromium aims a
 * native scrollbar's pointerdown and pointerup at the scroller itself, and sends no pointermove while the thumb is dragged, only scroll events, so a press
 * on the scrollbar holds the thumb up until the button is released, even with the pointer still. The attribute is set on the element, not in state, so
 * nothing renders. Returns a function that removes the listeners and clears every mark.
 */
export function installScrollIdle(): () => void {
  const activity = createScrollActivity()
  let held: Element | undefined
  let found: { from: EventTarget | null; at: number; scrollers: Element[] } | undefined
  let frame = 0
  let latest: PointerEvent | undefined

  const release = () => {
    if (held) activity.release(held)
    held = undefined
  }
  const scrollersAt = (from: EventTarget | null, now: number): Element[] => {
    if (found && found.from === from && now - found.at < SCROLLERS_MS) return found.scrollers
    const scrollers: Element[] = []
    for (let el = from instanceof Element ? from : null; el; el = el.parentElement) if (hasScrollbar(el)) scrollers.push(el)
    found = { from, at: now, scrollers }
    return scrollers
  }
  const onScroll = (e: Event) => {
    // The page itself never scrolls (body is overflow hidden), and `document` has no attributes to set.
    if (e.target instanceof Element) activity.touch(e.target)
  }
  // Pointer moves arrive faster than frames, so read the layout once a frame, for the last one.
  const onMove = (e: PointerEvent) => {
    if (e.buttons === 0) release()
    latest = e
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0
      if (latest) for (const el of scrollersAt(latest.target, performance.now())) activity.touch(el)
    })
  }
  const onDown = (e: PointerEvent) => {
    if (!(e.target instanceof Element) || !hasScrollbar(e.target) || !onScrollbar(e.target, e.clientX, e.clientY)) return
    release()
    held = e.target
    activity.hold(held)
  }
  const options = { capture: true, passive: true } as const
  document.addEventListener('scroll', onScroll, options)
  document.addEventListener('pointermove', onMove, options)
  document.addEventListener('pointerdown', onDown, options)
  document.addEventListener('pointerup', release, options)
  document.addEventListener('pointercancel', release, options)
  window.addEventListener('blur', release)
  return () => {
    document.removeEventListener('scroll', onScroll, options)
    document.removeEventListener('pointermove', onMove, options)
    document.removeEventListener('pointerdown', onDown, options)
    document.removeEventListener('pointerup', release, options)
    document.removeEventListener('pointercancel', release, options)
    window.removeEventListener('blur', release)
    cancelAnimationFrame(frame)
    activity.dispose()
  }
}
