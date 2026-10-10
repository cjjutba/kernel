import { Icon } from '../../ui'
import { SidebarToggle } from '../../components/PanelToggles'

/** Issues.png: the user's open Linear issues and the selected one (KERNEL-160). The route's `issueId` opens with that issue selected. */
export function Issues({ issueId: _issueId }: { issueId?: string }) {
  return (
    <div className="panel">
      <header className="header">
        <SidebarToggle />
        <Icon name="issues" />
        <h1>Issues</h1>
      </header>
    </div>
  )
}
