import { useState } from 'react'
import type { Workspace } from '@shared/types'
import { go, useStore } from '../../store'
import { Icon, Pill, Spinner } from '../../ui'
import { SidebarToggle } from '../../components/PanelToggles'
import { age } from '../inbox/model'
import { MergeButton } from '../workspace/pr/MergeButton'
import type { LeadPr } from '../workspace/pr/leadPrList'
import { checksCell, conflictsCell, reviewCell, usePullRequests, type Cell } from './model'
import './prs.css'

type Filter = 'open' | 'merged'

const filters: [Filter, string][] = [['open', 'Open'], ['merged', 'Merged']]

const openWorkspace = (ws: Workspace) => go({ name: 'workspace', workspaceId: ws.id })

/** One word of a row's state. Red is for what needs a person, and a spinner for what is running. */
function CellText({ cell }: { cell: Cell }) {
  return <span className="prs-cell" data-tone={cell.tone}>{cell.spin && <Spinner label={null} pattern="checker" />}{cell.text}</span>
}

function OpenRow({ row }: { row: LeadPr }) {
  const { ws } = row
  const room = useStore((s) => s.rooms.find((r) => r.id === ws.roomId))
  const pr = useStore((s) => s.prs[ws.id])
  const title = ws.prTitle ?? ws.title ?? ws.name
  return (
    <li className="prs-row">
      <button type="button" className="prs-main" aria-label={`Open ${title}, PR #${ws.prNumber}`} onClick={() => openWorkspace(ws)}>
        <Icon name={ws.prState === 'draft' ? 'prDraft' : 'pr'} size={16} />
        <span className="col" style={{ minWidth: 0 }}>
          <span className="prs-title ellipsis">{title}</span>
          <span className="prs-sub"><span className="mono">#{ws.prNumber}</span><span className="ellipsis">{room?.name}</span><span className="ellipsis">{row.name}</span><span className="mono ellipsis">{ws.branch}</span></span>
        </span>
      </button>
      <CellText cell={checksCell(ws, pr)} />
      <CellText cell={reviewCell(row, pr)} />
      <CellText cell={conflictsCell(ws, pr)} />
      <span className="prs-act">{row.ready && <MergeButton ws={ws} short />}</span>
    </li>
  )
}

function MergedRow({ ws }: { ws: Workspace }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === ws.roomId))
  const agent = useStore((s) => s.agents[ws.roomId]?.find((a) => a.id === ws.agentId))
  const title = ws.prTitle ?? ws.title ?? ws.name
  return (
    <li className="prs-row prs-merged">
      <button type="button" className="prs-main" aria-label={`Open ${title}, PR #${ws.prNumber}`} onClick={() => openWorkspace(ws)}>
        <span className="prs-merged-icon"><Icon name="merged" size={16} /></span>
        <span className="col" style={{ minWidth: 0 }}>
          <span className="prs-title ellipsis">{title}</span>
          <span className="prs-sub"><span className="mono">#{ws.prNumber}</span><span className="ellipsis">{room?.name}</span><span className="ellipsis">{agent?.name ?? ws.agentId}</span><span className="mono ellipsis">{ws.branch}</span></span>
        </span>
      </button>
      <span className="prs-cell" data-tone="faint">Merged {age(ws.mergedAt ?? ws.createdAt)} ago</span>
      <span className="prs-stat mono">{ws.stat && <><span className="add">+{ws.stat.added}</span> <span className="del">-{ws.stat.removed}</span></>}</span>
    </li>
  )
}

/**
 * Pull requests across every room: the open ones with their checks, review and conflicts, and a Merge button on the ready ones,
 * or the recently merged ones. A row opens the PR's workspace.
 */
export function PullRequests({ filter: first }: { filter?: Filter }) {
  const [filter, setFilter] = useState<Filter>(first ?? 'open')
  const { open, merged } = usePullRequests()
  const counts: Record<Filter, number> = { open: open.length, merged: merged.length }
  return (
    <div className="panel">
      <header className="header" style={{ paddingRight: 12 }}>
        <SidebarToggle />
        <Icon name="pr" />
        <h1>Pull requests</h1>
      </header>
      <div className="prs-bar" role="group" aria-label="Filter pull requests">
        {filters.map(([id, label]) => <Pill key={id} pressed={filter === id} onClick={() => setFilter(id)}>{label}<span className="prs-n">{counts[id]}</span></Pill>)}
      </div>
      {filter === 'open' ? (
        open.length ? (
          <div className="prs-scroll">
            <div className="prs-head prs-row" aria-hidden="true"><span>Pull request</span><span>Checks</span><span>Review</span><span>Conflicts</span><span /></div>
            <ul className="prs-list" aria-label="Open pull requests">{open.map((r) => <OpenRow key={r.ws.id} row={r} />)}</ul>
          </div>
        ) : (
          <div className="prs-empty"><h2>No open pull requests</h2><p>When an agent opens a pull request in any room, it shows up here with its checks and review.</p></div>
        )
      ) : merged.length ? (
        <div className="prs-scroll"><ul className="prs-list" aria-label="Merged pull requests">{merged.map((w) => <MergedRow key={w.id} ws={w} />)}</ul></div>
      ) : (
        <div className="prs-empty"><h2>Nothing merged yet</h2><p>Pull requests you merge show up here.</p></div>
      )}
    </div>
  )
}
