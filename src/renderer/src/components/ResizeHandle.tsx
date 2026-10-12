import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import './resize.css'

const STEP = 8
const BIG_STEP = 32

/** The saved width, read once, or null when none is saved. localStorage may be missing or blocked, and a stored value may be junk. It clamps only to [min, max], so a width saved in a roomier window survives a narrow one; the caller caps what it shows. */
export function readWidth(key: string, min: number, max: number): number | null {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : null
  } catch { return null }
}
/** Only a width the user chose is stored, so the default can still change. */
function keepWidth(key: string, w: number | null) {
  try { if (w === null) localStorage.removeItem(key); else localStorage.setItem(key, String(w)) } catch { /* not remembered */ }
}

/** What letting go at `raw` does: hide the target when it has a hide threshold and `raw` is under it, else commit the clamped width, so a handle without one stops at its minimum. */
export function releasedAs(raw: number, hideBelow: number | undefined): 'hide' | 'commit' {
  return hideBelow !== undefined && raw < hideBelow ? 'hide' : 'commit'
}

/** The edge of the target a handle sits on. A left or right edge sets the target's width; a top edge sets its height (KERNEL-513). */
export type Edge = 'left' | 'right' | 'top'

/** What the arrow keys do on an edge: the one pointing away from the target grows it. */
const GROW: Record<Edge, string> = { right: 'ArrowRight', left: 'ArrowLeft', top: 'ArrowUp' }
const SHRINK: Record<Edge, string> = { right: 'ArrowLeft', left: 'ArrowRight', top: 'ArrowDown' }

/** The size a key asks for from `now`, or null for a key that does nothing. Shift takes the big step, Home goes to `min` and End to `max`. */
export function keyedSize(edge: Edge, key: string, shift: boolean, now: number, min: number, max: number): number | null {
  const step = shift ? BIG_STEP : STEP
  return key === SHRINK[edge] ? now - step : key === GROW[edge] ? now + step : key === 'Home' ? min : key === 'End' ? max : null
}

/** The size a drag from `start` at `from` gives at `at`, before clamping. Dragging a right edge right, a left edge left or a top edge up grows the target. */
export function draggedSize(edge: Edge, start: number, from: number, at: number): number {
  return start + (edge === 'right' ? 1 : -1) * (at - from)
}

/** `esc` is kept on the drag, so the listener `end` removes is the one `start` added, whatever renders in between. */
/** `startInline` is the target's own inline size, which the owner's render put there; a drag that ends puts it back before the owner renders the new one, so a CSS size the owner relies on isn't left as a frozen px. */
type Drag = { startAt: number; startSize: number; startInline: string; id: number; esc: (e: globalThis.KeyboardEvent) => void }

interface Props {
  /** The element whose size the handle sets: its width for a left or right edge, its height for a top edge. A drag writes to it directly, so the owner doesn't render on every pointer move. */
  targetRef: RefObject<HTMLElement | null>
  /** The edge of the target the handle sits on. Dragging a right edge right, a left edge left or a top edge up grows the target; so do the arrow keys on that side. */
  edge: Edge
  label: string
  /** The size on screen now, in px along the edge's axis. */
  size: number
  min: number
  /** The largest the target can be in this window, read when a drag or key needs it. Never below `min`. */
  limit: () => number
  /** What a reset goes back to, and the size at which nothing is stored. Read when needed, since a default that follows the window changes with it. */
  defaultSize: () => number
  /** Where the size is kept in localStorage. A handle without one leaves keeping it to `onCommit`, as a size held as a fraction does. */
  storageKey?: string
  /** Letting go below this hides the target and keeps the saved size. Without it (and `onHide`), letting go below `min` clamps to `min` and the target stays. */
  hideBelow?: number
  onHide?: () => void
  /** The size the user chose, or null for the default. */
  onCommit: (size: number | null) => void
}

