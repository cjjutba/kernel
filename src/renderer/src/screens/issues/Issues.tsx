import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LinearIssue, LinearScope } from '@shared/types'
import { call } from '../../api'
import { go, useStore } from '../../store'
import { Banner, Button, Icon, IconButton, Pill, Spinner } from '../../ui'
import { IssuePriority, IssueState } from '../../icons'
import { SidebarToggle } from '../../components/PanelToggles'
import { IssueDetail } from './IssueDetail'
import {
  cyclesFor, cycleLabel, describeFilter, DEFAULT_FILTER, fitFilter, FILTER_KEY, flatIssues, groupIssues, initials, issueAge, joinFits, linkedWorkspaces,
  parseFilter, projectsFor, rowStatus, serializeFilter, stateShape, workspaceSlug, type SavedFilter
} from './model'
import './issues.css'

/** Where the failure came from decides the words: a rejected token needs reconnecting, anything else is worth trying again. */
type View = { kind: 'loading' } | { kind: 'connect' } | { kind: 'error'; title: string; sub: string } | { kind: 'ready' }

const UNREACHABLE: View = { kind: 'error', title: "Can't reach Linear", sub: 'Check your connection, then try again.' }

function failure(e: unknown): View {
  const message = e instanceof Error ? e.message : String(e)
  if (/^Connect Linear/i.test(message)) return { kind: 'connect' }
  if (/rejected the token/i.test(message)) return { kind: 'error', title: 'Linear rejected the token', sub: 'Reconnect it in Settings, Integrations, then try again.' }
  if (/could not reach/i.test(message)) return UNREACHABLE
  return { kind: 'error', title: "Can't load issues", sub: message }
}

function readSaved(): SavedFilter {
  try { return parseFilter(localStorage.getItem(FILTER_KEY)) } catch { return { ...DEFAULT_FILTER } }
}

/** The name of the Linear workspace, kept from the last time an issue came back, so the header can still say it while Linear is down. */
let knownSlug: string | undefined

type Option = { value: string; label: string }

