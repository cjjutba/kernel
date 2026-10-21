import type { RefObject } from 'react'
import { actions, BOTTOM_RATIO_DEFAULT, useStore } from '../../store'
import { ResizeHandle } from '../../components/ResizeHandle'
import { BOTTOM_MIN, bottomHeight, bottomLimits, ratioFor } from './bottomSplit'

/**
 * The handle on the bottom drawer's top edge, the hairline under the chat (KERNEL-513, KERNEL-1212). It sets the one fraction every chat shares, so a
 * drag in one chat is the height in the next. `panel` is `.bottom-panel`, and its parent `.ws-main` is the chat column that the fraction is of.
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
