import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { actions } from '../../store'

export const SIDEBAR_DEFAULT = 236
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 480
/** Dragging past this and letting go hides the sidebar, the way Conductor does. The saved width stays. */
const HIDE_BELOW = 160
/** The panel keeps at least this much of the window, however wide the sidebar was saved. */
const PANEL_MIN = 520
const STEP = 8
const BIG_STEP = 32
const KEY = 'kernel.sidebarWidth'

/** The widest the sidebar can be in this window. It never drops below the minimum, since narrow windows fold the sidebar anyway (D-080). */
export const widthLimit = () => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - PANEL_MIN))
export const clampWidth = (w: number) => Math.round(Math.min(widthLimit(), Math.max(SIDEBAR_MIN, w)))

/** The saved width, read once. localStorage may be missing or blocked, and a stored value may be junk. */
export function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    return Number.isFinite(n) && n > 0 ? clampWidth(n) : SIDEBAR_DEFAULT
  } catch { return SIDEBAR_DEFAULT }
}
/** Only a width the user chose is stored, so the default can still change. */
function keepWidth(w: number) {
  try { if (w === SIDEBAR_DEFAULT) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(w)) } catch { /* not remembered */ }
}

type Drag = { startX: number; startWidth: number; id: number }

/**
 * The sidebar's right edge, in the 8px gutter before the panel (D-112). A drag moves the nav's width through `navRef`, so the
 * sidebar doesn't render on every pointer move; the width is committed to `onCommit` and localStorage on release.
 * Letting go below 160px hides the sidebar and keeps the saved width, so Cmd+B brings it back as it was.
 */
export function ResizeHandle({ navRef, width, limit, onCommit }: { navRef: RefObject<HTMLElement | null>; width: number; limit: number; onCommit: (w: number) => void }) {
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)

  const show = (w: number) => {
    if (navRef.current) navRef.current.style.width = `${w}px`
    handle.current?.setAttribute('aria-valuenow', String(w))
  }
  const commit = (w: number) => { keepWidth(w); onCommit(w) }
  const reset = () => commit(clampWidth(SIDEBAR_DEFAULT))

  const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel() } }

  /** Puts the body back the way it was, and the handle with it. */
  const end = () => {
    drag.current = null
    document.removeEventListener('keydown', esc, true)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    handle.current?.removeAttribute('data-dragging')
  }
  useEffect(() => end, [])

  const start = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !navRef.current) return
    // Without this the browser can take a later drag over as a text drag and cancel the pointer. It also keeps focus off the handle, so Escape listens on the document.
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    document.addEventListener('keydown', esc, true)
    drag.current = { startX: e.clientX, startWidth: navRef.current.getBoundingClientRect().width, id: e.pointerId }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.currentTarget.setAttribute('data-dragging', '')
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d && d.id === e.pointerId) show(clampWidth(d.startWidth + e.clientX - d.startX))
  }
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    end()
    const raw = d.startWidth + e.clientX - d.startX
    if (raw < HIDE_BELOW) {
      show(d.startWidth)
      actions.ui.setSidebar(false)
    } else commit(clampWidth(raw))
  }
  /** A cancelled drag (the window lost the pointer, or Escape) leaves the width where it was. */
  const cancel = () => {
    const d = drag.current
    if (!d) return
    end()
    show(d.startWidth)
  }

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP
    const next = e.key === 'ArrowLeft' ? width - step : e.key === 'ArrowRight' ? width + step : e.key === 'Home' ? SIDEBAR_MIN : e.key === 'End' ? limit : null
    if (e.key === 'Enter') { e.preventDefault(); return reset() }
    if (next === null) return
    e.preventDefault()
    commit(clampWidth(next))
  }

  return (
    <div
      ref={handle} className="sb-resize nodrag" role="separator" aria-orientation="vertical" aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN} aria-valuemax={limit} aria-valuenow={width} tabIndex={0}
      onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onDoubleClick={reset} onKeyDown={key}
    />
  )
}
