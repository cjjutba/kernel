import { useEffect } from 'react'
import { actions, getState, useStore } from '../store'
import { IconButton } from '../ui'
import { AskRowanButton } from './footer/QuickAsk'
import { UpdatePill } from './footer/UpdatePill'

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
export const toggleRightPanel = () => actions.ui.setRightPanel(!getState().ui.rightPanel)
/** Focus mode (Cmd+backslash): hides both sides, or shows both once both are hidden. */
export const toggleFocus = () => {
  const { sidebar, rightPanel } = getState().ui
  actions.ui.setSidebar(!sidebar && !rightPanel)
  actions.ui.setRightPanel(!sidebar && !rightPanel)
}

/**
 * First in every screen header. Shows only while the sidebar is hidden, right of the traffic lights, and brings it back (Cmd+B).
 * What the sidebar's bottom row holds that can't wait comes along: Ask Rowan, and the update pill once an update is ready (KERNEL-527).
 */
export function SidebarToggle() {
  const open = useStore((s) => s.ui.sidebar)
  const onFloor = useStore((s) => s.ui.route.name === 'floor')
  if (open) return null
  return (
    <>
      <IconButton icon="sidebar" size={15} label="Show sidebar" data-tip-kbd="⌘B" onClick={() => actions.ui.setSidebar(true)} />
      {!onFloor && <AskRowanButton />}
      <UpdatePill />
    </>
  )
}

/** Last in the header of a screen with a right panel (Cmd+Shift+B, or Cmd+Option+B). `name` is what the panel holds, for the label. */
export function RightPanelToggle({ name }: { name: string }) {
  const open = useStore((s) => s.ui.rightPanel)
  return <IconButton icon="panelRight" size={15} label={`${open ? 'Hide' : 'Show'} ${name}`} data-tip-kbd="⌘⇧B" onClick={toggleRightPanel} />
}
