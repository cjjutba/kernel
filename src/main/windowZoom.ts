import type { BrowserWindow, Point, WebContents } from 'electron'

export type ZoomStep = 'in' | 'out' | 'reset'

/** The part of the window zoom reads and moves: its page and its native traffic lights. */
type ZoomedWindow = Pick<BrowserWindow, 'setWindowButtonPosition'> & { webContents: Pick<WebContents, 'getZoomLevel' | 'setZoomLevel' | 'getZoomFactor'> }

/** A key event as `before-input-event` reports it, as far as zoom reads it. */
interface ZoomInput { type: string; key: string; meta: boolean; control: boolean; alt: boolean }

/** ⌘+, ⌘=, ⌘- and ⌘0, which the View menu binds to zooming the whole window. Shift is free, since + is shift on =. */
export function zoomStepOf(input: ZoomInput): ZoomStep | null {
  if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return null
  if (input.key === '=' || input.key === '+') return 'in'
  if (input.key === '-') return 'out'
  if (input.key === '0') return 'reset'
  return null
}

/**
 * The traffic lights as macOS draws them, in points, measured on macOS 27 from a window capture: each button is 14 tall, and the
 * three span 60 from the first one's left edge to the last one's right edge. Page zoom doesn't scale them (KERNEL-901).
 */
export const LIGHT_HEIGHT = 14
export const LIGHTS_WIDTH = 60
/** At 100% the lights sit 20 from the left and center on the top row's line, y 31 in the header row y 9 to 53 (KERNEL-431). */
const LEFT = 20
const ROW_CENTER = 31

/** Where the lights go at a page zoom: on the top row's center line, with the left gap scaled like the page, in whole points. */
export function lightsFor(zoomFactor: number, lightHeight = LIGHT_HEIGHT): Point {
  return { x: Math.round(LEFT * zoomFactor), y: Math.round(ROW_CENTER * zoomFactor - lightHeight / 2) }
}

/** Puts the lights on the top row for the page's current zoom. */
export function placeLights(win: ZoomedWindow) {
  win.setWindowButtonPosition(lightsFor(win.webContents.getZoomFactor()))
}

/** What the View menu's Zoom In, Zoom Out and Actual Size do: half a zoom level a step, about 10%. */
const LEVEL = 0.5
/** Chromium's zoom: each level scales the page by 1.2. */
const factorOf = (level: number) => 1.2 ** level

/**
 * The lowest zoom level the window goes to. With the sidebar hidden the header clears the lights with 78 of padding, which shrinks with
 * the page while the lights don't, so zooming out stops at the lowest half-level step where the lights and an 8 gap still fit in it. They
 * already don't at 100% (20 + 60 + 8 is 88), so the floor is 100%, where the sidebar toggle at 87 still clears them.
 */
export const FLOOR_LEVEL = (() => {
  let floor = 0
  for (let level = -LEVEL; LEFT * factorOf(level) + LIGHTS_WIDTH + 8 <= 78 * factorOf(level); level -= LEVEL) floor = level
  return floor
})()

/** Keeps a zoom level at or above the floor. */
export const clampLevel = (level: number) => Math.max(FLOOR_LEVEL, level)

/** Zooms the page a step, no lower than the floor, and moves the lights to follow it. */
export function zoomWindow(win: ZoomedWindow, step: ZoomStep) {
  const level = clampLevel(step === 'reset' ? 0 : win.webContents.getZoomLevel() + (step === 'in' ? LEVEL : -LEVEL))
  win.webContents.setZoomLevel(level)
  win.setWindowButtonPosition(lightsFor(factorOf(level)))
}

/** Clamps a zoom the page has already taken, such as one Electron restored at launch, and moves the lights to it. */
export function settleZoom(win: ZoomedWindow) {
  const level = win.webContents.getZoomLevel()
  if (level < FLOOR_LEVEL) win.webContents.setZoomLevel(FLOOR_LEVEL)
  win.setWindowButtonPosition(lightsFor(factorOf(Math.max(FLOOR_LEVEL, level))))
}

/**
 * Offers a zoom key to the page before the window takes it (KERNEL-598). A shared image's tab cancels the `kernel:zoom` event and zooms the
 * picture. Where nothing cancels it, or the page doesn't answer, the window zooms as the menu would have.
 */
export async function handZoom(win: ZoomedWindow & { webContents: Pick<WebContents, 'executeJavaScript' | 'isDestroyed'> }, step: ZoomStep) {
  const wc = win.webContents
  const taken = await wc.executeJavaScript(`window.dispatchEvent(new CustomEvent('kernel:zoom', { cancelable: true, detail: '${step}' })) === false`).catch(() => false)
  if (!taken && !wc.isDestroyed()) zoomWindow(win, step)
}
