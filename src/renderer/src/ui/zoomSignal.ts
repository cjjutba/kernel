import { call } from '../api'

/**
 * Tells main whenever the page's zoom changes, so the traffic lights follow it however the zoom happened (KERNEL-972). A zoom resizes the
 * page in CSS pixels and changes devicePixelRatio, so a resize with a new ratio is one. Main reads the zoom from the page's webContents
 * rather than trusting the ratio, which mixes in the display's scale, so a move between a 1x and a 2x display leaves the lights in place.
 */
export function installZoomSignal() {
  let ratio = devicePixelRatio
  addEventListener('resize', () => {
    if (devicePixelRatio === ratio) return
    ratio = devicePixelRatio
    void call('system.zoomChanged', undefined).catch(() => undefined)
  })
}
