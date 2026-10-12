import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react'

// The toast's numbers (overlays.tsx): let go this far right of where a swipe started, or past FLICK_PX while moving right faster
// than FLICK px per ms, and the element leaves. Short of that it springs back.
const SWIPE_PX = 60
const FLICK = 0.3
const FLICK_PX = 16
/** A trackpad swipe has ended once its wheel events, momentum included, stop for this long. */
const WHEEL_END_MS = 120
/** A leaving element slides out, then `onDismiss` runs. `banner-out` in ui.css ends by then. */
const LEAVE_MS = 200

/** A swipe in progress: `from` is where a pointer drag started (a trackpad swipe has none), `x` how far right the element is, `v` its last speed. */
type Swipe = { from?: number; x: number; v: number; at: number; end?: ReturnType<typeof setTimeout> }

/**
 * Drag right, or swipe right with two fingers on a trackpad, to dismiss. Spread `handlers` and `ref` on the element. It follows
 * the pointer without rendering, then slides out and calls `onDismiss` once. `leave` does the same from a button. A drag that
 * starts on a link or button is left to it. Without `onDismiss` nothing happens.
 */
export function useSwipeDismiss<T extends HTMLElement>(onDismiss: (() => void) | undefined) {
  const [leaving, setLeaving] = useState(false)
  const ref = useRef<T>(null)
  const swipe = useRef<Swipe | null>(null)
  // Callers pass inline closures and re-render often. Keep the latest one in a ref so a render doesn't restart the timer.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const on = !!onDismiss
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => dismiss.current?.(), LEAVE_MS)
    return () => clearTimeout(t)
  }, [leaving])
  useEffect(() => () => clearTimeout(swipe.current?.end), [])

  const begin = (at: number, from?: number) => {
    if (!ref.current) return
    swipe.current = { from, x: 0, v: 0, at }
    ref.current.dataset.swiping = ''
  }
  // The offset goes straight onto the element, so a drag doesn't render on every move. It never goes left of its place.
  const follow = (x: number, at: number) => {
    const s = swipe.current
    if (!s || !ref.current) return
    const next = Math.max(0, x)
    s.v = (next - s.x) / Math.max(1, at - s.at)
    s.x = next
    s.at = at
    ref.current.style.transform = next ? `translateX(${next}px)` : ''
  }
  const settle = (at: number) => {
    const s = swipe.current
    swipe.current = null
    if (!s || !ref.current) return
    clearTimeout(s.end)
    delete ref.current.dataset.swiping
    if (s.x >= SWIPE_PX || (s.x >= FLICK_PX && s.v >= FLICK && at - s.at < 100)) setLeaving(true)
    else ref.current.style.transform = ''
  }
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (!on || leaving || swipe.current || e.button !== 0 || (e.target as Element).closest('a, button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    begin(e.timeStamp, e.clientX)
  }
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const from = swipe.current?.from
    if (from !== undefined) follow(e.clientX - from, e.timeStamp)
  }
  const onPointerUp = (e: PointerEvent<HTMLElement>) => { if (swipe.current?.from !== undefined) settle(e.timeStamp) }
  // With natural scrolling, the macOS default, fingers moving right report a negative deltaX. A mostly vertical scroll starts nothing.
  const onWheel = (e: WheelEvent<HTMLElement>) => {
    if (!on || leaving || swipe.current?.from !== undefined) return
    if (!swipe.current) {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      begin(e.timeStamp)
    }
    const s = swipe.current
    if (!s) return
    follow(s.x - e.deltaX, e.timeStamp)
    clearTimeout(s.end)
    s.end = setTimeout(() => settle(performance.now()), WHEEL_END_MS)
  }

  return {
    ref, leaving,
    leave: () => { if (on) setLeaving(true) },
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onWheel }
  }
}
