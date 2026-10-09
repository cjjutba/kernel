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

/** `esc` is kept on the drag, so the listener `end` removes is the one `start` added, whatever renders in between. */
/** `startInline` is the target's own inline width, which the owner's render put there; a drag that ends puts it back before the owner renders the new one, so a CSS width the owner relies on isn't left as a frozen px. */
type Drag = { startX: number; startWidth: number; startInline: string; id: number; esc: (e: globalThis.KeyboardEvent) => void }

interface Props {
  /** The element whose width the handle sets. A drag writes to it directly, so the owner doesn't render on every pointer move. */
  targetRef: RefObject<HTMLElement | null>
  /** The edge of the target the handle sits on. Dragging a right edge right, or a left edge left, widens the target; so do the arrow keys on that side. */
  edge: 'left' | 'right'
  label: string
  /** The width on screen now. */
  width: number
  min: number
  /** The widest the target can be in this window, read when a drag or key needs it. Never below `min`. */
  limit: () => number
  /** What a reset goes back to, and the width at which nothing is stored. Read when needed, since a default that follows the window changes with it. */
  defaultWidth: () => number
  storageKey: string
  /** Letting go below this hides the target and keeps the saved width. */
  hideBelow: number
  onHide: () => void
  /** The width the user chose, or null for the default. */
  onCommit: (w: number | null) => void
}

/**
 * A drag handle on one edge of a panel (D-112, D-113). A drag moves the target's width through `targetRef`; the width is committed
 * to `onCommit` and localStorage on release. Letting go below `hideBelow` hides the target and keeps the saved width, so its
 * shortcut brings it back as it was. There is no hairline, so the `col-resize` cursor is the only sign on hover; the handle
 * gets the app's focus ring from the keyboard.
 */
export function ResizeHandle({ targetRef, edge, label, width, min, limit, defaultWidth, storageKey, hideBelow, onHide, onCommit }: Props) {
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  /** +1 when moving right makes the target wider. */
  const dir = edge === 'right' ? 1 : -1
  const clamp = (w: number) => Math.round(Math.min(Math.max(min, limit()), Math.max(min, w)))

  const show = (w: number) => {
    if (targetRef.current) targetRef.current.style.width = `${w}px`
    handle.current?.setAttribute('aria-valuenow', String(w))
  }
  /** Back to what the drag started from. */
  const restore = (d: Drag) => {
    if (targetRef.current) targetRef.current.style.width = d.startInline
    handle.current?.setAttribute('aria-valuenow', String(Math.round(d.startWidth)))
  }
  const commit = (w: number) => {
    const chosen = w === defaultWidth() ? null : w
    keepWidth(storageKey, chosen)
    onCommit(chosen)
  }
  const reset = () => commit(defaultWidth())

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
    drag.current = { startX: e.clientX, startWidth: targetRef.current.getBoundingClientRect().width, startInline: targetRef.current.style.width, id: e.pointerId, esc }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.currentTarget.setAttribute('data-dragging', '')
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d && d.id === e.pointerId) show(clamp(d.startWidth + dir * (e.clientX - d.startX)))
  }
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    end()
    const raw = d.startWidth + dir * (e.clientX - d.startX)
    restore(d)
    if (raw < hideBelow) onHide()
    else commit(clamp(raw))
  }
  /** A cancelled drag (the window lost the pointer, or Escape) leaves the width where it was. */
  const cancel = () => {
    const d = drag.current
    if (!d) return
    end()
    restore(d)
  }

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); return reset() }
    const step = e.shiftKey ? BIG_STEP : STEP
    const grow = edge === 'right' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = edge === 'right' ? 'ArrowLeft' : 'ArrowRight'
    // Steps start from the width on screen. The `width` prop is as of the last render, which a window resize can leave behind.
    const now = Math.round(targetRef.current?.getBoundingClientRect().width ?? width)
    const next = e.key === shrink ? now - step : e.key === grow ? now + step : e.key === 'Home' ? min : e.key === 'End' ? limit() : null
    if (next === null) return
    e.preventDefault()
    commit(clamp(next))
  }

  return (
    <div
      ref={handle} className="resize-handle nodrag" data-edge={edge} role="separator" aria-orientation="vertical" aria-label={label}
      aria-valuemin={min} aria-valuemax={Math.max(min, limit())} aria-valuenow={width} tabIndex={0}
      // The room and the width can change without this rendering (the window, the sidebar), so both are read again as the handle gets focus.
      onFocus={(e) => {
        e.currentTarget.setAttribute('aria-valuemax', String(Math.max(min, limit())))
        e.currentTarget.setAttribute('aria-valuenow', String(Math.round(targetRef.current?.getBoundingClientRect().width ?? width)))
      }}
      onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onDoubleClick={reset} onKeyDown={key}
    />
  )
}
