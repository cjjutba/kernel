import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import { go, useStore } from '../../store'
import { Button, EmptyList, FailedState, Icon, LinkButton, LoadingRow, Pill, Select, Skeleton, Spinner, useListKeys } from '../../ui'
import { failToast, useRetryKey } from '../../retry'
import { oneOf, useRemembered } from '../../remember'
import { WorkHeader, ALL_PROJECTS } from '../work/WorkHeader'
import { GhSignIn } from '../work/GhSignIn'
import { call } from '../../api'
import { useWorkProject } from '../work/useWorkProject'
import { age } from '../inbox/model'
import { MergeButton } from '../workspace/pr/MergeButton'
import { notReviewedTip, type LeadPr } from '../workspace/pr/leadPrList'
import { MERGED_LIMIT, checksCell, conflictsCell, groupMerged, groupOpen, issueKey, matchesMerged, mergedReview, mergedRow, mergedWhen, oldestRead, readFailure, reviewCell, usePullRequests, type Cell } from './model'
import { spotKey, useKeptScroll } from '../../ui/keptScroll'
import './prs.css'

type Filter = 'open' | 'merged'

const filters: [Filter, string][] = [['open', 'Open'], ['merged', 'Merged']]

const openWorkspace = (ws: Workspace) => go({ name: 'workspace', workspaceId: ws.id })

/** One word of a row's state. Green with a check is what passed or was approved, red is what needs a person, and a loader is what is running. The rest is muted. */
function CellText({ cell }: { cell: Cell }) {
  const autoReview = useStore((s) => s.settings?.pr.autoReview)
  const tip = notReviewedTip(cell.text, autoReview)
  return <span className="prs-cell" data-tone={cell.tone} data-tip={tip} aria-description={tip}>{cell.spin ? <Spinner label={null} pattern="checker" /> : cell.icon && <Icon name={cell.icon} size={12} />}{cell.text}</span>
}

type Nav = ReturnType<typeof useListKeys>['rowProps']

function OpenRow({ row, nav }: { row: LeadPr; nav: Nav }) {
  const { ws } = row
  const pr = useStore((s) => s.prs[ws.id])
  const title = ws.prTitle ?? ws.title ?? ws.name
  const key = issueKey(ws)
  return (
    <li className="prs-row" data-keep-id={ws.id}>
      <button type="button" {...nav(ws.id)} className="prs-main" aria-label={`Open ${title}, PR #${ws.prNumber}`} onClick={() => openWorkspace(ws)}>
        <span className="col" style={{ minWidth: 0 }}>
          <span className="prs-title ellipsis">{title}</span>
          <span className="prs-sub"><span className="mono">#{ws.prNumber}</span><span aria-hidden="true" className="prs-dot">·</span><span>{row.name}</span>{key && <><span aria-hidden="true" className="prs-dot">·</span><span className="mono">{key}</span></>}<span aria-hidden="true" className="prs-dot">·</span><span className="mono ellipsis">{ws.branch}</span></span>
        </span>
      </button>
      <CellText cell={checksCell(ws, pr)} />
      <CellText cell={reviewCell(row, pr)} />
      <CellText cell={conflictsCell(ws, pr)} />
      <span className="prs-act">{row.ready && <MergeButton ws={ws} short />}</span>
    </li>
  )
}

const count = (n: number) => n.toLocaleString('en-US')

function MergedRow({ ws, nav, now }: { ws: Workspace; nav: Nav; now: number }) {
  const agent = useStore((s) => s.agents[ws.projectId]?.find((a) => a.id === ws.agentId))
  const { full, text, key } = mergedRow(ws)
  const empty = !!ws.stat && ws.stat.added === 0 && ws.stat.removed === 0
  const review = mergedReview(ws)
  return (
    <li className="prs-row prs-merged" data-keep-id={ws.id}>
      <button type="button" {...nav(ws.id)} className="prs-main" aria-label={`Open ${full}, PR #${ws.prNumber}`} data-tip={full} data-tip-hint={ws.branch} data-tip-align="start" onClick={() => openWorkspace(ws)}>
        <Icon name="merged" size={14} />
        <span className="col" style={{ minWidth: 0 }}>
          <span className="prs-title ellipsis">{text}</span>
          <span className="prs-sub"><span className="mono">#{ws.prNumber}</span><span aria-hidden="true" className="prs-dot">·</span><span className="ellipsis">{agent?.name ?? ws.agentId}</span>{key && <><span aria-hidden="true" className="prs-dot">·</span><span className="mono">{key}</span></>}</span>
        </span>
      </button>
      <span className="prs-cell" data-tone="faint">{mergedWhen(ws.mergedAt ?? ws.createdAt, now)}</span>
      <span className="prs-stat mono">{ws.stat && (empty ? <span className="prs-none">+0 -0</span> : <><span className="add">+{count(ws.stat.added)}</span> <span className="del">-{count(ws.stat.removed)}</span></>)}</span>
      <CellText cell={review} />
    </li>
  )
}

