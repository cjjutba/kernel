import { IconButton } from '../../../ui'
import type { ImageZoom } from './useImageZoom'

/**
 * The zoom control in a shared image's toolbar (KERNEL-598): minus, the percent drawn, plus. The percent goes back to Fit. A button at the end
 * of its range is `aria-disabled` and not `disabled`, so focus stays on it when a click or a key reaches the end.
 */
export function ZoomControl({ zoom }: { zoom: ImageZoom }) {
  const can = (ok: boolean) => (zoom.ready && ok ? undefined : true)
  return (
    <div className="shared-zoom-ctl" role="group" aria-label="Zoom">
      <IconButton box="xs" icon="minus" size={14} label="Zoom out" data-tip-kbd="⌘-" aria-disabled={can(zoom.canOut)} onClick={() => zoom.canOut && zoom.zoomOut()} />
      <button type="button" className="shared-zoom-pct" aria-label={`${zoom.label}, fit to window`} data-tip="Fit to window" data-tip-kbd="⌘0" aria-disabled={can(true)} onClick={zoom.fit}>{zoom.label}</button>
      <IconButton box="xs" icon="plus" size={14} label="Zoom in" data-tip-kbd="⌘+" aria-disabled={can(zoom.canIn)} onClick={() => zoom.canIn && zoom.zoomIn()} />
    </div>
  )
}
