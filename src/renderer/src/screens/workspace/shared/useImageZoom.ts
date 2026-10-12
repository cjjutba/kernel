import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject, type SyntheticEvent } from 'react'
import { flushSync } from 'react-dom'
import { getState } from '../../../store'
import type { Size, Spot } from './comment'
import { canZoomIn, canZoomOut, doubleClickTarget, fitScale, percent, settleScale, stepScale, wheelFactor, zoomKey, ZOOM_PAD, type ZoomStep } from './zoom'

/** Main hands ⌘+, ⌘- and ⌘0 to the page as this event, because the View menu would zoom the window with them. Cancel it to take the key. */
export const ZOOM_EVENT = 'kernel:zoom'

export interface ImageZoom {
  /** The image has loaded, so its size is known. Until then nothing zooms. */
  ready: boolean
  /** What is drawn, as a share of the natural size, and how the control reads it. */
  scale: number
  label: string
  fitted: boolean
  canIn: boolean
  canOut: boolean
  /** Zoomed past Fit, where the area scrolls. `pannable` is where it also has somewhere to scroll to. */
  zoomed: boolean
  pannable: boolean
  dragging: boolean
  /** Counts every change of scale and every scroll in comment mode, so pins are placed again where the image is now. */
  moved: number
  /** The image's own size when zoomed. At Fit the CSS fits it to the frame. */
  imgStyle: CSSProperties | undefined
  onLoad: (e: SyntheticEvent<HTMLImageElement>) => void
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  scrollBy: (dx: number, dy: number) => void
  scrollerProps: {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => void
    onDoubleClick: (e: { clientX: number; clientY: number }) => void
    onScroll: () => void
  }
}

/**
 * Zoom and pan for a shared image (KERNEL-598). `area` is the frame the image sits in, `scroller` scrolls inside it and `img` is the image.
 * The zoom is local to the tab and starts at Fit, and a new version goes back to it. A zoom around a point keeps the spot of the image
 * under that point where it was. The keys are ⌘+, ⌘- and ⌘0 while the tab is open; main sends them as `ZOOM_EVENT`, since the menu takes
 * them first, and a keydown stands in where main isn't in the way. While `commenting`, a drag does not pan.
 */
export function useImageZoom({ enabled, versionKey, area, scroller, img, commenting }: {
  enabled: boolean
  versionKey: string
  area: RefObject<HTMLDivElement | null>
  scroller: RefObject<HTMLDivElement | null>
  img: RefObject<HTMLImageElement | null>
  commenting: boolean
}): ImageZoom {
  const [frame, setFrame] = useState<Size>({ width: 0, height: 0 })
  const [loaded, setLoaded] = useState<(Size & { key: string }) | null>(null)
  const [zoom, setZoom] = useState<{ key: string; scale: number | null }>({ key: versionKey, scale: null })
  const [moved, setMoved] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null)

  // Another version is another image, so its size and zoom are not the last one's.
  const size = loaded && loaded.key === versionKey ? loaded : null
  const held = zoom.key === versionKey ? zoom.scale : null
  const fit = size ? fitScale(size, frame) : 1
  const scale = held ?? fit
  const pannable = !!size && held !== null && (size.width * scale > frame.width || size.height * scale > frame.height)

  useLayoutEffect(() => {
    const el = area.current
    if (!enabled || !el) return
    const measure = () => {
      const width = el.clientWidth - 2 * ZOOM_PAD
      const height = el.clientHeight - 2 * ZOOM_PAD
      setFrame((f) => (f.width === width && f.height === height ? f : { width, height }))
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [enabled, area])

  // What the listeners below read, which are set once and must see the scale of the moment.
  const live = useRef({ size, fit, scale, held, versionKey, commenting })
  live.current = { size, fit, scale, held, versionKey, commenting }

  /** Zooms to `target`, or to Fit for null, keeping the spot of the image under `at` (the middle of what shows when there is none) in place. */
  const to = (target: number | null, at?: Spot) => {
    const now = live.current
    const sc = scroller.current
    const im = img.current
    if (!now.size || !sc || !im) return
    const next = target === null ? null : settleScale(target, now.fit)
    if (next === now.held) return
    const after = next ?? now.fit
    const view = sc.getBoundingClientRect()
    const p = at ?? { x: view.left + view.width / 2, y: view.top + view.height / 2 }
    const was = im.getBoundingClientRect()
    const u = { x: (p.x - was.left - im.clientLeft) / now.scale, y: (p.y - was.top - im.clientTop) / now.scale }
    flushSync(() => setZoom({ key: now.versionKey, scale: next }))
    const is = im.getBoundingClientRect()
    sc.scrollLeft += is.left + im.clientLeft + u.x * after - p.x
    sc.scrollTop += is.top + im.clientTop + u.y * after - p.y
    setMoved((n) => n + 1)
  }
  const step = (dir: 1 | -1, at?: Spot) => to(stepScale(live.current.scale, dir, live.current.fit), at)
  const act = (s: ZoomStep) => (s === 'reset' ? to(null) : step(s === 'in' ? 1 : -1))
  const api = useRef({ to, act })
  api.current = { to, act }

  useEffect(() => {
    const el = area.current
    if (!enabled || !el) return
    // Pinch arrives as a wheel with ctrl held, and ⌘ scroll with meta. React listens to wheel as passive, so this one is the area's own.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      api.current.to(live.current.scale * wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), { x: e.clientX, y: e.clientY })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey || e.ctrlKey || e.altKey || e.isComposing || getState().ui.modal) return
      const s = zoomKey(e.key)
      if (!s) return
      e.preventDefault()
      api.current.act(s)
    }
    const onZoom = (e: Event) => {
      const s = (e as CustomEvent<ZoomStep>).detail
      if (getState().ui.modal) return
      e.preventDefault()
      api.current.act(s)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    window.addEventListener(ZOOM_EVENT, onZoom)
    return () => { el.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', onKey); window.removeEventListener(ZOOM_EVENT, onZoom) }
  }, [enabled, area])

  const endDrag = () => { drag.current = null; setDragging(false) }

  return {
    ready: !!size,
    scale,
    label: percent(scale),
    fitted: held === null,
    canIn: !!size && canZoomIn(scale),
    canOut: !!size && canZoomOut(scale, fit),
    zoomed: held !== null,
    pannable,
    dragging,
    moved,
    imgStyle: size && held !== null ? { width: size.width * held, height: size.height * held } : undefined,
    onLoad: (e) => setLoaded({ key: versionKey, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }),
    zoomIn: () => step(1),
    zoomOut: () => step(-1),
    fit: () => to(null),
    scrollBy: (dx, dy) => scroller.current?.scrollBy(dx, dy),
    scrollerProps: {
      onPointerDown: (e) => {
        const sc = scroller.current
        if (!sc || !pannable || commenting || e.button !== 0) return
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop }
        sc.setPointerCapture(e.pointerId)
        setDragging(true)
      },
      onPointerMove: (e) => {
        const d = drag.current
        const sc = scroller.current
        if (!d || !sc || d.id !== e.pointerId) return
        sc.scrollLeft = d.left - (e.clientX - d.x)
        sc.scrollTop = d.top - (e.clientY - d.y)
      },
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick: (e) => { if (!commenting) to(doubleClickTarget(scale, fit), { x: e.clientX, y: e.clientY }) },
      onScroll: () => { if (commenting) setMoved((n) => n + 1) }
    }
  }
}
