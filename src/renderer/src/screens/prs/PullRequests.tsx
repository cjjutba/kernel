import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import { go, useStore } from '../../store'
import { Banner, Button, DayGroupHeader, EmptyList, Icon, NotConnectedState, Pill, ScopeLabel, Select, Skeleton, Spinner, groupByDay, useListKeys } from '../../ui'
import { oneOf, useRemembered } from '../../remember'
import { WorkHeader, ALL_PROJECTS } from '../work/WorkHeader'
import { useWorkProject } from '../work/useWorkProject'
import { useGithubLogin } from '../work/useGithubLogin'
import { age } from '../inbox/model'
import { MergeButton } from '../workspace/pr/MergeButton'
import { notReviewedTip, type LeadPr } from '../workspace/pr/leadPrList'
import { MERGED_LIMIT, checksCell, conflictsCell, groupOpen, issueKey, matchesMerged, mergedRow, oldestRead, readFailure, reviewCell, usePullRequests, type Cell } from './model'
import { spotKey, useKeptScroll } from '../../ui/keptScroll'
import './prs.css'

type Filter = 'open' | 'merged'

const filters: [Filter, string][] = [['open', 'Open'], ['merged', 'Merged']]

const openWorkspace = (ws: Workspace) => go({ name: 'workspace', workspaceId: ws.id })

/** One word of a row's state. Red is for what needs a person, and a spinner for what is running. */
function CellText({ cell }: { cell: Cell }) {
  const autoReview = useStore((s) => s.settings?.pr.autoReview)
  const tip = notReviewedTip(cell.text, autoReview)
  return <span className="prs-cell" data-tone={cell.tone} data-tip={tip} aria-description={tip}>{cell.spin && <Spinner label={null} pattern="checker" />}{cell.text}</span>
}

type Nav = ReturnType<typeof useListKeys>['rowProps']

function OpenRow({ row, nav }: { row: LeadPr; nav: Nav }) {
  const { ws } = row
  const project = useStore((s) => s.projects.find((r) => r.id === ws.projectId))
  const pr = useStore((s) => s.prs[ws.id])
  const title = ws.prTitle ?? ws.title ?? ws.name
  const key = issueKey(ws)
  return (
    <li className="prs-row" data-keep-id={ws.id}>
      <button type="button" {...nav(ws.id)} className="prs-main" aria-label={`Open ${title}, PR #${ws.prNumber}`} onClick={() => openWorkspace(ws)}>
        <Icon name={ws.prState === 'draft' ? 'prDraft' : 'pr'} size={16} />
        <span className="col" style={{ minWidth: 0 }}>
          <span className="prs-title ellipsis">{title}</span>
          <span className="prs-sub"><span className="mono">#{ws.prNumber}</span><span className="ellipsis">{project?.name}</span><span className="ellipsis">{row.name}</span>{key && <span className="mono">{key}</span>}<span className="mono ellipsis">{ws.branch}</span></span>
        </span>
      </button>
      <CellText cell={checksCell(ws, pr)} />
      <CellText cell={reviewCell(row, pr)} />
      <CellText cell={conflictsCell(ws, pr)} />
      <span className="prs-act">{row.ready && <MergeButton ws={ws} short />}</span>
    </li>
  )
}

const ago = (t: number, now: number) => (age(t, now) === 'now' ? 'just now' : `${age(t, now)} ago`)
const count = (n: number) => n.toLocaleString('en-US')

