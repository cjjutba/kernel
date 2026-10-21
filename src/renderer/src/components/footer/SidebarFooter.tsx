import { actions, useStore } from '../../store'
import { IconButton } from '../../ui'
import { HelpMenu } from './HelpMenu'
import { UpdateSlot } from './UpdatePill'
import { UsageButton } from './UsageButton'
import './footer.css'

/**
 * The 48px strip at the bottom of the sidebar (KERNEL-1101, Pen 14.1): Settings, Help and Usage on the left, the update button at the right once an update is ready.
 * Usage lives behind its chart icon, which turns amber near a limit and red at one. The popover opens upward from it. It sits in the same place whatever is hidden.
 */
export function SidebarFooter() {
  const inSettings = useStore((s) => s.ui.route.name === 'settings')
  return (
    <footer className="sbf">
      <div className="sbf-icons">
        <IconButton className="sbf-btn" icon="settings" label="Settings" aria-pressed={inSettings || undefined} onClick={() => (inSettings ? actions.ui.leaveSettings() : actions.ui.openSettings())} />
        <HelpMenu />
        <UsageButton />
      </div>
      <div className="sbf-slot"><UpdateSlot /></div>
    </footer>
  )
}
