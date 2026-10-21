import type { BottomKind, Workspace } from '@shared/types'
import { isLeadWorkspace, leadOf } from '../../lead'
import { actions, BOTTOM_RATIO_DEFAULT, getState, type State } from '../../store'

/**
 * The chat column and the drawer under it (KERNEL-513, moved out of the right panel). The drawer is a fraction of the chat column's height, and `.bottom-panel`
 * in workspace.css clamps it to the same limits: the chat keeps `TOP_MIN` for the transcript and composer and the drawer its tab bar plus about 120px, so a window of any height keeps both.
 */
export const TAB_BAR = 40
export const BOTTOM_MIN = TAB_BAR + 120
export const TOP_MIN = 320

/** The smallest and largest the bottom pane gets in a chat column `container` px tall. The column never gets so short that `max` falls under `min`. */
export function bottomLimits(container: number) {
  return { min: BOTTOM_MIN, max: Math.max(BOTTOM_MIN, container - TOP_MIN) }
}

/** The height a saved fraction gives in a chat column `container` px tall, as workspace.css computes it. */
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

/** ⌘J and the title bar's first toggle. On a workspace screen it folds or opens the drawer under the chat, whether or not the right panel shows. */
export function toggleBottomPanel() {
  const s = getState()
  const { route, bottomCollapsed } = s.ui
  const ws = route.name === 'workspace' ? s.workspaces.find((w) => w.id === route.workspaceId) : undefined
  if (!ws) return
  const kind = bottomKindOf(s, ws)
  actions.ui.setBottomCollapsed(kind, !bottomCollapsed[kind])
}
