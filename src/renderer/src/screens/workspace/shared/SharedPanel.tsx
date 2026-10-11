import type { SharedFile, Workspace } from '@shared/types'
import { useStore, type State } from '../../../store'
import { FileIcon } from '../../../components/FileIcon'
import { kindFile, latestOf, sinceShort, useOpenShared, useSharer } from './shared'
import './shared.css'

/**
 * The files shared in a workspace, newest first. The Lead's workspace lists every file shared in the room, since the Lead hears about all of
 * them (D-104). Used by the count on the panel's tab as well.
 */
export function sharedHere(s: Pick<State, 'shared' | 'agents'>, ws: Workspace): SharedFile[] {
  const room = s.agents[ws.roomId]?.some((a) => a.lead && a.id === ws.agentId)
  return Object.values(s.shared).filter((f) => (room ? f.roomId === ws.roomId : f.workspaceId === ws.id)).sort((a, b) => b.updatedAt - a.updatedAt)
}

function Row({ file, open }: { file: SharedFile; open: boolean }) {
  const by = useSharer(file)
  const openShared = useOpenShared()
  return (
    <button type="button" className="shpanel-row" aria-current={open || undefined} onClick={() => openShared(file.id)}>
      <span className="shpanel-icon" aria-hidden="true"><FileIcon path={kindFile[file.kind]} /></span>
      <span className="shpanel-text">
        <span className="ellipsis">{file.title}</span>
        <span className="shpanel-meta ellipsis">v{latestOf(file).n} · {by} · {sinceShort(file.updatedAt)}</span>
      </span>
    </button>
  )
}

/** The right panel's Shared tab (WorkspaceSharedPanel.png). The row of the file open in a tab is highlighted. */
export function SharedPanel({ ws }: { ws: Workspace }) {
  const files = useStore((s) => sharedHere(s, ws))
  const shown = useStore((s) => s.ui.tabs[ws.id]?.tab)
  if (!files.length) {
    return <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Nothing shared in this workspace yet</span><span style={{ fontSize: 12.5 }}>Files an agent shares show up here.</span></div>
  }
  return (
    <div className="shpanel">
      {files.map((f) => <Row key={f.id} file={f} open={shown === `shared:${f.id}`} />)}
    </div>
  )
}
