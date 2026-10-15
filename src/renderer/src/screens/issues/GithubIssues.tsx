import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { GithubIssue, GitHubErrorKind, Room } from '@shared/types'
import { githubErrorKind } from '@shared/githubError'
import { call, cleanError } from '../../api'
import { getState, useStore } from '../../store'
import { readSavedJson, writeSavedJson } from '../../remember'
import { Button, EmptyList, FailedState, Icon, IconButton, Pill, Spinner } from '../../ui'
import { IssueState } from '../../icons'
import { GithubDetail } from './GithubDetail'
import {
  byUpdated, DEFAULT_GITHUB_FILTER, githubFilterKey, parseGithubFilter, describeGithub, issueAge, joinFits, labelsOf, linkedWorkspaces, loginInitials, milestonesOf, narrowGithub, rowLabels, rowStatus,
  type GithubFilter
} from './model'
import { CapNote, chooseTracker, FilterChip, githubProblem, IssuesHeader, RefreshNotice, typing, type RoomHead } from './parts'
import './issues.css'

type Failure = { kind: 'error'; why: GitHubErrorKind; message: string }
type View = { kind: 'loading' } | Failure | { kind: 'ready' }

const UNREACHABLE: Failure = { kind: 'error', why: 'offline', message: '' }

/** What gh said, and the kind of failure it was. The engine's messages already say what to do. */
const failure = (e: unknown): Failure => ({ kind: 'error', why: githubErrorKind(e) ?? 'other', message: cleanError(e) })

/**
 * IssuesGitHub.png: a GitHub room's open issues in a list, the selected one on the right. It is Linear's page with GitHub's fields,
 * and one group, Open, because an issue is open or closed (KERNEL-438). The route's `issueId` opens with that issue selected. Each room
 * mounts its own, so nothing here carries over from the room before.
 */
