import { useLayoutEffect } from 'react'
import type { Workspace } from '@shared/types'
import { go, useStore } from '../../store'
import { Banner, Icon, Pill, Spinner, useListKeys } from '../../ui'
import { oneOf, useRemembered } from '../../remember'
import { SidebarToggleSlot } from '../../components/PanelToggles'
import { age } from '../inbox/model'
import { MergeButton } from '../workspace/pr/MergeButton'
import type { LeadPr } from '../workspace/pr/leadPrList'
import { MERGED_LIMIT, checksCell, conflictsCell, oldestRead, readFailure, reviewCell, usePullRequests, type Cell } from './model'
import './prs.css'

type Filter = 'open' | 'merged'

const filters: [Filter, string][] = [['open', 'Open'], ['merged', 'Merged']]

const openWorkspace = (ws: Workspace) => go({ name: 'workspace', workspaceId: ws.id })

/** One word of a row's state. Red is for what needs a person, and a spinner for what is running. */
function CellText({ cell }: { cell: Cell }) {
  return <span className="prs-cell" data-tone={cell.tone}>{cell.spin && <Spinner label={null} pattern="checker" />}{cell.text}</span>
}

type Nav = ReturnType<typeof useListKeys>['rowProps']

function OpenRow({ row, nav }: { row: LeadPr; nav: Nav }) {
  const { ws } = row
  const room = useStore((s) => s.rooms.find((r) => r.id === ws.roomId))
  const pr = useStore((s) => s.prs[ws.id])
  const title = ws.prTitle ?? ws.title ?? ws.name
  return (
    <li className="prs-row">
      <button type="button" {...nav(ws.id)} className="prs-main" aria-label={`Open ${title}, PR #${ws.prNumber}`} onClick={() => openWorkspace(ws)}>
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

function MergedRow({ ws, nav }: { ws: Workspace; nav: Nav }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === ws.roomId))
  const agent = useStore((s) => s.agents[ws.roomId]?.find((a) => a.id === ws.agentId))
  const title = ws.prTitle ?? ws.title ?? ws.name
  return (
    <li className="prs-row prs-merged">
      <button type="button" {...nav(ws.id)} className="prs-main" aria-label={`Open ${title}, PR #${ws.prNumber}`} onClick={() => openWorkspace(ws)}>
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
  const [filter, setFilter] = useRemembered<Filter>('kernel.prsTab', oneOf<Filter>(['open', 'merged'], 'open'))
  useLayoutEffect(() => { if (first) setFilter(first) }, [first])
  const { open, merged, mergedTotal, reading, reads } = usePullRequests()
  const shown = filter === 'open' ? open.map((r) => r.ws) : merged
  const keys = useListKeys({ ids: shown.map((w) => w.id), rowId: (id) => `prs-${id}`, onOpen: (id) => { const ws = shown.find((w) => w.id === id); if (ws) openWorkspace(ws) } })
  const counts: Record<Filter, number> = { open: open.length, merged: merged.length }
  const readAt = oldestRead(reads)
  const failed = reads.find((r) => r.failed)
  const readAgo = readAt === undefined ? undefined : age(readAt) === 'now' ? 'just now' : `${age(readAt)} ago`
  return (
    <div className="panel">
      <header className="header" style={{ paddingRight: 12 }}>
        <SidebarToggleSlot />
        <Icon name="pr" />
        <h1>Pull requests</h1>
      </header>
      <div className="prs-bar" role="group" aria-label="Filter pull requests">
        {filters.map(([id, label]) => <Pill key={id} pressed={filter === id} onClick={() => setFilter(id)}>{label}<span className="prs-n">{counts[id]}</span></Pill>)}
        <span className="prs-read" role="status">
          {reading ? <><Spinner label={null} pattern="checker" />Reading status from GitHub</> : readAgo ? `Status read ${readAgo}` : null}
        </span>
      </div>
      {failed?.failed && (
        <div className="prs-banner">
          <Banner kind="warn" title="Couldn't read pull request status from GitHub">{readFailure(failed.failed)} {readAgo ? `Showing what was read ${readAgo}.` : 'Nothing has been read yet, so the lists may be missing pull requests.'}</Banner>
        </div>
      )}
      {filter === 'open' ? (
        open.length ? (
          <div className="prs-scroll">
            <div className="prs-head prs-row" aria-hidden="true"><span>Pull request</span><span>Checks</span><span>Review</span><span>Conflicts</span><span /></div>
            <ul className="prs-list" aria-label="Open pull requests" onKeyDown={keys.onKeyDown}>{open.map((r) => <OpenRow key={r.ws.id} row={r} nav={keys.rowProps} />)}</ul>
          </div>
        ) : (
          <div className="prs-empty"><h2>No open pull requests</h2><p>When an agent opens a pull request in any room, it shows up here with its checks and review.</p></div>
        )
      ) : merged.length ? (
        <div className="prs-scroll">
          <ul className="prs-list" aria-label="Merged pull requests" onKeyDown={keys.onKeyDown}>{merged.map((w) => <MergedRow key={w.id} ws={w} nav={keys.rowProps} />)}</ul>
          {mergedTotal > MERGED_LIMIT && <p className="prs-cap">Showing the {MERGED_LIMIT} most recent of {mergedTotal} merged pull requests.</p>}
        </div>
      ) : (
        <div className="prs-empty"><h2>Nothing merged yet</h2><p>Pull requests you merge show up here.</p></div>
      )}
    </div>
  )
}
