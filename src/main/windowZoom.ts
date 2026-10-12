import type { WebContents } from 'electron'

export type ZoomStep = 'in' | 'out' | 'reset'

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

/** What the View menu's Zoom In, Zoom Out and Actual Size do: half a zoom level a step, about 10%. */
const LEVEL = 0.5
export function zoomWindow(wc: WebContents, step: ZoomStep) {
  wc.setZoomLevel(step === 'reset' ? 0 : wc.getZoomLevel() + (step === 'in' ? LEVEL : -LEVEL))
}

/**
 * Offers a zoom key to the page before the window takes it (KERNEL-598). A shared image's tab cancels the `kernel:zoom` event and zooms the
 * picture. Where nothing cancels it, or the page doesn't answer, the window zooms as the menu would have.
 */
export async function handZoom(wc: WebContents, step: ZoomStep) {
  const taken = await wc.executeJavaScript(`window.dispatchEvent(new CustomEvent('kernel:zoom', { cancelable: true, detail: '${step}' })) === false`).catch(() => false)
  if (!taken && !wc.isDestroyed()) zoomWindow(wc, step)
}
