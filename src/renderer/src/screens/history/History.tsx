import { useMemo, useState } from 'react'
import type { Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, EmptyState, Icon, IconButton, Pill, useBusy } from '../../ui'
import { archivedList, historyName, deleteAllLabel, endedAt, groupOf, inTab, matches, prGlyph, prLabel, whenLabel, type HistoryGroup, type HistoryTab } from './model'
import { restoredFromHistory } from '../workspace/byHand'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import './history.css'
import { SidebarToggle } from '../../components/PanelToggles'

const tabs: [HistoryTab, string][] = [['all', 'All'], ['merged', 'Merged'], ['notMerged', 'Not merged']]
const groups: HistoryGroup[] = ['Today', 'This week', 'Earlier']

/**
 * History.png: every archived workspace, and a way back. Restore recreates the worktree from its branch and reopens its chats.
 * Delete is the way out (KERNEL-333): one row, or every row in view.
 */
export function History() {
  const workspaces = useStore((s) => s.workspaces)
  const rooms = useStore((s) => s.rooms)
  const agents = useStore((s) => s.agents)
  const [tab, setTab] = useState<HistoryTab>('all')
  const [q, setQ] = useState('')
  const [busy, run] = useBusy()
  const roomName = (w: Workspace) => rooms.find((r) => r.id === w.roomId)?.name
  const agentName = (w: Workspace) => agents[w.roomId]?.find((a) => a.id === w.agentId)?.name ?? w.agentId
  const threads = useStore((s) => s.threads)
  const nameOf = (w: Workspace) => historyName(w, threads)

  const all = useMemo(() => archivedList(workspaces), [workspaces])
  const found = all.filter((w) => matches({ ...w, name: nameOf(w) }, q, roomName(w), agentName(w)))
  const rows = found.filter((w) => inTab(w, tab))
  const count = (t: HistoryTab) => found.filter((w) => inTab(w, t)).length

  const restore = (w: Workspace) => run(w.id, async () => {
    try {
      const back = await call('workspaces.restore', { workspaceId: w.id })
      restoredFromHistory(w.id)
      actions.workspaces.upsert(back)
      // A worktree sets up again before its agent goes on, and the workspace shows it (KERNEL-77).
      go({ name: 'workspace', workspaceId: w.id })
    } catch (e) {
      actions.ui.toast({ title: `Could not restore ${nameOf(w)}`, sub: cleanError(e) })
    }
  })

  const confirmDelete = (workspaceIds: string[]) => actions.ui.openModal({ name: 'confirm', kind: 'deleteHistory', workspaceIds })

  return (
    <div className="panel">
      <header className="header" style={{ paddingRight: 12 }}>
        <SidebarToggle />
        <Icon name="history" />
        <h1>History</h1>
        <span className="grow" />
        <input type="search" className="input hs-search" placeholder="Search workspaces" aria-label="Search workspaces" value={q} onChange={(e) => setQ(e.target.value)} />
      </header>
      <div className="hs-tabs" role="group" aria-label="Filter history">
        {tabs.map(([id, label]) => <Pill key={id} pressed={tab === id} onClick={() => setTab(id)}>{label}<span className="hs-n">{count(id)}</span></Pill>)}
        {rows.length > 0 && <Button variant="ghost" className="hs-bulk" disabled={busy !== null} onClick={() => confirmDelete(rows.map((w) => w.id))}>{deleteAllLabel(tab, q.trim() !== '', rows.length)}</Button>}
      </div>
      <div className="hs-body">
        {groups.map((g) => {
          const list = rows.filter((w) => groupOf(endedAt(w)) === g)
          if (!list.length) return null
          return (
            <section key={g} aria-label={g}>
              <h2 className="hs-group">{g}</h2>
              <ul className="hs-list">
                {list.map((w) => (
                  <li key={w.id} className="hs-row">
                    <span className="col hs-name"><span className="ellipsis hs-title">{isLeadChatWorkspace(w) && <Icon name="chat" size={14} />}{nameOf(w)}</span><span className="ellipsis hs-sub">{agentName(w)}</span></span>
                    <span className="mono ellipsis hs-branch">{w.branch}</span>
                    <span className="ellipsis hs-room">{roomName(w)}</span>
                    <span className="hs-pr" data-merged={w.prState === 'merged' ? 'true' : undefined}>{w.prNumber ? <Icon name={prGlyph(w)} size={12} /> : null}{prLabel(w)}</span>
                    <span className="hs-when">{whenLabel(endedAt(w))}</span>
                    <span className="hs-actions">
                      <Button busy={busy === w.id} busyPattern="wave-back" busyLabel="Restoring" disabled={busy !== null} aria-label={busy === w.id ? `Restoring ${nameOf(w)}` : `Restore ${nameOf(w)}`} onClick={() => void restore(w)}>Restore</Button>
                      <IconButton icon="trash" label={`Delete ${nameOf(w)}`} disabled={busy !== null} onClick={() => confirmDelete([w.id])} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
        {!rows.length && (
          <EmptyState icon="history" title={all.length ? 'Nothing matches' : 'Nothing archived yet'}>
            {all.length ? 'Try another word, or another tab.' : 'Workspaces you archive or finish land here, and you can bring any of them back.'}
          </EmptyState>
        )}
      </div>
    </div>
  )
}