/** Rows the shape of the table while GitHub's first read is out, with what is loading under them (Pen 11.16). */
function PrSkeleton() {
  return (
    <div className="prs-scroll prs-skeleton" role="status" aria-label="Loading pull requests">
      {[300, 240, 280, 200].map((w, i) => (
        <div key={i} className="prs-sk-row"><span className="col"><Skeleton width={w} height={9} /><Skeleton width={150} height={7} /></span><Skeleton width={70} height={9} /><Skeleton width={80} height={9} /><Skeleton width={60} height={9} /></div>
      ))}
      <LoadingRow what="pull requests" inline />
    </div>
  )
}

/**
 * Pull requests across every project: the open ones with their checks, review and conflicts, and a Merge button on the ready ones,
 * or the recently merged ones. A row opens the PR's workspace.
 */
export function PullRequests({ filter: first }: { filter?: Filter }) {
  const [filter, setFilter] = useRemembered<Filter>('kernel.prsTab', oneOf<Filter>(['open', 'merged'], 'open'))
  useLayoutEffect(() => { if (first) setFilter(first) }, [first])
  const all = usePullRequests()
  const { mergedAll, reading, reads, refresh } = all
  // The project the list is narrowed to, or none for every project. A project that was archived or hidden since reads as none.
  const projects = useStore((s) => s.projects)
  const choices = useMemo(() => projects.filter((r) => !r.archived && !r.hidden), [projects])
  const { scope: project, pick } = useWorkProject(choices)
  const online = useStore((s) => s.system.online)
  const [query, setQuery] = useState('')
  const [agentId, setAgentId] = useState('')
  const agentsByProject = useStore((s) => s.agents)
  const agentName = (id: string) => Object.values(agentsByProject).flat().find((a) => a.id === id)?.name ?? id
  const openInScope = useMemo(() => (project ? all.open.filter((r) => r.ws.projectId === project.id) : all.open), [all.open, project])
  // The cap is on the loaded rows of the scope, so one project's list is its own 50 most recent. Search and the agent filter cover only these.
  const inScope = useMemo(() => (project ? mergedAll.filter((w) => w.projectId === project.id) : mergedAll), [mergedAll, project])
  const mergedTotal = inScope.length
  const loaded = useMemo(() => inScope.slice(0, MERGED_LIMIT), [inScope])
  const agentChoices = useMemo(() => [...new Set((filter === 'open' ? openInScope.map((r) => r.ws.agentId) : loaded.map((w) => w.agentId)))].sort((a, b) => agentName(a).localeCompare(agentName(b))), [filter, openInScope, loaded, agentsByProject])
  const agent = agentChoices.includes(agentId) ? agentId : undefined
  const filtering = query.trim() !== '' || !!agent
  const open = useMemo(() => (agent ? openInScope.filter((r) => r.ws.agentId === agent) : openInScope), [openInScope, agent])
  const merged = useMemo(() => loaded.filter((w) => matchesMerged(w, query, agent)), [loaded, query, agent])
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  const prs = useStore((s) => s.prs)
  const groups = useMemo(() => groupOpen(open, prs, choices), [open, prs, choices])
  const mergedGroups = useMemo(() => groupMerged(merged, choices), [merged, choices])
  // A folded group's rows are out of reach of the keys. A fold lasts while the screen is open.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const fold = (id: string) => setFolded((f) => { const n = new Set(f); if (!n.delete(id)) n.add(id); return n })
  const shown = filter === 'open' ? groups.filter((g) => !folded.has(g.id)).flatMap((g) => g.rows.map((r) => r.ws)) : mergedGroups.filter((g) => !folded.has(`m:${g.id}`)).flatMap((g) => g.rows)
  const keys = useListKeys({ ids: shown.map((w) => w.id), rowId: (id) => `prs-${id}`, onOpen: (id) => { const ws = shown.find((w) => w.id === id); if (ws) openWorkspace(ws) } })

  const readAt = oldestRead(reads)
  const failed = reads.find((r) => r.failed)
  // A failed read with nothing cached is not a count of zero: the pill stays blank until a read succeeds.
  const counts: Record<Filter, number | undefined> = { open: failed && openInScope.length === 0 ? undefined : openInScope.length, merged: failed && mergedTotal === 0 ? undefined : mergedTotal }
  // Nothing read yet while GitHub is asked: the first read is still out. Signed out in every project: there is nothing to read until gh signs in.
  const loading = filter === 'open' && reading && readAt === undefined
  const signedOut = reads.length > 0 && reads.every((r) => r.failed === 'signed-out')
  const readAgo = readAt === undefined ? undefined : age(readAt, now) === 'now' ? 'just now' : `${age(readAt, now)} ago`
  const readAgoLong = readAt === undefined ? undefined : age(readAt, now) === 'now' ? 'a moment ago' : `${Math.max(1, Math.round((now - readAt) / 60000))} minutes ago`
  const reread = () => { setRefreshing(true); return refresh().finally(() => setRefreshing(false)) }
  useRetryKey('prs', reread)
  // A read that fails says so once in a toast with Try again. Signed out and offline say it on the page, so they raise none (DESIGN.md, State kinds).
  const failure = failed?.failed
  useEffect(() => {
    if (!failure || failure === 'signed-out' || failure === 'offline' || !online) return
    const nothing = readAt === undefined || (filter === 'merged' && mergedTotal === 0)
    failToast(filter === 'merged' && mergedTotal === 0 ? "Couldn't load merged pull requests" : "Couldn't refresh pull requests", nothing ? readFailure(failure) : `Showing what Kernel read ${readAgoLong}.`, 'prs')
  }, [failure])
  // Each filter keeps its own spot, and one never opened starts at the top. A PR that merged out of Open while away falls back to its neighbor above (KERNEL-919).
  const scroll = useRef<HTMLDivElement>(null)
  useKeptScroll(scroll, { key: spotKey.prs(filter), ready: filter === 'open' ? !loading && open.length > 0 : merged.length > 0 })
  const repoUrl = project ? loaded.find((w) => w.prUrl)?.prUrl?.replace(/\/pull\/\d+.*$/, '') : undefined
  const status = reading ? <><Spinner label={null} pattern="checker" />Reading status from GitHub</> : readAgo ? `Status read ${readAgo}` : null
  const offline = !online || failure === 'offline'

  return (
    <div className="panel">
      <WorkHeader tab="prs" allProjects head={{ projects: choices, project, onProject: pick }} counts={{ prs: all.open.length }} where={status} refreshing={refreshing} onRefresh={() => void reread()} />
      <div className="prs-bar" role="group" aria-label="Filter pull requests">
        {filters.map(([id, label]) => <Pill key={id} pressed={filter === id} onClick={() => setFilter(id)}>{label}{counts[id] !== undefined && <span className="prs-n">{counts[id]}</span>}</Pill>)}
        {agentChoices.length > 0 && (
          <>
            <span className="prs-sep" aria-hidden="true" />
            <Select variant="chip" label="Agent" prefix="Agent" value={agent ?? ''} onChange={setAgentId}
              options={[{ value: '', label: 'All' }, ...agentChoices.map((id) => ({ value: id, label: agentName(id) }))]} />
          </>
        )}
        <span className="grow" />
        {filter === 'merged' && loaded.length > 0 && (
          <span className="prs-search">
            <Icon name="search" size={14} />
            <input type="search" aria-label="Filter pull requests" placeholder="Filter pull requests" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
        )}
      </div>
      {filter === 'open' ? (
        loading ? <PrSkeleton /> : open.length ? (
          <div className="prs-scroll" ref={scroll}>
            <div className="prs-head prs-row" aria-hidden="true"><span>Pull request</span><span>Checks</span><span>Review</span><span>Conflicts</span><span /></div>
            <div aria-label="Open pull requests" onKeyDown={keys.onKeyDown}>
              {groups.map((g) => {
                const isOpen = !folded.has(g.id)
                return (
                  <section key={g.id} aria-label={g.label}>
                    <h3 className="prs-group">
                      <button type="button" className="prs-fold" aria-expanded={isOpen} aria-label={`${g.label}, ${g.rows.length}`} onClick={() => fold(g.id)}>
                        <span className="prs-chev" data-open={isOpen}><Icon name="chevron" size={12} /></span><span className="prs-gname">{g.label}</span><span className="prs-n">{g.rows.length}</span>
                      </button>
                    </h3>
                    {isOpen && <ul className="prs-list">{g.rows.map((r) => <OpenRow key={r.ws.id} row={r} nav={keys.rowProps} />)}</ul>}
                  </section>
                )
              })}
            </div>
          </div>
        ) : signedOut ? (
          <GhSignIn what="pull requests" busy={refreshing} onCheck={reread} />
        ) : failure && failure !== 'signed-out' && openInScope.length === 0 ? (
          <FailedState icon="wifioff" title={offline ? "You're offline" : "Pull requests didn't load"} onRetry={offline ? undefined : reread}>{offline ? "Pull requests show again when you're back online." : 'Kernel will try again on its own.'}</FailedState>
        ) : (
          <EmptyList icon="pr" title="No open pull requests" action={project && all.open.length > 0 ? <Button onClick={() => pick(ALL_PROJECTS)}>Show all projects</Button> : merged.length > 0 ? <Button onClick={() => setFilter('merged')}>Show merged</Button> : undefined}>
            {project && all.open.length > 0 ? `${project.name} has none, but other projects do.` : project ? 'Pull requests your agents open show up here.' : 'None of your projects has an open pull request.'}
          </EmptyList>
        )
      ) : loaded.length ? (
        <div className="prs-scroll" ref={scroll}>
          <div className="prs-head prs-row prs-merged" aria-hidden="true"><span>Pull request</span><span>Merged</span><span>Size</span><span>Review</span></div>
          {filtering ? (
            <p className="prs-cap" role="status">
              {`${count(merged.length)} of ${count(loaded.length)} merged pull requests match.`}
              {mergedTotal > MERGED_LIMIT && ` Search covers only the latest ${MERGED_LIMIT} of ${count(mergedTotal)}.`}
            </p>
          ) : null}
          {merged.length ? (
            <div aria-label="Merged pull requests" onKeyDown={keys.onKeyDown}>
              {mergedGroups.map((g) => {
                const isOpen = !folded.has(`m:${g.id}`)
                return (
                  <section key={g.id} aria-label={g.label}>
                    <h3 className="prs-group">
                      <button type="button" className="prs-fold" aria-expanded={isOpen} aria-label={`${g.label}, ${g.rows.length}`} onClick={() => fold(`m:${g.id}`)}>
                        <span className="prs-chev" data-open={isOpen}><Icon name="chevron" size={12} /></span><span className="prs-gname">{g.label}</span><span className="prs-n">{g.rows.length}</span>
                      </button>
                    </h3>
                    {isOpen && <ul className="prs-list">{g.rows.map((w) => <MergedRow key={w.id} ws={w} nav={keys.rowProps} now={now} />)}</ul>}
                  </section>
                )
              })}
              {!filtering && mergedTotal > MERGED_LIMIT && (
                <p className="prs-cap" role="status">
                  Showing the last {MERGED_LIMIT} merged.
                  {repoUrl && <> <LinkButton variant="inline" size="meta" onClick={() => void call('system.openExternal', { url: `${repoUrl}/pulls?q=is%3Apr+is%3Amerged` })}>See the rest on GitHub<Icon name="ext" size={12} /></LinkButton></>}
                </p>
              )}
            </div>
          ) : (
            <EmptyList icon="search" title="No merged pull request matches" action={<Button onClick={() => { setQuery(''); setAgentId('') }}>Clear filters</Button>}>
              {mergedTotal > MERGED_LIMIT ? `Search covered the latest ${MERGED_LIMIT} of ${count(mergedTotal)} merged pull requests, not older ones.` : 'Nothing in the merged list matches that search.'}
            </EmptyList>
          )}
        </div>
      ) : failure && failure !== 'signed-out' ? (
        <FailedState icon="wifioff" title={offline ? "You're offline" : "Merged pull requests didn't load"} onRetry={offline ? undefined : reread}>{offline ? "Merged pull requests show again when you're back online." : 'Kernel will try again on its own.'}</FailedState>
      ) : (
        <EmptyList icon="merged" title="Nothing merged yet">Merged pull requests from the last 30 days show up here.</EmptyList>
      )}
    </div>
  )
}
