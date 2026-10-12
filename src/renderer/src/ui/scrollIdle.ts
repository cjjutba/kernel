/** How long after the last scroll the thumb stays up, before its 200ms fade (tokens.css). */
const IDLE_MS = 800

/** The part of an element the activity needs, so a test can stand in for a DOM node. */
export interface ScrollTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/**
 * Which scrollers show their thumb. `touch` sets `data-scrolling` on an element and clears it IDLE_MS after the last scroll, `hold` keeps it set while a
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
 * Shows a scroller's thumb through `data-scrolling` while the area scrolls, and for 800ms after (KERNEL-597, KERNEL-602, amended by
 * feat-fade-scrollbars-after-pointer-and and feat-scrollbar-thumb-shows-only-on). Scrolling means wheel, keys, touch or a dragged thumb, or a native
 * scrollbar held. A pointer that moves over an area, or rests on it, does not show its thumb. A scroll event doesn't bubble but does capture, and so do the
 * pointer events used here, so one listener each on the document sees every scroller in the app, sidebar, chat, Settings, modals and popovers alike. Chromium
 * aims a native scrollbar's pointerdown and pointerup at the scroller itself, and sends no pointermove while the thumb is dragged, only scroll events, so a
 * press on the scrollbar holds the thumb up until the button is released, even with the pointer still. A pointer move with no button down also releases a
 * hold whose pointerup was missed, which only restarts the countdown. The attribute is set on the element, not in state, so nothing renders. Returns a
 * function that removes the listeners and clears every mark.
 */
export function installScrollIdle(): () => void {
  const activity = createScrollActivity()
  let held: Element | undefined

  const release = () => {
    if (held) activity.release(held)
    held = undefined
  }
  const onScroll = (e: Event) => {
    // The page itself never scrolls (body is overflow hidden), and `document` has no attributes to set.
    if (e.target instanceof Element) activity.touch(e.target)
  }
  const onMove = (e: PointerEvent) => {
    if (e.buttons === 0) release()
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
    activity.dispose()
  }
}
