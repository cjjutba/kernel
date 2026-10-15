import { useLayoutEffect, useMemo, useState } from 'react'
import type { Workspace } from '@shared/types'
import { go, useStore } from '../../store'
import { Banner, Button, EmptyList, Icon, NotConnectedState, Pill, Skeleton, Spinner, useListKeys } from '../../ui'
import { oneOf, useRemembered } from '../../remember'
import { WorkHeader, ALL_ROOMS } from '../work/WorkHeader'
import { age } from '../inbox/model'
import { MergeButton } from '../workspace/pr/MergeButton'
import type { LeadPr } from '../workspace/pr/leadPrList'
import { MERGED_LIMIT, checksCell, conflictsCell, groupOpen, issueKey, oldestRead, readFailure, reviewCell, usePullRequests, type Cell } from './model'
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
  const key = issueKey(ws)
  return (
    <li className="prs-row">
      <button type="button" {...nav(ws.id)} className="prs-main" aria-label={`Open ${title}, PR #${ws.prNumber}`} onClick={() => openWorkspace(ws)}>
        <Icon name={ws.prState === 'draft' ? 'prDraft' : 'pr'} size={16} />
        <span className="col" style={{ minWidth: 0 }}>
          <span className="prs-title ellipsis">{title}</span>
          <span className="prs-sub"><span className="mono">#{ws.prNumber}</span><span className="ellipsis">{room?.name}</span><span className="ellipsis">{row.name}</span>{key && <span className="mono">{key}</span>}<span className="mono ellipsis">{ws.branch}</span></span>
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

/** Rows the shape of the list's own while GitHub's first read is out. */
function PrSkeleton() {
  return (
    <div className="prs-scroll prs-skeleton" role="status" aria-label="Loading pull requests">
      {[2, 1].map((n, g) => (
        <div key={g}>
          <div className="prs-group"><Skeleton width={110} height={10} /></div>
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="prs-row"><span className="col" style={{ gap: 8 }}><Skeleton width={`${62 - i * 14}%`} height={11} /><Skeleton width="30%" height={9} /></span><Skeleton width={60} height={10} /><Skeleton width={70} height={10} /><Skeleton width={40} height={10} /><span /></div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Pull requests across every room: the open ones with their checks, review and conflicts, and a Merge button on the ready ones,
 * or the recently merged ones. A row opens the PR's workspace.
 */
export function PullRequests({ filter: first }: { filter?: Filter }) {
  const [filter, setFilter] = useRemembered<Filter>('kernel.prsTab', oneOf<Filter>(['open', 'merged'], 'open'))
  useLayoutEffect(() => { if (first) setFilter(first) }, [first])
  const all = usePullRequests()
  const { mergedTotal, reading, reads, refresh } = all
  // The room the list is narrowed to, or none for every room. A room that was archived or hidden since reads as none.
  const rooms = useStore((s) => s.rooms)
  const choices = useMemo(() => rooms.filter((r) => !r.archived && !r.hidden), [rooms])
  const [roomId, setRoomId] = useRemembered<string>('kernel.prsRoom', (raw) => raw ?? ALL_ROOMS)
  const room = choices.find((r) => r.id === roomId)
  const open = room ? all.open.filter((r) => r.ws.roomId === room.id) : all.open
  const merged = room ? all.merged.filter((w) => w.roomId === room.id) : all.merged
  const [refreshing, setRefreshing] = useState(false)
  const prs = useStore((s) => s.prs)
  const groups = useMemo(() => groupOpen(open, prs), [open, prs])
  // A folded group's rows are out of reach of the keys. A fold lasts while the screen is open.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const fold = (id: string) => setFolded((f) => { const n = new Set(f); if (!n.delete(id)) n.add(id); return n })
  const shown = filter === 'open' ? groups.filter((g) => !folded.has(g.id)).flatMap((g) => g.rows.map((r) => r.ws)) : merged
  const keys = useListKeys({ ids: shown.map((w) => w.id), rowId: (id) => `prs-${id}`, onOpen: (id) => { const ws = shown.find((w) => w.id === id); if (ws) openWorkspace(ws) } })
  const counts: Record<Filter, number> = { open: open.length, merged: merged.length }
  const readAt = oldestRead(reads)
  const failed = reads.find((r) => r.failed)
  // Nothing read yet while GitHub is asked: the first read is still out. Signed out in every room: there is nothing to read until gh signs in.
  const loading = filter === 'open' && reading && readAt === undefined
  const signedOut = reads.length > 0 && reads.every((r) => r.failed === 'signed-out')
  const readAgo = readAt === undefined ? undefined : age(readAt) === 'now' ? 'just now' : `${age(readAt)} ago`
  return (
    <div className="panel">
      <WorkHeader tab="prs" allRooms head={{ rooms: choices, room, onRoom: setRoomId }} counts={{ prs: open.length }} where="GitHub" refreshing={refreshing}
        onRefresh={() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)) }} />
      <div className="prs-bar" role="group" aria-label="Filter pull requests">
        {filters.map(([id, label]) => <Pill key={id} pressed={filter === id} onClick={() => setFilter(id)}>{label}<span className="prs-n">{counts[id]}</span></Pill>)}
        <span className="prs-read" role="status">
          {reading ? <><Spinner label={null} pattern="checker" />Reading status from GitHub</> : readAgo ? `Status read ${readAgo}` : null}
        </span>
      </div>
      {failed?.failed && !(signedOut && open.length === 0) && (
        <div className="prs-banner">
          <Banner kind="warn" title="Couldn't read pull request status from GitHub">{readFailure(failed.failed)} {readAgo ? `Showing what was read ${readAgo}.` : 'Nothing has been read yet, so the lists may be missing pull requests.'}</Banner>
        </div>
      )}
      {filter === 'open' ? (
        loading ? <PrSkeleton /> : open.length ? (
          <div className="prs-scroll">
            <div className="prs-head prs-row" aria-hidden="true"><span>Pull request</span><span>Checks</span><span>Review</span><span>Conflicts</span><span /></div>
            <div aria-label="Open pull requests" onKeyDown={keys.onKeyDown}>
              {groups.map((g) => {
                const isOpen = !folded.has(g.id)
                return (
                  <section key={g.id} aria-label={g.label}>
                    <h3 className="prs-group">
                      <button type="button" className="prs-fold" aria-expanded={isOpen} aria-label={`${g.label}, ${g.rows.length}`} onClick={() => fold(g.id)}>
                        <span className="prs-chev" data-open={isOpen}><Icon name="chevron" size={12} /></span><span>{g.label}</span><span className="prs-n">{g.rows.length}</span>
                      </button>
                    </h3>
                    {isOpen && <ul className="prs-list">{g.rows.map((r) => <OpenRow key={r.ws.id} row={r} nav={keys.rowProps} />)}</ul>}
                  </section>
                )
              })}
            </div>
          </div>
        ) : signedOut ? (
          <NotConnectedState icon="key" title="GitHub isn't signed in" page="integrations" label="Open Settings, Integrations">Sign the GitHub CLI in and the pull requests your agents open show up here with their checks and review.</NotConnectedState>
        ) : (
          <EmptyList icon="pr" title="No open pull requests" action={room && all.open.length > 0 ? <Button size="lg" onClick={() => setRoomId(ALL_ROOMS)}>Show all rooms</Button> : merged.length > 0 ? <Button size="lg" onClick={() => setFilter('merged')}>Show merged</Button> : undefined}>
            {room && all.open.length > 0 ? `${room.name} has none, but other rooms do.` : 'When an agent opens a pull request in any room, it shows up here with its checks and review.'}
          </EmptyList>
        )
      ) : merged.length ? (
        <div className="prs-scroll">
          <ul className="prs-list" aria-label="Merged pull requests" onKeyDown={keys.onKeyDown}>{merged.map((w) => <MergedRow key={w.id} ws={w} nav={keys.rowProps} />)}</ul>
          {mergedTotal > MERGED_LIMIT && <p className="prs-cap">Showing the {MERGED_LIMIT} most recent of {mergedTotal} merged pull requests.</p>}
        </div>
      ) : (
        <EmptyList icon="merged" title="Nothing merged yet">Pull requests you merge show up here.</EmptyList>
      )}
    </div>
  )
}
