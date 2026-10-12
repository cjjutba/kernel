import type { RefObject } from 'react'
import { actions, BOTTOM_RATIO_DEFAULT, useStore } from '../../store'
import { ResizeHandle } from '../../components/ResizeHandle'
import { BOTTOM_MIN, bottomHeight, bottomLimits, ratioFor } from './bottomSplit'

/**
 * The handle on the bottom pane's top edge, the hairline between the right panel's panes (KERNEL-513). It sets the one fraction every chat shares, so a
 * drag in one chat is the height in the next. `panel` is `.bottom-panel`, and its parent `.ws-split` is the panel below the PR band that the fraction is of.
 */
export function BottomResize({ panel }: { panel: RefObject<HTMLElement | null> }) {
  const ratio = useStore((s) => s.ui.bottomRatio)
  const container = () => panel.current?.parentElement?.clientHeight ?? window.innerHeight
  return (
    <ResizeHandle
      targetRef={panel} edge="top" label="Resize bottom panel" size={bottomHeight(ratio, container())} min={BOTTOM_MIN} limit={() => bottomLimits(container()).max}
      defaultSize={() => bottomHeight(BOTTOM_RATIO_DEFAULT, container())} onCommit={(h) => actions.ui.setBottomRatio(h === null ? null : ratioFor(h, container()))}
    />
  )
}
