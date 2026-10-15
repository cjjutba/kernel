import { useEffect } from 'react'
import { actions, getState, panelShownIn, useStore } from '../store'
import { IconButton } from '../ui'

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
/** The workspace in view, for a panel a New chat holds closed (KERNEL-788). */
const inView = (route: ReturnType<typeof getState>['ui']['route']) => (route.name === 'workspace' ? route.workspaceId : undefined)
/** What the toggle flips is what the screen shows: in a held chat the panel is closed even while the global flag is on, so one press opens it. */
export const toggleRightPanel = () => {
  const { ui } = getState()
  actions.ui.setRightPanel(!panelShownIn(ui, inView(ui.route)))
}
/** Focus mode (Cmd+backslash): hides both sides, or shows both once both are hidden. */
export const toggleFocus = () => {
  const { sidebar, rightPanel } = getState().ui
  actions.ui.setSidebar(!sidebar && !rightPanel)
  actions.ui.setRightPanel(!sidebar && !rightPanel)
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
 * The toggle of a screen with a right panel (Cmd+Shift+B, or Cmd+Option+B), rendered once, at a fixed spot in the screen's top right
 * corner (`.panel-toggle` in workspace.css). It is positioned against the screen and not against the header or the PR band, so it never
 * moves when the panel opens or closes. `name` is what the panel holds, for the label.
 */
export function RightPanelToggle({ name }: { name: string }) {
  const open = useStore((s) => panelShownIn(s.ui, inView(s.ui.route)))
  return <IconButton className="panel-toggle" icon="panelRight" size={16} label={`${open ? 'Hide' : 'Show'} ${name}`} data-tip-kbd="⌘⇧B" onClick={toggleRightPanel} />
}

/** The empty project the header or the PR band keeps for the toggle, which sits over it. */
export function PanelToggleSlot() {
  return <span className="panel-toggle-slot" aria-hidden="true" />
}
