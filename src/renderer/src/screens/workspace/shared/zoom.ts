import type { Size } from './comment'

// Zoom on a shared image (KERNEL-598). The arithmetic is here, so a test can run it; `useImageZoom` ties it to the DOM. A scale is the
// drawn size over the natural size, so 1 is 100%. Fit is the scale that shows the whole image in its frame, never above 1.

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 4
/** The stops the buttons and ⌘+ and ⌘- move between. Fit is a stop of its own, which is `fitScale` and varies with the image. */
export const ZOOM_STOPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]
/** The project round the image in its frame, as `.shared-zoom` pads it. */
export const ZOOM_PAD = 16
/** A scale this close to Fit, as a share of it, is Fit. A stop or a wheel turn that lands beside it settles on it. */
const SNAP = 0.01

export type ZoomStep = 'in' | 'out' | 'reset'

/** The scale that shows the whole image in the frame, or 1 where the image is smaller than the frame. */
export function fitScale(natural: Size, frame: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || frame.width <= 0 || frame.height <= 0) return 1
  return Math.min(1, frame.width / natural.width, frame.height / natural.height)
}

/** The least the image zooms out to: 25%, or Fit where Fit is smaller, so a tall screenshot can always be seen whole. */
export const zoomFloor = (fit: number) => Math.min(fit, ZOOM_MIN)

export const clampScale = (scale: number, fit: number) => Math.min(Math.max(scale, zoomFloor(fit)), ZOOM_MAX)

export const nearFit = (scale: number, fit: number) => Math.abs(scale - fit) <= fit * SNAP

/** What a scale is kept as: null for Fit, which follows the frame when it resizes, else the scale held inside the range. */
export function settleScale(scale: number, fit: number): number | null {
  const s = clampScale(scale, fit)
  return nearFit(s, fit) ? null : s
}

/** Every stop between the floor and 400%, in order, with Fit among them. A stop beside Fit gives way to it. */
export function zoomStops(fit: number): number[] {
  const floor = zoomFloor(fit)
  return [...ZOOM_STOPS.filter((s) => s >= floor && !nearFit(s, fit)), fit].sort((a, b) => a - b)
}

/** The next stop up (`1`) or down (`-1`) from a scale, which may sit between two after a pinch. At the end it stays at the end. */
export function stepScale(scale: number, dir: 1 | -1, fit: number): number {
  const stops = zoomStops(fit)
  if (dir > 0) return stops.find((s) => s > scale * (1 + SNAP)) ?? ZOOM_MAX
  return [...stops].reverse().find((s) => s < scale * (1 - SNAP)) ?? zoomFloor(fit)
}

export const canZoomIn = (scale: number) => scale < ZOOM_MAX / (1 + SNAP)
export const canZoomOut = (scale: number, fit: number) => scale > zoomFloor(fit) * (1 + SNAP)

/** Where a double-click goes: from Fit to 100%, or to 200% where Fit already is 100%, and from anywhere else back to Fit (null). */
export function doubleClickTarget(scale: number, fit: number): number | null {
  if (!nearFit(scale, fit)) return null
  return nearFit(1, fit) ? 2 : 1
}

const LINE_PX = 16
const PAGE_PX = 400

/** How much one wheel event scales the image by. A pinch comes as a wheel with ctrl held and small deltas, so it counts for more than a ⌘ scroll. */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY
  return Math.min(Math.max(Math.exp(-px * (pinch ? 0.01 : 0.0015)), 0.5), 2)
}

/** "200%", the scale as it reads on the zoom control. */
export const percent = (scale: number) => `${Math.round(scale * 100)}%`

/** What ⌘ and this key do to the image: + and = zoom in (+ is shift on =), - zooms out, 0 goes back to Fit. */
export function zoomKey(key: string): ZoomStep | null {
  if (key === '=' || key === '+') return 'in'
  if (key === '-') return 'out'
  if (key === '0') return 'reset'
  return null
}