/** A filter as a chip: its name, its value and a chevron, with a real select laid over it so the keyboard and screen readers work. */
function FilterChip({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  const shown = options.find((o) => o.value === value)?.label ?? options[0]?.label ?? ''
  return (
    <span className="is-chip">
      <span className="muted">{label}</span>
      <span>{shown}</span>
      <Icon name="chevron" size={10} stroke={1.9} />
      <select aria-label={`${label}: ${shown}`} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  )
}

const typing = (t: HTMLElement | null) => !!t?.closest('input, textarea, select, [contenteditable="true"]')

/** Issues.png and its states: your open Linear issues in a list, the selected one on the right (KERNEL-160). The route's `issueId` opens with that issue selected. */
export function Issues({ issueId }: { issueId?: string }) {
  const online = useStore((s) => s.system.online)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const chats = useStore((s) => s.chats)
  const running = useStore((s) => s.running)
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [scope, setScope] = useState<LinearScope | null>(null)
  const [filter, setFilter] = useState<SavedFilter>(readSaved)
  const [query, setQuery] = useState('')
  const [lists, setLists] = useState<{ mine: LinearIssue[]; all: LinearIssue[] } | null>(null)
  const [slug, setSlug] = useState(knownSlug)
  const [sel, setSel] = useState<string | undefined>(issueId)
  const [tick, setTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const detail = useRef<HTMLDivElement>(null)

  // The newest load wins, so a slow answer for an old filter can't replace a newer list.
  const seq = useRef(0)
  const scopeRef = useRef<LinearScope | null>(null)
  const loadedKey = useRef('')
  const now = useRef({ filter, query })
  now.current = { filter, query }

  const load = useCallback(async (full: boolean) => {
    const n = ++seq.current
    const stale = () => n !== seq.current
    try {
      let sc = scopeRef.current
      let f = now.current.filter
      if (full || !sc) {
        const rows = await call('integrations.list', undefined)
        if (stale()) return
        if (!rows.find((r) => r.id === 'linear')?.connected) return setView({ kind: 'connect' })
        sc = await call('linear.scope', undefined)
        if (stale()) return
        scopeRef.current = sc
        setScope(sc)
        f = fitFilter(f, sc)
        if (serializeFilter(f) !== serializeFilter(now.current.filter)) setFilter(f)
      }
      const q = now.current.query.trim() || undefined
      const base = { teamId: f.teamId, projectId: f.projectId, cycleId: f.cycleId, query: q }
      const [mine, all] = await Promise.all([call('linear.issues', { filter: { ...base, mine: true } }), call('linear.issues', { filter: { ...base, mine: false } })])
      if (stale()) return
      loadedKey.current = `${serializeFilter(f)}|${now.current.query}`
      const name = workspaceSlug((all[0] ?? mine[0])?.url)
      if (name) { knownSlug = name; setSlug(name) }
      setLists({ mine, all })
      setView({ kind: 'ready' })
    } catch (e) {
      if (!stale()) setView(failure(e))
    }
  }, [])

  // Refreshed when the screen opens, when the window gets focus while it shows, when the connection comes back and on Refresh. No interval.
  useEffect(() => { void load(true) }, [load])
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
    try { localStorage.setItem(FILTER_KEY, serializeFilter(filter)) } catch { /* not remembered */ }
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
  const selId = sel ?? flat[0]?.id
  const cur = flat.find((i) => i.id === selId)
  // One row is in the tab order, the selected one, or the first when the selected issue is filtered out.
  const tabbable = cur?.id ?? flat[0]?.id

  const status = useMemo(() => {
    const runningOf = (w: { id: string }) => (chats[w.id] ?? []).some((c) => running[c.id])
    return new Map(flat.map((i) => [i.id, rowStatus(linkedWorkspaces(i.id, workspaces), agents, runningOf)]))
  }, [flat, workspaces, agents, chats, running])

  // Up and down move through the list, Enter hands focus to the issue's buttons. Typing in a field is left alone.
  const keys = useRef({ flat, selId })
  keys.current = { flat, selId }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || typing(t)) return
      const { flat, selId } = keys.current
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!flat.length) return
        e.preventDefault()
        const at = flat.findIndex((i) => i.id === selId)
        const next = flat[Math.max(0, Math.min(flat.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]
        setSel(next.id)
        const row = document.getElementById(`is-${next.id}`)
        row?.focus()
        row?.scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' && t?.closest('.is-list')) {
        const id = t.closest('.is-row')?.id.replace(/^is-/, '')
        if (id) setSel(id)
        e.preventDefault()
        detail.current?.querySelector<HTMLElement>('.is-actions a, .is-actions button')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const shown: View = !online && (view.kind === 'ready' || view.kind === 'error') ? UNREACHABLE : view
  const ready = shown.kind === 'ready' && scope
  const set = (patch: Partial<SavedFilter>) => setFilter((f) => (scope ? fitFilter({ ...f, ...patch }, scope) : { ...f, ...patch }))
  const count = (n: number | undefined) => (n === undefined ? '' : n >= 100 ? '100+' : String(n))

  return (
    <div className="panel">
      <header className="header is-head">
        <SidebarToggle />
        <Icon name="issues" />
        <h1>Issues</h1>
        <span className="grow" />
        {(shown.kind === 'ready' || shown.kind === 'error') && <span className="is-where muted">Linear{slug ? ` · ${slug}` : ''}</span>}
      </header>

      {ready && scope && (
        <div className="is-bar">
          <div role="group" aria-label="Whose issues" className="is-pills">
            <Pill pressed={filter.mine} onClick={() => set({ mine: true })}>Mine<span className="is-n">{count(lists?.mine.length)}</span></Pill>
            <Pill pressed={!filter.mine} onClick={() => set({ mine: false })}>All<span className="is-n">{count(lists?.all.length)}</span></Pill>
          </div>
          <span className="is-sep" aria-hidden="true" />
          {scope.teams.length > 1 && <FilterChip label="Team" value={filter.teamId ?? ''} options={[{ value: '', label: 'All' }, ...scope.teams.map((t) => ({ value: t.id, label: t.key }))]} onChange={(v) => set({ teamId: v || undefined })} />}
          {scope.teams.length === 1 && <FilterChip label="Team" value={scope.teams[0].id} options={[{ value: scope.teams[0].id, label: scope.teams[0].key }]} onChange={() => undefined} />}
          <FilterChip label="Project" value={filter.projectId ?? ''} options={[{ value: '', label: 'All' }, ...projectsFor(scope, filter.teamId).map((p) => ({ value: p.id, label: p.name }))]} onChange={(v) => set({ projectId: v || undefined })} />
          <FilterChip label="Cycle" value={filter.cycleId ?? ''} options={[{ value: '', label: 'All' }, ...cyclesFor(scope, filter.teamId).map((c) => ({ value: c.id, label: cycleLabel(c, scope, filter.teamId) }))]} onChange={(v) => set({ cycleId: v || undefined })} />
          <span className="grow" />
          <span className="is-search">
            <Icon name="search" size={14} />
            <input type="search" aria-label="Search issues" placeholder="Search issues" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
          <IconButton icon="refresh" size={15} label="Refresh issues" busy={refreshing} busyLabel="Refreshing issues" onClick={refresh} />
        </div>
      )}

      {shown.kind === 'loading' && <div className="is-center"><Spinner label="Loading issues" /></div>}

      {shown.kind === 'connect' && (
        <div className="is-center is-state">
          <h2>Connect Linear</h2>
          <p>See the issues assigned to you, plan them with Rowan and start a chat from any of them.</p>
          <Button variant="primary" size="lg" onClick={() => go({ name: 'settings', page: 'integrations' })}>Open Settings, Integrations</Button>
        </div>
      )}

      {shown.kind === 'error' && (
        <div className="is-center">
          <div className="is-fail">
            <Banner kind={shown.title.includes('rejected') ? 'auth' : 'offline'} title={shown.title} actions={<Button size="md" busy={refreshing} busyLabel="Trying" onClick={refresh}>Try again</Button>}>{shown.sub}</Banner>
          </div>
        </div>
      )}

      {ready && scope && flat.length === 0 && (() => {
        const d = describeFilter({ ...filter, query }, scope)
        const none = d.fits.length === 0
        return (
          <div className="is-center is-state">
            <h2>{none ? 'No open issues' : 'No issues match'}</h2>
            <p>{none ? `Nothing is open in ${d.where}.` : `Nothing in ${d.where} fits ${joinFits(d.fits)}. ${filter.mine ? 'Try All instead of Mine, or clear the filters.' : 'Try clearing the filters.'}`}</p>
            {!none && <Button size="lg" onClick={() => { setQuery(''); set({ projectId: undefined, cycleId: undefined }) }}>Clear filters</Button>}
          </div>
        )
      })()}

      {ready && flat.length > 0 && (
        <div className="is-body">
          <div className="is-list" aria-label="Issues">
            {groups.map((g) => (
              <section key={`${g.type}:${g.name}`} aria-label={g.name}>
                <h3 className="is-group"><span className="is-slot"><IssueState shape={stateShape(g.type)} /></span><span>{g.name}</span><span className="muted">{g.issues.length}</span></h3>
                <ul>
                  {g.issues.map((i) => {
                    const live = status.get(i.id)
                    return (
                      <li key={i.id}>
                        <button type="button" id={`is-${i.id}`} className="is-row" aria-current={i.id === selId ? 'true' : undefined} tabIndex={i.id === tabbable ? 0 : -1} onClick={() => setSel(i.id)}>
                          <span className="is-slot"><IssueState shape={stateShape(i.state.type)} /></span>
                          <span className="col grow">
                            <span className="is-title ellipsis">{i.title}</span>
                            <span className="is-sub">
                              <IssuePriority priority={i.priority} size={14} />
                              <span className="mono">{i.id}</span>
                              {i.project && <span className="ellipsis">{i.project.name}</span>}
                            </span>
                          </span>
                          <span className="is-right" data-live={live ? 'true' : undefined}>
                            {live ?? issueAge(i.updatedAt)}
                            {!filter.mine && i.assignee && <span className="is-av" role="img" aria-label={`Assigned to ${i.assignee.name}`}>{initials(i.assignee.name)}</span>}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
          <div className="is-pane" ref={detail}>
            {selId && <IssueDetail id={selId} summary={cur} tick={tick} onPlanned={() => { setTick((t) => t + 1); void load(true) }} />}
          </div>
        </div>
      )}
    </div>
  )
}