/**
 * A drag handle on one edge of a panel (D-112, D-113). A drag moves the target's width, or its height from a top edge, through `targetRef`; the
 * size is committed to `onCommit` and localStorage on release. Letting go below `hideBelow` hides the target and keeps the saved size, so its
 * shortcut brings it back as it was; a handle without `hideBelow` clamps to `min` instead. Hovering, focusing from the keyboard or
 * dragging lights the panel's border with a glow that is brightest at the middle of the edge (resize.css, KERNEL-419), and the
 * handle gets the app's focus ring from the keyboard.
 */
export function ResizeHandle({ targetRef, edge, label, size, min, limit, defaultSize, storageKey, hideBelow, onHide, onCommit }: Props) {
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const vertical = edge === 'top'
  const clamp = (w: number) => Math.round(Math.min(Math.max(min, limit()), Math.max(min, w)))
  const sizeNow = () => { const r = targetRef.current?.getBoundingClientRect(); return r ? (vertical ? r.height : r.width) : size }
  const at = (e: { clientX: number; clientY: number }) => (vertical ? e.clientY : e.clientX)

  const show = (w: number) => {
    if (targetRef.current) targetRef.current.style[vertical ? 'height' : 'width'] = `${w}px`
    handle.current?.setAttribute('aria-valuenow', String(w))
  }
  /** Back to what the drag started from. */
  const restore = (d: Drag) => {
    if (targetRef.current) targetRef.current.style[vertical ? 'height' : 'width'] = d.startInline
    handle.current?.setAttribute('aria-valuenow', String(Math.round(d.startSize)))
  }
  const commit = (w: number) => {
    const chosen = w === defaultSize() ? null : w
    if (storageKey) keepWidth(storageKey, chosen)
    onCommit(chosen)
  }
  const reset = () => commit(defaultSize())

  /** Puts the body back the way it was, and the handle with it. */
  const end = () => {
    if (drag.current) document.removeEventListener('keydown', drag.current.esc, true)
    drag.current = null
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    handle.current?.removeAttribute('data-dragging')
  }
  useEffect(() => end, [])

  const start = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !targetRef.current) return
    // Without this the browser can take a later drag over as a text drag and cancel the pointer. It also keeps focus off the handle, so Escape listens on the document.
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const esc = (ev: globalThis.KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); cancel() } }
    document.addEventListener('keydown', esc, true)
    drag.current = { startAt: at(e), startSize: sizeNow(), startInline: targetRef.current.style[vertical ? 'height' : 'width'], id: e.pointerId, esc }
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
    e.currentTarget.setAttribute('data-dragging', '')
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d && d.id === e.pointerId) show(clamp(draggedSize(edge, d.startSize, d.startAt, at(e))))
  }
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    end()
    const raw = draggedSize(edge, d.startSize, d.startAt, at(e))
    restore(d)
    if (releasedAs(raw, hideBelow) === 'hide') onHide?.()
    else commit(clamp(raw))
  }
  /** A cancelled drag (the window lost the pointer, or Escape) leaves the size where it was. */
  const cancel = () => {
    const d = drag.current
    if (!d) return
    end()
    restore(d)
  }

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); return reset() }
    // Steps start from the size on screen. The `size` prop is as of the last render, which a window resize can leave behind.
    const next = keyedSize(edge, e.key, e.shiftKey, Math.round(sizeNow()), min, limit())
    if (next === null) return
    e.preventDefault()
    commit(clamp(next))
  }

  return (
    <div
      ref={handle} className="resize-handle nodrag" data-edge={edge} role="separator" aria-orientation={vertical ? 'horizontal' : 'vertical'} aria-label={label}
      aria-valuemin={min} aria-valuemax={Math.max(min, limit())} aria-valuenow={size} tabIndex={0}
      // The room and the size can change without this rendering (the window, the sidebar), so both are read again as the handle gets focus.
      onFocus={(e) => {
        e.currentTarget.setAttribute('aria-valuemax', String(Math.max(min, limit())))
        e.currentTarget.setAttribute('aria-valuenow', String(Math.round(sizeNow())))
      }}
      onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onDoubleClick={reset} onKeyDown={key}
    />
  )
}
