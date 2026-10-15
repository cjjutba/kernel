import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LinearIssue, LinearScope } from '@shared/types'
import { call, cleanError } from '../../api'
import { getState, go, useStore } from '../../store'
import { readSaved as readStored, writeSaved } from '../../remember'
import { Button, EmptyList, FailedState, Icon, NotConnectedState, Pill, useListKeys } from '../../ui'
import { IssuePriority, IssueState } from '../../icons'
import { IssueDetail } from './IssueDetail'
import { forgetLinear, generation, getLinearLists, getScope, getSelected, isFresh, setLinearLists, setScope, setSelected } from './cache'
import { CapNote, FilterChip, IssueSkeleton, RefreshNotice, type ProjectHead } from './parts'
import { RowStatus, useReadPrs } from './WorkCard'
import { WorkHeader } from '../work/WorkHeader'
import { useOpenPrCount } from '../prs/model'
import {
  clearedFilter, cyclesFor, cycleLabel, describeFilter, fitFilter, FILTER_KEY, flatIssues, groupIssues, initials, issueAge, joinFits, linkedWorkspaces,
  parseFilter, projectsFor, rowState, serializeFilter, stateShape, workspaceSlug, type SavedFilter
} from './model'
import './issues.css'

/** Where the failure came from decides the words: a rejected token needs reconnecting, anything else is worth trying again. */
type View = { kind: 'loading' } | { kind: 'connect' } | { kind: 'rejected' } | { kind: 'error'; title: string; sub: string } | { kind: 'ready' }

const UNREACHABLE: View = { kind: 'error', title: "Can't reach Linear", sub: 'Check your connection, then try again.' }

function failure(e: unknown): View {
  const message = cleanError(e)
  if (/^Connect Linear/i.test(message)) return { kind: 'connect' }
  if (/rejected the token/i.test(message)) return { kind: 'rejected' }
  if (/could not reach/i.test(message)) return UNREACHABLE
  return { kind: 'error', title: "Can't load issues", sub: message }
}

function readSaved(): SavedFilter {
  return parseFilter(readStored(FILTER_KEY))
}

/** The name of the Linear workspace, kept from the last time an issue came back, so the header can still say it while Linear is down. */
let knownSlug: string | undefined

/**
 * Issues.png and its states: your open Linear issues in a list, the selected one on the right (KERNEL-160). The route's `issueId` opens with
 * that issue selected. Linear's list is the account's, so the project in the header only says which project's page this is (KERNEL-471).
 */
