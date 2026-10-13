import { HelpMenu } from './HelpMenu'
import { UpdatePill } from './UpdatePill'
import { UsageRow } from './UsageRow'
import './footer.css'

/**
 * The 32px strip under every main panel (KERNEL-588). Usage for Claude Code and Codex sits on the left all the time, with the Usage popover opening
 * above it (KERNEL-674). On the right, the update pill once an update is ready and, always, the Help button with its menu. It sits in the same place whatever is hidden. The hook server being
 * down shows in the banner above the composer, and in Settings, Hooks, no longer here (D-082).
 */
export function Footer() {
  return (
    <footer className="footer ft">
      <UsageRow />
      <span className="grow" />
      <UpdatePill />
      <HelpMenu />
    </footer>
  )
}
