import { useMemo, useState } from 'react'
import type { Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, EmptyState, Icon, Pill, useBusy } from '../../ui'
import { archivedList, endedAt, groupOf, inTab, matches, prLabel, whenLabel, type HistoryGroup, type HistoryTab } from './model'
import { restoredFromHistory } from '../workspace/byHand'
import './history.css'
import { SidebarToggle } from '../../components/PanelToggles'

const tabs: [HistoryTab, string][] = [['all', 'All'], ['merged', 'Merged'], ['notMerged', 'Not merged']]
const groups: HistoryGroup[] = ['Today', 'This week', 'Earlier']

/** History.png: every archived workspace, and a way back. Restore recreates the worktree from its branch and reopens its chats. */
export function History() {
  const workspaces = useStore((s) => s.workspaces)
  const rooms = useStore((s) => s.rooms)
  const agents = useStore((s) => s.agents)
  const [tab, setTab] = useState<HistoryTab>('all')
  const [q, setQ] = useState('')
  const [busy, run] = useBusy()
  const roomName = (w: Workspace) => rooms.find((r) => r.id === w.roomId)?.name
  const agentName = (w: Workspace) => agents[w.roomId]?.find((a) => a.id === w.agentId)?.name ?? w.agentId

  const all = useMemo(() => archivedList(workspaces), [workspaces])
  const found = all.filter((w) => matches(w, q, roomName(w), agentName(w)))
  const rows = found.filter((w) => inTab(w, tab))
  const count = (t: HistoryTab) => found.filter((w) => inTab(w, t)).length

  const restore = (w: Workspace) => run(w.id, async () => {
    try {
      const back = await call('workspaces.restore', { workspaceId: w.id })
      restoredFromHistory(w.id)
      actions.workspaces.upsert(back)
      actions.ui.toast({ title: `Restored ${w.name}`, sub: `Back on ${w.branch}` })
      go({ name: 'workspace', workspaceId: w.id })
    } catch (e) {
      actions.ui.toast({ title: `Could not restore ${w.name}`, sub: (e as Error).message })
    }
  })

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
                    <span className="col hs-name"><span className="ellipsis hs-title">{w.name}</span><span className="ellipsis hs-sub">{agentName(w)}</span></span>
                    <span className="mono ellipsis hs-branch">{w.branch}</span>
                    <span className="ellipsis hs-room">{roomName(w)}</span>
                    <span className="hs-pr" data-merged={w.prState === 'merged' ? 'true' : undefined}>{prLabel(w)}</span>
                    <span className="hs-when">{whenLabel(endedAt(w))}</span>
                    <Button busy={busy === w.id} busyLabel="Restoring" disabled={busy !== null} aria-label={busy === w.id ? `Restoring ${w.name}` : `Restore ${w.name}`} onClick={() => void restore(w)}>Restore</Button>
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