export function LinearIssues({ issueId, head }: { issueId?: string; head: ProjectHead }) {
  const prCount = useOpenPrCount()
  const online = useStore((s) => s.system.online)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const chats = useStore((s) => s.chats)
  const running = useStore((s) => s.running)
  const prs = useStore((s) => s.prs)
  // Groups folded up by the person, by group key. A fold lasts while the screen is open.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const [seed] = useState(() => {
    const cachedScope = getScope()
    const saved = readSaved()
    const f = cachedScope ? fitFilter(saved, cachedScope.value) : saved
    const hit = cachedScope ? getLinearLists(serializeFilter(f)) : undefined
    const last = getSelected('linear')
    const known = hit && last && hit.value.all.concat(hit.value.mine).some((i) => i.id === last)
    return { scope: cachedScope?.value ?? null, filter: f, lists: hit?.value ?? null, fresh: !!cachedScope && !!hit && isFresh(Math.min(cachedScope.at, hit.at)), sel: known ? last : undefined }
  })
  const [view, setView] = useState<View>(seed.lists ? { kind: 'ready' } : { kind: 'loading' })
  const [problem, setProblem] = useState<View | null>(null)
  const [unread, setUnread] = useState(false)
  const [scope, setScope_] = useState<LinearScope | null>(seed.scope)
  const [filter, setFilter] = useState<SavedFilter>(seed.filter)
  const [query, setQuery] = useState('')
  const [lists, setLists] = useState<{ mine: LinearIssue[]; all: LinearIssue[] } | null>(seed.lists)
  const [slug, setSlug] = useState(knownSlug)
  const [sel, setSel] = useState<string | undefined>(issueId ?? seed.sel)
  const [tick, setTick] = useState(0)
  const [refreshing, setRefreshing] = useState(!!seed.lists && !seed.fresh)
  const detail = useRef<HTMLDivElement>(null)

  // The newest load wins, so a slow answer for an old filter can't replace a newer list.
  const seq = useRef(0)
  const scopeRef = useRef<LinearScope | null>(seed.scope)
  const loadedKey = useRef(seed.lists ? `${serializeFilter(seed.filter)}|` : '')
  const hasLists = useRef(!!seed.lists)
  const now = useRef({ filter, query })
  now.current = { filter, query }

  const load = useCallback(async (full: boolean) => {
    const n = ++seq.current
    const stale = () => n !== seq.current
    const gen = generation()
    try {
      let sc = scopeRef.current
      let f = now.current.filter
      if (full || !sc) {
        const rows = await call('integrations.list', undefined)
        if (stale()) return
        if (!rows.find((r) => r.id === 'linear')?.connected) { forgetLinear(); hasLists.current = false; setLists(null); setProblem(null); return setView({ kind: 'connect' }) }
        sc = await call('linear.scope', undefined)
        setScope(sc, gen)
        if (stale()) return
        scopeRef.current = sc
        setScope_(sc)
        f = fitFilter(f, sc)
        if (serializeFilter(f) !== serializeFilter(now.current.filter)) setFilter(f)
      }
      const q = now.current.query.trim() || undefined
      const base = { teamId: f.teamId, projectId: f.projectId, cycleId: f.cycleId, query: q }
      const [mine, all] = await Promise.all([call('linear.issues', { filter: { ...base, mine: true } }), call('linear.issues', { filter: { ...base, mine: false } })])
      if (!q) setLinearLists(serializeFilter(f), { mine, all }, gen)
      if (stale()) return
      loadedKey.current = `${serializeFilter(f)}|${now.current.query}`
      const name = workspaceSlug((all[0] ?? mine[0])?.url)
      if (name) { knownSlug = name; setSlug(name) }
      hasLists.current = true
      setLists({ mine, all })
      setProblem(null)
      setUnread(false)
      setView({ kind: 'ready' })
    } catch (e) {
      if (stale()) return
      const v = failure(e)
      if (v.kind === 'connect') { forgetLinear(); hasLists.current = false; setLists(null); setProblem(null) }
      if (hasLists.current && v.kind !== 'connect') {
        setProblem(v)
        if (loadedKey.current !== `${serializeFilter(now.current.filter)}|${now.current.query}`) { loadedKey.current = ''; setLists(null); setUnread(true) }
      }
      else setView(v)
    }
  }, [])

  // Refreshed when the screen opens, when the window gets focus while it shows, when the connection comes back and on Refresh. No interval.
  useEffect(() => {
    if (seed.lists && seed.fresh) return
    if (seed.lists) void load(true).finally(() => setRefreshing(false))
    else void load(true)
  }, [load])
  useEffect(() => {
    const focus = () => { setTick((t) => t + 1); void load(true) }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [load])
  const wasOnline = useRef(online)
  useEffect(() => {
    if (online && !wasOnline.current) { setTick((t) => t + 1); void load(true) }
    wasOnline.current = online
  }, [online, load])

  // A change of filter or search reads the lists again. The first load, and a filter that load corrected, already did.
  useEffect(() => {
    writeSaved(FILTER_KEY, serializeFilter(filter))
    if (!scopeRef.current || loadedKey.current === `${serializeFilter(filter)}|${query}`) return
    const t = window.setTimeout(() => void load(false), query ? 250 : 0)
    return () => window.clearTimeout(t)
  }, [filter, query, load])

  const refresh = () => {
    setRefreshing(true)
    setTick((t) => t + 1)
    void load(true).finally(() => setRefreshing(false))
  }

  useEffect(() => { if (issueId) setSel(issueId) }, [issueId])

  const list = lists?.[filter.mine ? 'mine' : 'all'] ?? []
  const groups = useMemo(() => groupIssues(list), [list])
  const flat = useMemo(() => flatIssues(groups), [groups])
  const groupKey = (g: { type: string; name: string }) => `${g.type}:${g.name}`
  // The rows a key can reach: those in a group that is open.
  const visible = useMemo(() => flatIssues(groups.filter((g) => !folded.has(groupKey(g)))), [groups, folded])
  const picked = sel !== undefined && (sel === issueId || flat.some((i) => i.id === sel))
  const selId = picked ? sel : visible[0]?.id ?? flat[0]?.id
  const cur = flat.find((i) => i.id === selId)
  useEffect(() => {
    if (!selId || !lists) return
    if (selId !== sel) setSel(selId)
    setSelected('linear', selId)
  }, [selId, sel, lists])
  const fold = (key: string) => setFolded((f) => { const n = new Set(f); if (!n.delete(key)) n.add(key); return n })

  // The PRs behind the rows are read once, so a failing PR can say how many checks fail.
  const rowLinked = useMemo(() => flat.flatMap((i) => linkedWorkspaces(i.id, workspaces)), [flat, workspaces])
  useReadPrs(rowLinked)
  const status = useMemo(() => {
    const runningOf = (w: { id: string }) => (chats[w.id] ?? []).some((c) => running[c.id])
    return new Map(flat.map((i) => [i.id, rowState(linkedWorkspaces(i.id, workspaces), agents, runningOf, prs)]))
  }, [flat, workspaces, agents, chats, running, prs])

  const keys = useListKeys({
    ids: useMemo(() => visible.map((i) => i.id), [visible]),
    rowId: (id) => `is-${id}`,
    current: selId,
    onCurrent: setSel,
    blocked: () => !!getState().ui.modal,
    onOpen: (id) => {
      setSel(id)
      detail.current?.querySelector<HTMLElement>('.is-actions a, .is-actions button')?.focus()
    },
  })

  const failed: View | null = view.kind === 'ready' ? (!online ? UNREACHABLE : problem) : null
  const shown: View = !online && (view.kind === 'rejected' || view.kind === 'error') ? UNREACHABLE : view
  const ready = shown.kind === 'ready' && scope
  const openIntegrations = () => go({ name: 'settings', page: 'integrations' })
  const set = (patch: Partial<SavedFilter>) => setFilter((f) => (scope ? fitFilter({ ...f, ...patch }, scope) : { ...f, ...patch }))
  const count = (n: number | undefined) => (n === undefined ? '' : n >= 100 ? '100+' : String(n))

  return (
    <div className="panel">
      <WorkHeader tab="issues" head={head} counts={{ issues: ready ? count(lists?.all.length) : undefined, prs: prCount }} onRefresh={refresh} refreshing={refreshing} where={shown.kind === 'ready' || shown.kind === 'rejected' || shown.kind === 'error' ? `Linear${slug ? ` · ${slug}` : ''}` : undefined} />

      {ready && scope && (
        <div className="is-bar">
          <div role="group" aria-label="Whose issues" className="is-pills">
            <Pill pressed={filter.mine} onClick={() => set({ mine: true })}>Mine<span className="is-n">{count(lists?.mine.length)}</span></Pill>
            <Pill pressed={!filter.mine} onClick={() => set({ mine: false })}>All<span className="is-n">{count(lists?.all.length)}</span></Pill>
          </div>
          <span className="is-sep" aria-hidden="true" />
          {scope.teams.length > 1 && <FilterChip label="Team" value={filter.teamId ?? ''} options={[{ value: '', label: 'All' }, ...scope.teams.map((t) => ({ value: t.id, label: t.key }))]} onChange={(v) => set({ teamId: v || undefined })} />}
          {scope.teams.length === 1 && <FilterChip label="Team" value={scope.teams[0].id} options={[{ value: scope.teams[0].id, label: scope.teams[0].key }]} onChange={() => undefined} />}
          <FilterChip label="Linear project" value={filter.projectId ?? ''} options={[{ value: '', label: 'All' }, ...projectsFor(scope, filter.teamId).map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => set({ projectId: v || undefined })} />
          <FilterChip label="Cycle" value={filter.cycleId ?? ''} options={[{ value: '', label: 'All' }, ...cyclesFor(scope, filter.teamId).map((c) => ({ value: c.id, label: cycleLabel(c, scope, filter.teamId) }))]} onChange={(v) => set({ cycleId: v || undefined })} />
          <span className="grow" />
          <span className="is-search">
            <Icon name="search" size={14} />
            <input type="search" aria-label="Search issues" placeholder="Search issues" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
        </div>
      )}

      {shown.kind === 'loading' && <IssueSkeleton />}

      {shown.kind === 'connect' && (
        <NotConnectedState icon="plug" title="Connect Linear" page="integrations" label="Open Settings, Integrations">See the issues assigned to you, plan them with Kernel and start a chat from any of them.</NotConnectedState>
      )}

      {shown.kind === 'rejected' && (
        <NotConnectedState icon="key" title="Linear rejected the token" page="integrations" label="Open Settings, Integrations">Reconnect Linear to see your issues again.</NotConnectedState>
      )}

      {shown.kind === 'error' && <FailedState title={shown.title} onRetry={() => load(true)}>{shown.sub}</FailedState>}

      {ready && failed && failed.kind === 'rejected' && (
        <RefreshNotice kind="auth" title="Linear rejected the token" action={<Button size="md" onClick={openIntegrations}>Open Settings, Integrations</Button>}>Reconnect Linear to refresh these issues.</RefreshNotice>
      )}
      {ready && failed && failed.kind === 'error' && (
        <RefreshNotice kind="offline" title={failed.title} action={<Button size="md" busy={refreshing} busyPattern="rotate" busyLabel="Trying" onClick={refresh}>Try again</Button>}>{failed.sub} {unread ? 'No issues are shown for this filter.' : 'The issues below are from the last time it loaded.'}</RefreshNotice>
      )}

      {ready && scope && !unread && flat.length === 0 && (() => {
        const d = describeFilter({ ...filter, query }, scope)
        const none = d.fits.length === 0
        // Mine is what narrows most often, so the way out names it: All shows every open issue the other filters leave.
        const showAll = filter.mine && !query.trim() && !filter.projectId && !filter.cycleId && (lists?.all.length ?? 0) > 0
        return (
          <EmptyList
            icon="search"
            title={none ? 'No open issues' : 'No issues match'}
            action={showAll ? <Button size="lg" onClick={() => set({ mine: false })}>Show all issues</Button> : !none ? <Button size="lg" onClick={() => { setQuery(''); setFilter(clearedFilter(scope)) }}>Clear filters</Button> : undefined}
          >
            {none ? `Nothing is open in ${d.where}.` : `Nothing in ${d.where} fits ${joinFits(d.fits)}. ${filter.mine ? 'Try All instead of Mine, or clear the filters.' : 'Try clearing the filters.'}`}
          </EmptyList>
        )
      })()}

      {ready && flat.length > 0 && (
        <div className="is-body">
          <div className="is-list" aria-label="Issues" onKeyDown={keys.onKeyDown}>
            {groups.map((g) => {
              const key = groupKey(g)
              const open = !folded.has(key)
              return (
              <section key={key} aria-label={g.name}>
                <h3 className="is-group">
                  <button type="button" className="is-fold" aria-expanded={open} aria-label={`${g.name}, ${g.issues.length}`} onClick={() => fold(key)}>
                    <span className="is-chev" data-open={open}><Icon name="chevron" size={12} /></span>
                    <span className="is-slot"><IssueState shape={stateShape(g.type)} /></span><span>{g.name}</span><span className="muted">{g.issues.length}</span>
                  </button>
                </h3>
                {open && <ul>
                  {g.issues.map((i) => {
                    const live = status.get(i.id)
                    return (
                      <li key={i.id}>
                        <button type="button" {...keys.rowProps(i.id)} className="is-row" aria-current={i.id === selId ? 'true' : undefined} onClick={() => setSel(i.id)}>
                          <span className="is-slot"><IssueState shape={stateShape(i.state.type)} /></span>
                          <span className="col grow">
                            <span className="is-title ellipsis">{i.title}</span>
                            <span className="is-sub">
                              <IssuePriority priority={i.priority} size={14} />
                              <span className="mono">{i.id}</span>
                              {i.project && <span className="ellipsis" title={`Linear project: ${i.project.name}`}>{i.project.name}</span>}
                            </span>
                          </span>
                          <span className="is-right">
                            {live ? <RowStatus who={live.who} state={live} /> : issueAge(i.updatedAt)}
                            {!filter.mine && i.assignee && <span className="is-av" role="img" aria-label={`Assigned to ${i.assignee.name}`}>{initials(i.assignee.name)}</span>}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>}
              </section>
              )
            })}
            {list.length >= 100 && <CapNote>Showing the 100 issues updated most recently. Narrow by Linear project, cycle or search to find the rest.</CapNote>}
          </div>
          <div className="is-pane" ref={detail}>
            {selId && <IssueDetail id={selId} summary={cur} tick={tick} onPlanned={() => { setTick((t) => t + 1); void load(true) }} />}
          </div>
        </div>
      )}
    </div>
  )
}