export function GithubIssues({ room, where, issueId, head }: { room: Room; where?: string; issueId?: string; head: RoomHead }) {
  const online = useStore((s) => s.system.online)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const chats = useStore((s) => s.chats)
  const running = useStore((s) => s.running)
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [problem, setProblem] = useState<Failure | null>(null)
  const [issues, setIssues] = useState<GithubIssue[]>([])
  const [filter, setFilter] = useState<GithubFilter>(() => readSavedJson(githubFilterKey(room.id), parseGithubFilter))
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState<string | undefined>(issueId)
  const [tick, setTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const detail = useRef<HTMLDivElement>(null)

  // The newest load wins, so a slow answer for an old search can't replace a newer list.
  const seq = useRef(0)
  const loadedQuery = useRef<string | null>(null)
  const hasRows = useRef(false)
  const queryNow = useRef(query)
  queryNow.current = query

  const load = useCallback(async () => {
    const n = ++seq.current
    const q = queryNow.current.trim()
    try {
      const rows = await call('github.issueList', { roomId: room.id, query: q || undefined })
      if (n !== seq.current) return
      loadedQuery.current = q
      hasRows.current = true
      setIssues(rows)
      setProblem(null)
      setView({ kind: 'ready' })
    } catch (e) {
      if (n !== seq.current) return
      if (hasRows.current) setProblem(failure(e))
      else setView(failure(e))
    }
  }, [room.id])

  // Read when the page opens, when the window gets focus while it shows, when the connection comes back and on Refresh. No interval. Another room is another mount.
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const focus = () => { setTick((t) => t + 1); void load() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [load])
  const wasOnline = useRef(online)
  useEffect(() => {
    if (online && !wasOnline.current) { setTick((t) => t + 1); void load() }
    wasOnline.current = online
  }, [online, load])

  // A new search reads the list again, after a pause for the typing. The first load already read the empty one.
  useEffect(() => {
    if (loadedQuery.current === null || loadedQuery.current === query.trim()) return
    const t = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(t)
  }, [query, load])

  const refresh = () => {
    setRefreshing(true)
    setTick((t) => t + 1)
    void load().finally(() => setRefreshing(false))
  }

  useEffect(() => { if (issueId) setSel(issueId) }, [issueId])

  const narrowed = useMemo(() => narrowGithub(issues, filter), [issues, filter])
  const mineCount = narrowed.filter((i) => i.mine).length
  const flat = useMemo(() => byUpdated(filter.mine ? narrowed.filter((i) => i.mine) : narrowed), [narrowed, filter.mine])
  const selId = sel ?? flat[0]?.id
  const cur = flat.find((i) => i.id === selId)
  // One row is in the tab order, the selected one, or the first when the selected issue is filtered out.
  const tabbable = cur?.id ?? flat[0]?.id
  const count = (n: number) => (n >= 100 ? '100+' : String(n))

  const roomWorkspaces = useMemo(() => workspaces.filter((w) => w.roomId === room.id), [workspaces, room.id])
  const status = useMemo(() => {
    const runningOf = (w: { id: string }) => (chats[w.id] ?? []).some((c) => running[c.id])
    return new Map(flat.map((i) => [i.id, rowStatus(linkedWorkspaces(i.id, roomWorkspaces), agents, runningOf)]))
  }, [flat, roomWorkspaces, agents, chats, running])

  // Up and down move through the list, Enter hands focus to the issue's buttons. It listens on the list, so a modal or a field elsewhere never moves the selection.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || typing(e.target as HTMLElement) || getState().ui.modal) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!flat.length) return
      e.preventDefault()
      const at = flat.findIndex((i) => i.id === selId)
      const next = flat[Math.max(0, Math.min(flat.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]
      setSel(next.id)
      const row = document.getElementById(`is-${next.id}`)
      row?.focus()
      row?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      const id = (e.target as HTMLElement).closest('.is-row')?.id.replace(/^is-/, '')
      if (id) setSel(id)
      e.preventDefault()
      detail.current?.querySelector<HTMLElement>('.is-actions a, .is-actions button')?.focus()
    }
  }

  const failed: Failure | null = view.kind === 'ready' ? (!online ? UNREACHABLE : problem) : null
  const shown: View = !online && view.kind === 'error' ? UNREACHABLE : view
  const ready = shown.kind === 'ready'
  // The room's filter is kept when you leave Issues and come back (DESIGN.md, Remembered choices).
  useEffect(() => { writeSavedJson(githubFilterKey(room.id), filter) }, [room.id, filter])
  const set = (patch: Partial<GithubFilter>) => setFilter((f) => ({ ...f, ...patch }))

  return (
    <div className="panel">
      <IssuesHeader head={head} where={shown.kind === 'loading' ? undefined : `GitHub${where ? ` · ${where}` : ''}`} />

      {ready && (
        <div className="is-bar">
          <div role="group" aria-label="Whose issues" className="is-pills">
            <Pill pressed={filter.mine} onClick={() => set({ mine: true })}>Mine<span className="is-n">{count(mineCount)}</span></Pill>
            <Pill pressed={!filter.mine} onClick={() => set({ mine: false })}>All<span className="is-n">{count(narrowed.length)}</span></Pill>
          </div>
          <span className="is-sep" aria-hidden="true" />
          <FilterChip label="Label" value={filter.label ?? ''} options={[{ value: '', label: 'All' }, ...labelsOf(issues, filter.label).map((l) => ({ value: l, label: l }))]} onChange={(v) => set({ label: v || undefined })} />
          <FilterChip label="Milestone" value={filter.milestone ?? ''} options={[{ value: '', label: 'All' }, ...milestonesOf(issues, filter.milestone).map((m) => ({ value: m, label: m }))]} onChange={(v) => set({ milestone: v || undefined })} />
          <span className="grow" />
          <span className="is-search">
            <Icon name="search" size={14} />
            <input type="search" aria-label="Search issues" placeholder="Search issues" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
          <IconButton icon="refresh" size={16} label="Refresh issues" busy={refreshing} busyPattern="rotate" busyLabel="Refreshing issues" onClick={refresh} />
        </div>
      )}

      {shown.kind === 'loading' && <div className="is-center is-loading" role="status"><Spinner label={null} pattern="arrow-down" />Loading issues</div>}

      {shown.kind === 'error' && (() => {
        const p = githubProblem(shown.why, shown.message, where ?? 'this repo')
        if (shown.why === 'signed-out') return <EmptyList icon="key" title={p.title} action={<Button busy={refreshing} busyPattern="rotate" busyLabel="Trying" onClick={refresh}>Try again</Button>}>{p.sub}</EmptyList>
        if (shown.why === 'not-found') return <EmptyList icon="warning" title={p.title} action={<Button onClick={() => chooseTracker(room.id)}>Open room settings</Button>}>{p.sub}</EmptyList>
        return <FailedState title={p.title} onRetry={load}>{p.sub}</FailedState>
      })()}

      {ready && failed && (() => {
        const p = githubProblem(failed.why, failed.message, where ?? 'this repo')
        const action = failed.why === 'not-found'
          ? <Button size="md" onClick={() => chooseTracker(room.id)}>Open room settings</Button>
          : <Button size="md" busy={refreshing} busyPattern="rotate" busyLabel="Trying" onClick={refresh}>Try again</Button>
        return <RefreshNotice kind={p.banner} title={p.title} action={action}>{`${p.sub} The issues below are from the last time they loaded.`}</RefreshNotice>
      })()}

      {ready && flat.length === 0 && (() => {
        const d = describeGithub(filter, query, where ?? 'this repo')
        const none = d.fits.length === 0
        return (
          <div className="is-center is-state">
            <h2>{none ? 'No open issues' : 'No issues match'}</h2>
            <p>{none ? `Nothing is open in ${d.where}.` : `Nothing in ${d.where} fits ${joinFits(d.fits)}. ${filter.mine ? 'Try All instead of Mine, or clear the filters.' : 'Try clearing the filters.'}`}</p>
            {!none && <Button size="lg" onClick={() => { setQuery(''); setFilter(DEFAULT_GITHUB_FILTER) }}>Clear filters</Button>}
          </div>
        )
      })()}

      {ready && flat.length > 0 && (
        <div className="is-body">
          <div className="is-list" aria-label="Issues" onKeyDown={onListKey}>
            <section aria-label="Open">
              <h3 className="is-group"><span className="is-slot"><IssueState shape="todo" /></span><span>Open</span><span className="muted">{flat.length}</span></h3>
              <ul>
                {flat.map((i) => {
                  const live = status.get(i.id)
                  const labels = rowLabels(i.labels)
                  const who = i.assignees[0]
                  return (
                    <li key={i.id}>
                      <button type="button" id={`is-${i.id}`} className="is-row" aria-current={i.id === selId ? 'true' : undefined} tabIndex={i.id === tabbable ? 0 : -1} onClick={() => setSel(i.id)}>
                        <span className="is-slot"><IssueState shape="todo" /></span>
                        <span className="col grow">
                          <span className="is-title ellipsis">{i.title}</span>
                          <span className="is-sub">
                            <span className="mono">{i.id}</span>
                            {labels.shown.map((l) => <span key={l} className="is-pill-sm">{l}</span>)}
                            {labels.more && <span className="is-more">{labels.more}</span>}
                          </span>
                        </span>
                        <span className="is-right" data-live={live ? 'true' : undefined}>
                          {!filter.mine && (who
                            ? <span className="is-av is-av-row" role="img" aria-label={`Assigned to ${i.assignees.join(', ')}`}>{loginInitials(who)}</span>
                            : <span className="is-av-none" role="img" aria-label="Unassigned" />)}
                          <span className="is-age">{live ?? issueAge(i.updatedAt)}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
            {issues.length >= 100 && <CapNote>Showing the 100 issues updated most recently. Search or filter to find the rest.</CapNote>}
          </div>
          <div className="is-pane" ref={detail}>
            {selId && <GithubDetail room={room} id={selId} summary={cur} tick={tick} />}
          </div>
        </div>
      )}
    </div>
  )
}
