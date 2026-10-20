import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LinearIssue, LinearScope } from '@shared/types'
import { call, cleanError } from '../../api'
import { getState, go, useStore } from '../../store'
import { readSaved as readStored, writeSaved } from '../../remember'
import { Button, EmptyList, FailedState, Icon, LinkButton, Pill, useListKeys } from '../../ui'
import { failToast, useRetryKey } from '../../retry'
import { IssueState } from '../../icons'
import { IssueDetail } from './IssueDetail'
import { spotKey, useKeptScroll } from '../../ui/keptScroll'
import { forgetLinear, generation, getLinearLists, getScope, getSelected, isFresh, setLinearLists, setScope, setSelected } from './cache'
import { CapNote, ConnectLinear, FilterChip, HiddenNote, IssueSkeleton, type ProjectHead } from './parts'
import { useReveal } from './useReveal'
import { RowStatus, useReadPrs } from './WorkCard'
import { WorkHeader } from '../work/WorkHeader'
import { useOpenPrCount } from '../prs/model'
import {
  ageTip, clearedFilter, cyclesFor, cycleLabel, describeFilter, fitFilter, FILTER_KEY, flatIssues, groupIssues, initials, issueAge, joinFits, linkedWorkspaces,
  parseFilter, projectsFor, rowState, serializeFilter, stateShape, type SavedFilter
} from './model'
import './issues.css'

/** Where the failure came from decides the words: a rejected token needs signing in again, anything else is worth trying again. `message` is what the toast says. */
type View = { kind: 'loading' } | { kind: 'connect' } | { kind: 'rejected' } | { kind: 'error'; message: string } | { kind: 'ready' }

function failure(e: unknown): View {
  const message = cleanError(e)
  if (/^Connect Linear/i.test(message)) return { kind: 'connect' }
  if (/rejected the token/i.test(message)) return { kind: 'rejected' }
  return { kind: 'error', message }
}

