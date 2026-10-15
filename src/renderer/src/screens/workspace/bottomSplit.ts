import type { BottomKind, Workspace } from '@shared/types'
import { isLeadWorkspace, leadOf } from '../../lead'
import { actions, BOTTOM_RATIO_DEFAULT, getState, type State } from '../../store'

/**
 * The right panel's two panes (KERNEL-513). The bottom pane is a fraction of the panel below the PR band, and `.ws-split` and `.bottom-panel` in
 * workspace.css clamp it to the same limits: the top keeps `TOP_MIN` and the bottom its tab bar plus about 120px, so a window of any height keeps both panes.
 */
export const TAB_BAR = 40
export const BOTTOM_MIN = TAB_BAR + 120
export const TOP_MIN = 160

/** The smallest and largest the bottom pane gets in a panel `container` px tall. The panel never gets so short that `max` falls under `min`. */
export function bottomLimits(container: number) {
  return { min: BOTTOM_MIN, max: Math.max(BOTTOM_MIN, container - TOP_MIN) }
}

/** The height a saved fraction gives in a panel `container` px tall, as workspace.css computes it. */
export function bottomHeight(ratio: number, container: number) {
  const { min, max } = bottomLimits(container)
  return Math.round(Math.min(max, Math.max(min, ratio * container)))
}

/** The fraction a dragged height saves, to four places so the proportion survives a window of another size. */
export function ratioFor(height: number, container: number) {
  return container > 0 ? Math.round((height / container) * 10_000) / 10_000 : BOTTOM_RATIO_DEFAULT
}

/** Lead chats and teammates' workspaces each remember whether the bottom pane is collapsed. */
export const bottomKindOf = (s: Pick<State, 'agents'>, ws: Workspace): BottomKind => (isLeadWorkspace(ws, ws.projectId, leadOf(s.agents, ws.projectId)?.id) ? 'lead' : 'teammate')

/** ⌘J. On a workspace screen it collapses or opens the bottom pane; with the right panel hidden it brings the panel back with the pane open. */
export function toggleBottomPanel() {
  const s = getState()
  const { route, rightPanel, bottomCollapsed } = s.ui
  const ws = route.name === 'workspace' ? s.workspaces.find((w) => w.id === route.workspaceId) : undefined
  if (!ws) return
  const kind = bottomKindOf(s, ws)
  if (!rightPanel) actions.ui.setRightPanel(true)
  actions.ui.setBottomCollapsed(kind, rightPanel ? !bottomCollapsed[kind] : false)
}