function MergedRow({ ws, nav, now, withProject }: { ws: Workspace; nav: Nav; now: number; withProject: boolean }) {
  const project = useStore((s) => s.projects.find((r) => r.id === ws.projectId))
  const agent = useStore((s) => s.agents[ws.projectId]?.find((a) => a.id === ws.agentId))
  const { full, text, scope, key } = mergedRow(ws)
  const empty = !!ws.stat && ws.stat.added === 0 && ws.stat.removed === 0
  return (
    <li className="prs-row prs-merged" data-keep-id={ws.id}>
      <button type="button" {...nav(ws.id)} className="prs-main" aria-label={`Open ${full}, PR #${ws.prNumber}`} data-tip={full} data-tip-hint={ws.branch} data-tip-align="start" onClick={() => openWorkspace(ws)}>
        <span className="col" style={{ minWidth: 0 }}>
          <span className="prs-line"><span className="prs-title ellipsis">{text}</span>{scope && <ScopeLabel>{scope}</ScopeLabel>}</span>
          <span className="prs-sub"><span className="mono">#{ws.prNumber}</span><span aria-hidden="true">·</span><span className="ellipsis">{agent?.name ?? ws.agentId}</span>{withProject && project && <><span aria-hidden="true">·</span><span className="ellipsis">{project.name}</span></>}</span>
        </span>
      </button>
      <span className="prs-key">{key && <button type="button" className="prs-key-link mono" aria-label={`Open issue ${key}`} onClick={() => go({ name: 'issues', issueId: key, projectId: ws.projectId })}>{key}</button>}</span>
      <span className="prs-cell" data-tone="faint">{ago(ws.mergedAt ?? ws.createdAt, now)}</span>
      <span className="prs-stat mono">{ws.stat && (empty ? <span className="prs-none">+0 -0</span> : <><span className="add">+{count(ws.stat.added)}</span> <span className="del">-{count(ws.stat.removed)}</span></>)}</span>
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
            <div key={i} className="prs-row"><span className="col gap-8"><Skeleton width={`${62 - i * 14}%`} height={11} /><Skeleton width="30%" height={9} /></span><Skeleton width={60} height={10} /><Skeleton width={70} height={10} /><Skeleton width={40} height={10} /><span /></div>
          ))}
        </div>
      ))}
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
  const login = useGithubLogin()
  const open = project ? all.open.filter((r) => r.ws.projectId === project.id) : all.open
  // The cap is on the loaded rows of the scope, so one project's list is its own 50 most recent. Search and the agent filter cover only these.
  const inScope = useMemo(() => (project ? mergedAll.filter((w) => w.projectId === project.id) : mergedAll), [mergedAll, project])
  const mergedTotal = inScope.length
  const loaded = useMemo(() => inScope.slice(0, MERGED_LIMIT), [inScope])
  const [query, setQuery] = useState('')
  const [agentId, setAgentId] = useState('')
  const agentsByProject = useStore((s) => s.agents)
  const agentName = (id: string) => Object.values(agentsByProject).flat().find((a) => a.id === id)?.name ?? id
  const agentChoices = useMemo(() => [...new Set(loaded.map((w) => w.agentId))].sort((a, b) => agentName(a).localeCompare(agentName(b))), [loaded, agentsByProject])
  const filtering = query.trim() !== '' || (agentId !== '' && agentChoices.includes(agentId))
  const merged = useMemo(() => loaded.filter((w) => matchesMerged(w, query, agentChoices.includes(agentId) ? agentId : undefined)), [loaded, query, agentId, agentChoices])
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  const prs = useStore((s) => s.prs)
  const groups = useMemo(() => groupOpen(open, prs), [open, prs])
  const mergedGroups = useMemo(() => groupByDay(merged, (w) => w.mergedAt ?? w.createdAt, now), [merged, now])
  const projectsShown = !project && choices.length > 1
  // A folded group's rows are out of reach of the keys. A fold lasts while the screen is open.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const fold = (id: string) => setFolded((f) => { const n = new Set(f); if (!n.delete(id)) n.add(id); return n })
  const shown = filter === 'open' ? groups.filter((g) => !folded.has(g.id)).flatMap((g) => g.rows.map((r) => r.ws)) : merged
  const keys = useListKeys({ ids: shown.map((w) => w.id), rowId: (id) => `prs-${id}`, onOpen: (id) => { const ws = shown.find((w) => w.id === id); if (ws) openWorkspace(ws) } })
  
  const readAt = oldestRead(reads)
  const failed = reads.find((r) => r.failed)
  // A failed read with nothing cached is not a count of zero: the pill stays blank until a read succeeds.
  const counts: Record<Filter, number | undefined> = { open: failed && open.length === 0 ? undefined : open.length, merged: failed && mergedTotal === 0 ? undefined : mergedTotal }
  // Nothing read yet while GitHub is asked: the first read is still out. Signed out in every project: there is nothing to read until gh signs in.
  const loading = filter === 'open' && reading && readAt === undefined
  const signedOut = reads.length > 0 && reads.every((r) => r.failed === 'signed-out')
  const readAgo = readAt === undefined ? undefined : age(readAt, now) === 'now' ? 'just now' : `${age(readAt, now)} ago`
  // Each filter keeps its own spot, and one never opened starts at the top. A PR that merged out of Open while away falls back to its neighbor above (KERNEL-919).
  const scroll = useRef<HTMLDivElement>(null)
  useKeptScroll(scroll, { key: spotKey.prs(filter), ready: filter === 'open' ? !loading && open.length > 0 : merged.length > 0 })
  return (
    <div className="panel">
      <WorkHeader tab="prs" allProjects head={{ projects: choices, project, onProject: pick }} counts={{ prs: all.open.length }} where={login ? `GitHub · ${login}` : 'GitHub'} refreshing={refreshing}
        onRefresh={() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)) }} />
      <div className="prs-bar" role="group" aria-label="Filter pull requests">
        {filters.map(([id, label]) => <Pill key={id} pressed={filter === id} onClick={() => setFilter(id)}>{label}{counts[id] !== undefined && <span className="prs-n">{counts[id]}</span>}</Pill>)}
        {filter === 'merged' && loaded.length > 0 && (
          <>
            <Select variant="chip" label="Agent" prefix="Agent" value={agentChoices.includes(agentId) ? agentId : ''} onChange={setAgentId}
              options={[{ value: '', label: 'All' }, ...agentChoices.map((id) => ({ value: id, label: agentName(id) }))]} />
            <span className="prs-search">
              <Icon name="search" size={14} />
              <input type="search" aria-label="Search merged pull requests" placeholder="Search merged" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
            </span>
          </>
        )}
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
          <div className="prs-scroll" ref={scroll}>
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
          <EmptyList icon="pr" title="No open pull requests" action={project && all.open.length > 0 ? <Button size="lg" onClick={() => pick(ALL_PROJECTS)}>Show all projects</Button> : merged.length > 0 ? <Button size="lg" onClick={() => setFilter('merged')}>Show merged</Button> : undefined}>
            {project && all.open.length > 0 ? `${project.name} has none, but other projects do.` : 'When an agent opens a pull request in any project, it shows up here with its checks and review.'}
          </EmptyList>
        )
      ) : loaded.length ? (
        <div className="prs-scroll" ref={scroll}>
          <div className="prs-merged-wrap">
            {mergedTotal > MERGED_LIMIT || filtering ? (
              <p className="prs-cap" role="status">
                {filtering ? `${count(merged.length)} of ${count(loaded.length)} merged pull requests match.` : `Showing the ${MERGED_LIMIT} most recent of ${count(mergedTotal)} merged pull requests.`}
                {filtering && mergedTotal > MERGED_LIMIT && ` Search covers only the latest ${MERGED_LIMIT} of ${count(mergedTotal)}.`}
              </p>
            ) : null}
            {merged.length ? (
              <div aria-label="Merged pull requests" onKeyDown={keys.onKeyDown}>
                {mergedGroups.map((g) => (
                  <section key={g.id} aria-label={g.label}>
                    <DayGroupHeader label={g.label} count={g.rows.length} />
                    <ul className="prs-list">{g.rows.map((w) => <MergedRow key={w.id} ws={w} nav={keys.rowProps} now={now} withProject={projectsShown} />)}</ul>
                  </section>
                ))}
              </div>
            ) : (
              <EmptyList icon="pr" title="No merged pull request matches" action={<Button size="lg" onClick={() => { setQuery(''); setAgentId('') }}>Clear search</Button>}>
                {mergedTotal > MERGED_LIMIT ? `Search covered the latest ${MERGED_LIMIT} of ${count(mergedTotal)} merged pull requests, not older ones.` : 'Nothing in the merged list matches that search.'}
              </EmptyList>
            )}
          </div>
        </div>
      ) : failed?.failed ? (
        <EmptyList icon="merged" title="Couldn't tell what merged">{readFailure(failed.failed)} Merged pull requests will show here once GitHub can be read.</EmptyList>
      ) : (
        <EmptyList icon="merged" title="Nothing merged yet">Pull requests you merge show up here.</EmptyList>
      )}
    </div>
  )
}