function readSaved(): SavedFilter {
  return parseFilter(readStored(FILTER_KEY))
}

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
  const approvals = useStore((s) => s.approvals)
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
  const [scope, setScope_] = useState<LinearScope | null>(seed.scope)
  const [filter, setFilter] = useState<SavedFilter>(seed.filter)
  const [query, setQuery] = useState('')
  const [lists, setLists] = useState<{ mine: LinearIssue[]; all: LinearIssue[] } | null>(seed.lists)
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
        if (!rows.find((r) => r.id === 'linear')?.connected) { forgetLinear(); hasLists.current = false; setLists(null); return setView({ kind: 'connect' }) }
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
      hasLists.current = true
      setLists({ mine, all })
      setView({ kind: 'ready' })
    } catch (e) {
      if (stale()) return
      const v = failure(e)
      if (v.kind === 'connect') { forgetLinear(); hasLists.current = false; setLists(null) }
      // A failed read keeps the rows it has, unless they were for another filter. Either way the toast carries the error (DESIGN.md, State kinds).
      const keep = hasLists.current && v.kind === 'error' && loadedKey.current === `${serializeFilter(now.current.filter)}|${now.current.query}`
      if (v.kind === 'error' && getState().system.online) failToast(hasLists.current ? "Couldn't refresh issues" : "Couldn't load issues from Linear", v.message, 'issues')
      if (!keep) { if (hasLists.current) { loadedKey.current = ''; setLists(null) } setView(v) }
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
  // Opening an issue, or a cleared filter bringing it back, opens its group, in case the person folded it earlier.
  useEffect(() => {
    const g = groups.find((x) => x.issues.some((i) => i.id === selId))
    if (g) setFolded((f) => (f.has(groupKey(g)) ? new Set([...f].filter((k) => k !== groupKey(g))) : f))
  }, [selId, !!cur])
  const fold = (key: string) => setFolded((f) => { const n = new Set(f); if (!n.delete(key)) n.add(key); return n })

  // The PRs behind the rows are read once, so a failing PR can say how many checks fail.
  const rowLinked = useMemo(() => flat.flatMap((i) => linkedWorkspaces(i.id, workspaces)), [flat, workspaces])
  useReadPrs(rowLinked)
  const status = useMemo(() => {
    const runningOf = (w: { id: string }) => (chats[w.id] ?? []).some((c) => running[c.id])
    const waitingOf = (w: { id: string }) => approvals.some((a) => a.status === 'pending' && a.workspaceId === w.id)
    return new Map(flat.map((i) => [i.id, rowState(linkedWorkspaces(i.id, workspaces), agents, runningOf, prs, waitingOf)]))
  }, [flat, workspaces, agents, chats, running, prs, approvals])

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

  // Offline with nothing to show says so, and no toast: the screen already tells it (DESIGN.md, State kinds).
  const offline = !online && (view.kind === 'error' || view.kind === 'rejected')
  const shown: View = view
  const ready = shown.kind === 'ready' && scope
  const retry = useCallback(() => load(true), [load])
  useRetryKey('issues', retry)
  const listEl = useRef<HTMLDivElement>(null)
  const keep = spotKey.issues(head.project?.id ?? 'none')
  const kept = useKeptScroll(listEl, { key: keep, ready: !!ready && flat.length > 0 })
  useReveal(listEl, selId, !!ready && flat.length > 0, folded, kept.stop)
  // The open issue came from a link or the last visit, and the filter leaves it out of the list.
  const hidden = !!ready && !!lists && !!selId && !cur && flat.length > 0
  const hiddenFits = scope ? describeFilter({ ...filter, query }, scope).fits : []
  // Every issue in the list is in one Linear project, so naming it on each row says nothing.
  const oneProject = flat.length > 0 && flat.every((i) => i.project?.id === flat[0].project?.id)
  const openIntegrations = () => go({ name: 'settings', page: 'integrations' })
  const set = (patch: Partial<SavedFilter>) => setFilter((f) => (scope ? fitFilter({ ...f, ...patch }, scope) : { ...f, ...patch }))
  const count = (n: number | undefined) => (n === undefined ? '' : n >= 100 ? '100+' : String(n))

  const filtered = !!filter.projectId || !!filter.cycleId || ((scope?.teams.length ?? 0) > 1 && !!filter.teamId) || query.trim() !== ''
  const clear = () => { setQuery(''); if (scope) setFilter(clearedFilter(scope)) }
  const bar = !!scope && (shown.kind === 'ready' || shown.kind === 'error')

  return (
    <div className="panel">
      <WorkHeader tab="issues" head={head} counts={{ issues: ready ? count(lists?.all.length) : undefined, prs: prCount }} onRefresh={refresh} refreshing={refreshing} />

      {bar && (
        <div className="is-bar">
          <div role="group" aria-label="Whose issues" className="is-pills">
            <Pill pressed={filter.mine} onClick={() => set({ mine: true })}>Mine<span className="is-n">{count(lists?.mine.length)}</span></Pill>
            <Pill pressed={!filter.mine} onClick={() => set({ mine: false })}>All<span className="is-n">{count(lists?.all.length)}</span></Pill>
          </div>
          <span className="is-sep" aria-hidden="true" />
          {scope.teams.length > 1 && <FilterChip label="Team" value={filter.teamId ?? ''} options={[{ value: '', label: 'All' }, ...scope.teams.map((t) => ({ value: t.id, label: t.key }))]} onChange={(v) => set({ teamId: v || undefined })} />}
          <FilterChip label="Linear project" prefix="Linear:" value={filter.projectId ?? ''} options={[{ value: '', label: 'All projects' }, ...projectsFor(scope, filter.teamId).map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => set({ projectId: v || undefined })} />
          <FilterChip label="Cycle" value={filter.cycleId ?? ''} options={[{ value: '', label: 'All' }, ...cyclesFor(scope, filter.teamId).map((c) => ({ value: c.id, label: cycleLabel(c, scope, filter.teamId) }))]} onChange={(v) => set({ cycleId: v || undefined })} />
          <span className="grow" />
          {filtered && <LinkButton variant="action" size="meta" onClick={clear}>Clear filters</LinkButton>}
          <span className="is-search">
            <Icon name="search" size={14} />
            <input type="search" aria-label="Search issues" placeholder="Search issues" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
        </div>
      )}

      {shown.kind === 'loading' && <IssueSkeleton />}

      {shown.kind === 'connect' && <ConnectLinear head={head} />}

      {offline && <FailedState icon="wifioff" title="You're offline">Issues show again when you're back online.</FailedState>}

      {!offline && shown.kind === 'rejected' && (
        <EmptyList icon="key" title="Sign in to Linear again" action={<Button variant="primary" onClick={openIntegrations}>Sign in to Linear</Button>}>Linear rejected Kernel's token. Your issues come back once you sign in.</EmptyList>
      )}

      {!offline && shown.kind === 'error' && <FailedState icon="wifioff" title="Issues didn't load" onRetry={() => load(true)}>Kernel will try again on its own. Your agents keep working in the meantime.</FailedState>}

      {ready && scope && flat.length === 0 && (() => {
        const d = describeFilter({ ...filter, query }, scope)
        const none = d.fits.length === 0
        // Mine is what narrows most often, so the way out names it: All shows every open issue the other filters leave.
        const showAll = filter.mine && !query.trim() && !filter.projectId && !filter.cycleId && (lists?.all.length ?? 0) > 0
        return (
          <EmptyList
            icon={showAll ? 'checkCircle' : none ? 'checkCircle' : 'question'}
            title={showAll ? 'Nothing assigned to you' : none ? 'No open issues' : 'No issues match these filters'}
            action={showAll ? <Button onClick={() => set({ mine: false })}>Show all issues</Button> : !none ? <><Button onClick={clear}>Clear filters</Button><Button variant="ghost" onClick={() => { setQuery(''); setFilter(fitFilter({ mine: false }, scope)) }}>Show all issues</Button></> : undefined}
          >
            {showAll ? `Issues assigned to you in Linear show up here, with the agents working on them.` : none ? `Nothing is open in ${d.where}.` : null}
          </EmptyList>
        )
      })()}

      {hidden && selId && <HiddenNote id={selId} fits={hiddenFits} onClear={() => { setQuery(''); if (scope) setFilter(clearedFilter(scope)) }} />}

      {ready && flat.length > 0 && (
        <div className="is-body">
          <div className="is-list" ref={listEl} aria-label="Issues" onKeyDown={keys.onKeyDown}>
            {groups.map((g) => {
              const key = groupKey(g)
              const open = !folded.has(key)
              return (
              <section key={key} aria-label={g.name}>
                <h3 className="is-group">
                  <button type="button" className="is-fold" aria-expanded={open} aria-label={`${g.name}, ${g.issues.length}`} onClick={() => fold(key)}>
                    <span className="is-chev" data-open={open}><Icon name="chevron" size={12} /></span>
                    <IssueState shape={stateShape(g.type)} size={13} /><span className="is-gname">{g.name}</span><span className="is-gn">{g.issues.length}</span>
                  </button>
                </h3>
                {open && <ul>
                  {g.issues.map((i) => {
                    const live = status.get(i.id)
                    return (
                      <li key={i.id} data-keep-id={i.id}>
                        <button type="button" {...keys.rowProps(i.id)} className="is-row" aria-current={i.id === selId ? 'true' : undefined} aria-selected={i.id === selId} onClick={() => setSel(i.id)}>
                          <IssueState shape={stateShape(i.state.type)} size={13} />
                          <span className="col grow">
                            <span className="is-title ellipsis">{i.title}</span>
                            <span className="is-sub">
                              <span className="mono">{i.id}</span>
                              {i.project && !oneProject && i.project.id !== filter.projectId && <><span aria-hidden="true" className="is-dot">·</span><span className="ellipsis" title={`Linear project: ${i.project.name}`}>{i.project.name}</span></>}
                            </span>
                          </span>
                          <span className="is-right">
                            {live ? <RowStatus who={live.who} state={live} /> : <span className="is-age" role="img" aria-label={ageTip(i.updatedAt)} data-tip={ageTip(i.updatedAt)}>{issueAge(i.updatedAt)}</span>}
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
            {!flat.some((i) => status.get(i.id)) && <p className="is-hint"><Icon name="info" size={12} />No agent works on these yet. Hand one to Kernel to start.</p>}
            {list.length >= 100 && <CapNote>Showing the 100 issues updated most recently. Narrow by Linear project, cycle or search to find the rest.</CapNote>}
          </div>
          <div className="is-pane" ref={detail}>
            {selId && <IssueDetail keep={keep} headProject={head.project} id={selId} summary={cur} tick={tick} onPlanned={() => { setTick((t) => t + 1); void load(true) }} />}
          </div>
        </div>
      )}
    </div>
  )
}
