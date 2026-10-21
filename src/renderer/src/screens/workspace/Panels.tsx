import { useState } from 'react'
import type { ChangedFile, PanelTab, Workspace } from '@shared/types'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { leadModeOf } from '@shared/leadMode'
import { isLeadWorkspace, leadOf } from '../../lead'
import { actions, useStore } from '../../store'
import { IconButton } from '../../ui'
import { LeadPrs } from './pr/LeadPrs'
import { useLeadPrs } from './pr/leadPrList'
import { ToolSlot } from './PanelTools'
import { ChangesTab } from './panel/ChangesTab'
import { FilesTab } from './panel/FilesTab'
import { PullRequestTab } from './panel/PullRequestTab'
import { ReviewTab } from './panel/ReviewTab'
import { TabStrip } from './panel/TabStrip'

// The right panel's tabs and its bottom pane live in panel/. What other files and tests import from here stays importable from here.
export { SHARED_NOTHING, sharedWhy } from './panel/ChangesTab'
export { BottomPanel } from './panel/BottomPane'
export { checkGroups, checkRow, checksUrl } from './panel/PullRequestTab'

/** The Team PRs tab's count: the PRs the Lead's list shows, plain and faint as on the Lead's own tabs. */
function TeamPrsCount({ projectId }: { projectId: string }) {
  return <span className="tab-count">{useLeadPrs(projectId).length}</span>
}

/**
 * The right panel (Pen 9.3): its tabs on the left and Expand and Close on the right, then the tab. A teammate's workspace has Files, Changes, Review and Pull request. The Lead's
 * has PRs, Files and Changes, and a chat with Kernel in Build here has its own pull request as well (KERNEL-780). `filePath` and `diffPath` are the file and diff tabs showing in the
 * center, drawn selected while the panel has no room for a pane of its own. `expanded` is the panel taking the whole screen.
 */
export function RightPanel({ ws, changes, onOpenFile, onOpenDiff, filePath, diffPath, expanded, onExpand }: {
  ws: Workspace; changes: ChangedFile[]; onOpenFile: (path: string) => void; onOpenDiff: (path: string) => void; filePath?: string; diffPath?: string; expanded: boolean; onExpand: () => void
}) {
  const isLead = useStore((s) => isLeadWorkspace(ws, ws.projectId, leadOf(s.agents, ws.projectId)?.id))
  const shown = useStore((s) => (isLead ? s.ui.workspace.leadRight ?? 'prs' : s.ui.workspace.right))
  // A chat with Kernel in Build here works like a teammate's workspace: its own PR, Changes and review, with the Lead's PR list as the Team PRs tab (KERNEL-780).
  const build = isLead && isLeadChatWorkspace(ws) && leadModeOf(ws) === 'build'
  // Once its PR has merged the chat has nothing of its own open, so the panel goes back to the team's PRs.
  const idle = build && shown === 'changes' && ws.prState === 'merged' && changes.length === 0
  const own = !isLead || build
  const ids: PanelTab[] = [...(isLead ? ['prs' as const] : []), 'files', 'changes', ...(own ? ['review' as const, 'pr' as const] : [])]
  const right: PanelTab = idle ? 'prs' : ids.includes(shown) ? shown : ids.includes('changes') ? 'changes' : ids[0]
  const count = (n: number) => <span className="tab-count">{n}</span>
  const pick = (id: string) => actions.ui.setWorkspaceView(isLead ? { leadRight: id as PanelTab } : { right: id as PanelTab })
  // The Lead's list takes the strip's right side for its own buttons (PanelTools).
  const [tools, setTools] = useState<HTMLDivElement | null>(null)
  const label = (id: PanelTab) => (id === 'prs' ? (build ? <>Team PRs <TeamPrsCount projectId={ws.projectId} /></> : <>PRs <TeamPrsCount projectId={ws.projectId} /></>) : id === 'files' ? 'Files' : id === 'changes' ? <>Changes {changes.length > 0 && count(changes.length)}</> : id === 'review' ? 'Review' : 'Pull request')
  return (
    <ToolSlot.Provider value={tools}>
      <div className="col grow" style={{ minHeight: 0 }}>
        <div className="side-head">
          <TabStrip label="Workspace panel" value={right} onChange={pick} tabs={ids.map((id) => ({ id, label: label(id) }))} />
          <div ref={setTools} className="panel-tools" role="toolbar" aria-label="Panel actions" />
          <div className="side-actions">
            <IconButton icon="maximize" size={14} box="md" label={expanded ? 'Restore panel size' : 'Expand panel'} aria-pressed={expanded} onClick={onExpand} />
            <IconButton icon="close" size={14} box="md" label="Close panel" onClick={() => actions.ui.setRightPanel(false)} />
          </div>
        </div>
        {right === 'prs' && <LeadPrs projectId={ws.projectId} />}
        {right === 'files' && <FilesTab key={ws.id} ws={ws} changes={changes} onOpenFile={onOpenFile} filePath={filePath} />}
        {right === 'changes' && <ChangesTab key={ws.id} ws={ws} changes={changes} onOpenDiff={onOpenDiff} diffPath={diffPath} />}
        {right === 'review' && <ReviewTab key={ws.id} ws={ws} />}
        {right === 'pr' && <PullRequestTab key={ws.id} ws={ws} changes={changes} />}
      </div>
    </ToolSlot.Provider>
  )
}
