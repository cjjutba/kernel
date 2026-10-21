import { useEffect } from 'react'
import type { BottomKind, UiState } from '@shared/types'
import { actions, getState, NEW_CHAT_HELD, panelShownIn, useStore } from '../store'
import { IconButton, Kbd } from '../ui'
import { toggleBottomPanel } from '../screens/workspace/bottomSplit'

/** Window widths below which a panel folds: the right panel first, then the sidebar (D-080). */
const FOLD_BELOW = { rightPanel: 1024, sidebar: 900 } as const

/** Folds the sidebar and right panel when the window gets narrow, and brings them back when it widens. Runs once, in App. */
export function useFoldPanels() {
  useEffect(() => {
    const narrow = { rightPanel: false, sidebar: false }
    const check = () => {
      for (const panel of ['rightPanel', 'sidebar'] as const) {
        const now = window.innerWidth < FOLD_BELOW[panel]
        if (now !== narrow[panel]) { narrow[panel] = now; actions.ui.fold(panel, now) }
      }
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
}

export const toggleSidebar = () => actions.ui.setSidebar(!getState().ui.sidebar)
/** The workspace in view, or New chat's own id, for a panel held closed (KERNEL-788). */
const inView = (route: ReturnType<typeof getState>['ui']['route']) => (route.name === 'workspace' ? route.workspaceId : route.name === 'leadNew' ? NEW_CHAT_HELD : undefined)
/** What the toggle flips is what the screen shows: in a held chat the panel is closed even while the global flag is on, so one press opens it. */
export const toggleRightPanel = () => {
  const { ui } = getState()
  actions.ui.setRightPanel(!panelShownIn(ui, inView(ui.route)))
}
/** The Session rail is what the right side shows: wanted, and no panel over it. A teammate's workspace and a chat with Kernel have one (KERNEL-1096). */
export const railShownIn = (ui: Pick<UiState, 'rail' | 'rightPanel' | 'panelHeld'>, workspaceId?: string) => ui.rail && !panelShownIn(ui, workspaceId)

/**
 * The title bar's Session toggle: from the panel it switches to the rail, from the rail it hides it, and from neither it brings it back. Pressing the panel's toggle and this
 * one therefore switch between the two, and pressing the one that is on leaves neither, which is Focus mode once the sidebar is hidden too (KERNEL-1096).
 */
export const toggleRail = () => {
  const { ui } = getState()
  if (panelShownIn(ui, inView(ui.route))) { actions.ui.setRightPanel(false); actions.ui.setRail(true) }
  else actions.ui.setRail(!ui.rail)
}

/** What was on before Focus mode hid it, so leaving Focus puts it back. */
let beforeFocus: { rightPanel: boolean; rail: boolean } | null = null
/** Focus mode (Cmd+backslash): hides the sidebar, the panel and the rail, or shows them again as they were once all are hidden. */
export const toggleFocus = () => {
  const { sidebar, rightPanel, rail } = getState().ui
  if (sidebar || rightPanel || rail) {
    beforeFocus = { rightPanel, rail }
    actions.ui.setSidebar(false)
    actions.ui.setRightPanel(false)
    actions.ui.setRail(false)
    return
  }
  const back = beforeFocus ?? { rightPanel: false, rail: true }
  actions.ui.setSidebar(true)
  actions.ui.setRightPanel(back.rightPanel)
  actions.ui.setRail(back.rail)
}

/** Back and Forward (⌘[ and ⌘]), each disabled when the history has nowhere reachable to go. In the sidebar's top strip, and in the screen header while the sidebar is hidden (KERNEL-643). In the header they sit 1px lower, which puts them on the strip's row: the header's content area is 43px (its border), the strip's 44px. */
export function HistoryButtons({ inHeader }: { inHeader?: boolean }) {
  const { canBack, canForward } = useStore((s) => s.ui.nav)
  const cls = inHeader ? 'nodrag hist-in-header' : 'nodrag'
  return (
    <>
      <IconButton className={cls} icon="arrowLeft" size={16} label="Back" data-tip-kbd="⌘[" disabled={!canBack} onClick={() => actions.ui.back()} />
      <IconButton className={cls} icon="arrowRight" size={16} label="Forward" data-tip-kbd="⌘]" disabled={!canForward} onClick={() => actions.ui.forward()} />
    </>
  )
}

/**
 * The sidebar toggle (Cmd+B), rendered once by App at a fixed spot in the window (`.sidebar-toggle` in tokens.css): x 87, centered on the header row (y 9 to 53).
 * It is the same element with the sidebar open or hidden, so its position never changes and hover survives a click. The sidebar's strip and the screen headers keep
 * an empty slot under it (`SidebarToggleSlot`), as the right panel's toggle does (KERNEL-769).
 */
export function SidebarToggle() {
  const open = useStore((s) => s.ui.sidebar)
  return <IconButton className="sidebar-toggle" icon="sidebar" size={16} label={open ? 'Hide sidebar' : 'Show sidebar'} data-tip-kbd="⌘B" onClick={toggleSidebar} />
}

/** First in every screen header. The project the toggle sits over, right of the traffic lights, while the sidebar is hidden. Back and Forward follow it. */
export function SidebarToggleSlot() {
  const open = useStore((s) => s.ui.sidebar)
  return open ? null : (
    <>
      <span className="sidebar-toggle-slot" aria-hidden="true" />
      <HistoryButtons inHeader />
    </>
  )
}

/**
 * The title bar's view toggles of a workspace (Pen 9.1): the bottom pane, the Session rail and the right panel, in the header's right corner. The rail and the panel switch
 * places, and the one that is on turns off when it is pressed. `kind` says whose bottom pane it is. New chat has no workspace and so no bottom pane: it passes no `kind`, and the button is left out.
 */
export function ViewToggles({ kind }: { kind?: BottomKind }) {
  const ui = useStore((s) => s.ui)
  const id = inView(ui.route)
  const panel = panelShownIn(ui, id)
  const bottomOpen = !!kind && panel && !ui.bottomCollapsed[kind]
  return (
    <div className="view-toggles" role="group" aria-label="Views">
      {kind && <IconButton icon="panelBottom" size={16} label={bottomOpen ? 'Hide bottom panel' : 'Show bottom panel'} aria-pressed={bottomOpen} data-tip-kbd="⌘J" onClick={toggleBottomPanel} />}
      <IconButton icon="railList" size={16} label={railShownIn(ui, id) ? 'Hide Session' : 'Show Session'} aria-pressed={railShownIn(ui, id)} onClick={toggleRail} />
      <IconButton icon="panelRight" size={16} label={panel ? 'Hide panels' : 'Show panels'} aria-pressed={panel} data-tip-kbd="⌘⇧B" onClick={toggleRightPanel} />
    </div>
  )
}

/** Shown in the title bar while Focus mode hides everything: the way back, with its key. */
export function FocusChip() {
  return (
    <button type="button" className="focus-chip" aria-label="Leave Focus mode" onClick={toggleFocus}>
      Focus<Kbd>⌘\</Kbd>
    </button>
  )
}
