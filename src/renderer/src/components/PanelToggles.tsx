import { actions, getState, useStore } from '../store'
import { IconButton } from '../ui'

export const toggleSidebar = () => actions.ui.setSidebar(!getState().ui.sidebar)
export const toggleRightPanel = () => actions.ui.setRightPanel(!getState().ui.rightPanel)
/** Focus mode (Cmd+backslash): hides both sides, or shows both once both are hidden. */
export const toggleFocus = () => {
  const { sidebar, rightPanel } = getState().ui
  actions.ui.setSidebar(!sidebar && !rightPanel)
  actions.ui.setRightPanel(!sidebar && !rightPanel)
}

/** First in every screen header. Shows only while the sidebar is hidden, right of the traffic lights, and brings it back (Cmd+B). */
export function SidebarToggle() {
  const open = useStore((s) => s.ui.sidebar)
  return open ? null : <IconButton icon="sidebar" size={15} label="Show sidebar" data-tip-kbd="⌘B" onClick={() => actions.ui.setSidebar(true)} />
}

/** Last in the header of a screen with a right panel (Cmd+Option+B). `name` is what the panel holds, for the label. */
export function RightPanelToggle({ name }: { name: string }) {
  const open = useStore((s) => s.ui.rightPanel)
  return <IconButton icon="panelRight" size={15} label={`${open ? 'Hide' : 'Show'} ${name}`} data-tip-kbd="⌘⌥B" onClick={toggleRightPanel} />
}
