import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GithubIssue, GitHubErrorKind, Project } from '@shared/types'
import { githubErrorKind } from '@shared/githubError'
import { call, cleanError } from '../../api'
import { getState, go, useStore } from '../../store'
import { readSavedJson, writeSavedJson } from '../../remember'
import { Button, EmptyList, FailedState, Icon, LinkButton, Pill, useListKeys } from '../../ui'
import { failToast, useRetryKey } from '../../retry'
import { IssueState } from '../../icons'
import { GhSignIn } from '../work/GhSignIn'
import { GithubDetail } from './GithubDetail'
import { spotKey, useKeptScroll } from '../../ui/keptScroll'
import { generation, getGithubList, getSelected, isFresh, setGithubList, setSelected } from './cache'
import {
  ageTip, byUpdated, DEFAULT_GITHUB_FILTER, githubFilterKey, parseGithubFilter, describeGithub, issueAge, joinFits, labelsOf, linkedWorkspaces, loginInitials, milestonesOf, narrowGithub, rowState,
  type GithubFilter
} from './model'
import { CapNote, FilterChip, githubProblem, HiddenNote, IssueSkeleton, type ProjectHead } from './parts'
import { useReveal } from './useReveal'
import { RowStatus, useReadPrs } from './WorkCard'
import { WorkHeader } from '../work/WorkHeader'
import { useOpenPrCount } from '../prs/model'
import './issues.css'

type Failure = { kind: 'error'; why: GitHubErrorKind; message: string }
type View = { kind: 'loading' } | Failure | { kind: 'ready' }

const OFFLINE: Failure = { kind: 'error', why: 'offline', message: '' }

/** What gh said, and the kind of failure it was. The engine's messages already say what to do. */
const failure = (e: unknown): Failure => ({ kind: 'error', why: githubErrorKind(e) ?? 'other', message: cleanError(e) })

/**
 * IssuesGitHub.png: a GitHub project's open issues in a list, the selected one on the right. It is Linear's page with GitHub's fields,
 * and one group, Open, because an issue is open or closed (KERNEL-438). The route's `issueId` opens with that issue selected. Each project
 * mounts its own, so nothing here carries over from the project before.
 */
export function GithubIssues({ project, where, issueId, head }: { project: Project; where?: string; issueId?: string; head: ProjectHead }) {
  const prCount = useOpenPrCount()
  const online = useStore((s) => s.system.online)
  const workspaces = useStore((s) => s.workspaces)
  const agents = useStore((s) => s.agents)
  const chats = useStore((s) => s.chats)
  const running = useStore((s) => s.running)
  const prs = useStore((s) => s.prs)
  const approvals = useStore((s) => s.approvals)
  const [seed] = useState(() => {
    const hit = getGithubList(project.id)
    const last = getSelected(`github|${project.id}`)
    return { issues: hit?.value ?? null, fresh: !!hit && isFresh(hit.at), sel: hit && last && hit.value.some((i) => i.id === last) ? last : undefined }
  })
  const [view, setView] = useState<View>(seed.issues ? { kind: 'ready' } : { kind: 'loading' })
  const [issues, setIssues] = useState<GithubIssue[]>(seed.issues ?? [])
  const [filter, setFilter] = useState<GithubFilter>(() => readSavedJson(githubFilterKey(project.id), parseGithubFilter))
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState<string | undefined>(issueId ?? seed.sel)
  const [tick, setTick] = useState(0)
  const [refreshing, setRefreshing] = useState(!!seed.issues && !seed.fresh)
  const detail = useRef<HTMLDivElement>(null)

  // The newest load wins, so a slow answer for an old search can't replace a newer list.
  const seq = useRef(0)
  const loadedQuery = useRef<string | null>(seed.issues ? '' : null)
  const hasRows = useRef(!!seed.issues)
  const queryNow = useRef(query)
  queryNow.current = query

  const load = useCallback(async () => {
    const n = ++seq.current
    const q = queryNow.current.trim()
    const gen = generation()
    try {
      const rows = await call('github.issueList', { projectId: project.id, query: q || undefined })
      if (!q) setGithubList(project.id, rows, gen)
      if (n !== seq.current) return
      loadedQuery.current = q
      hasRows.current = true
      setIssues(rows)
      setView({ kind: 'ready' })
    } catch (e) {
      if (n !== seq.current) return
      const f = failure(e)
      const p = githubProblem(f.why, f.message, where ?? 'this repo')
      // The toast carries the error and its Try again. Signed out, a gone repo and offline say it on the page, so they raise none (Pen 11.15).
      if (p.toast && getState().system.online) failToast(hasRows.current ? "Couldn't refresh GitHub issues" : p.toast, p.toastSub, 'githubIssues')
      if (hasRows.current && f.why !== 'signed-out' && f.why !== 'not-found') return
      hasRows.current = false
      setView(f)
    }
  }, [project.id, where])

  // Read when the page opens, when the window gets focus while it shows, when the connection comes back and on Refresh. No interval. Another project is another mount.
  useEffect(() => {
    if (seed.issues && seed.fresh) return
    if (seed.issues) void load().finally(() => setRefreshing(false))
    else void load()
  }, [load])
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
  const picked = sel !== undefined && (sel === issueId || flat.some((i) => i.id === sel))
  const selId = picked ? sel : flat[0]?.id
  const cur = flat.find((i) => i.id === selId)
  useEffect(() => {
    if (!selId) return
    if (selId !== sel) setSel(selId)
    setSelected(`github|${project.id}`, selId)
  }, [selId, sel, project.id])
  const count = (n: number) => (n >= 100 ? '100+' : String(n))

  const projectWorkspaces = useMemo(() => workspaces.filter((w) => w.projectId === project.id), [workspaces, project.id])
  const rowLinked = useMemo(() => flat.flatMap((i) => linkedWorkspaces(i.id, projectWorkspaces)), [flat, projectWorkspaces])
  useReadPrs(rowLinked)
  const status = useMemo(() => {
    const runningOf = (w: { id: string }) => (chats[w.id] ?? []).some((c) => running[c.id])
    const waitingOf = (w: { id: string }) => approvals.some((a) => a.status === 'pending' && a.workspaceId === w.id)
    return new Map(flat.map((i) => [i.id, rowState(linkedWorkspaces(i.id, projectWorkspaces), agents, runningOf, prs, waitingOf)]))
  }, [flat, projectWorkspaces, agents, chats, running, prs, approvals])

  const keys = useListKeys({
    ids: useMemo(() => flat.map((i) => i.id), [flat]),
    rowId: (id) => `is-${id}`,
    current: selId,
    onCurrent: setSel,
    blocked: () => !!getState().ui.modal,
    onOpen: (id) => {
      setSel(id)
      detail.current?.querySelector<HTMLElement>('.is-actions a, .is-actions button')?.focus()
    },
  })

  const offline = !online && view.kind === 'error'
  const shown: View = view
  const ready = shown.kind === 'ready'
  useRetryKey('githubIssues', load)
  const listEl = useRef<HTMLDivElement>(null)
  const keep = spotKey.issues(project.id)
  const kept = useKeptScroll(listEl, { key: keep, ready: ready && flat.length > 0 })
  useReveal(listEl, selId, ready && flat.length > 0, 0, kept.stop)
  const hidden = ready && !!selId && !cur && flat.length > 0
  // The project's filter is kept when you leave Issues and come back (DESIGN.md, Remembered choices).
  useEffect(() => { writeSavedJson(githubFilterKey(project.id), filter) }, [project.id, filter])
  const set = (patch: Partial<GithubFilter>) => setFilter((f) => ({ ...f, ...patch }))

  const clear = () => { setQuery(''); setFilter({ ...DEFAULT_GITHUB_FILTER }) }
  const bar = ready || (shown.kind === 'error' && shown.why !== 'signed-out' && shown.why !== 'not-found')
  const milestones = milestonesOf(issues, filter.milestone)

  return (
    <div className="panel">
      <WorkHeader tab="issues" head={head} counts={{ issues: ready ? count(narrowed.length) : undefined, prs: prCount }} onRefresh={refresh} refreshing={refreshing} />

      {bar && (
        <div className="is-bar">
          <div role="group" aria-label="Whose issues" className="is-pills">
            <Pill pressed={filter.mine} onClick={() => set({ mine: true })}>Mine<span className="is-n">{ready ? count(mineCount) : ''}</span></Pill>
            <Pill pressed={!filter.mine} onClick={() => set({ mine: false })}>All<span className="is-n">{ready ? count(narrowed.length) : ''}</span></Pill>
          </div>
          <span className="is-sep" aria-hidden="true" />
          {where && <FilterChip label="Repo" value={where} options={[{ value: where, label: where }]} onChange={() => undefined} />}
          <FilterChip label="Label" value={filter.label ?? ''} options={[{ value: '', label: 'Any' }, ...labelsOf(issues, filter.label).map((l) => ({ value: l, label: l }))]} onChange={(v) => set({ label: v || undefined })} />
          {milestones.length > 0 && <FilterChip label="Milestone" value={filter.milestone ?? ''} options={[{ value: '', label: 'Any' }, ...milestones.map((m) => ({ value: m, label: m }))]} onChange={(v) => set({ milestone: v || undefined })} />}
          <span className="grow" />
          {(filter.label || filter.milestone || query.trim() !== '') && <LinkButton variant="action" size="meta" onClick={clear}>Clear filters</LinkButton>}
          <span className="is-search">
            <Icon name="search" size={14} />
            <input type="search" aria-label="Search issues" placeholder="Search issues" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
        </div>
      )}

      {shown.kind === 'loading' && <IssueSkeleton what="GitHub issues" />}

      {shown.kind === 'error' && (() => {
        const p = githubProblem(shown.why, shown.message, where ?? 'this repo')
        if (shown.why === 'signed-out') return <GhSignIn what="issues" busy={refreshing} onCheck={refresh} />
        if (shown.why === 'not-found') return <FailedState icon={p.icon} title={p.title} action={<Button onClick={() => go({ name: 'settings', page: 'project', projectId: project.id, section: 'git' })}>Open Settings, Git</Button>}>{p.sub}</FailedState>
        if (offline || shown.why === 'offline') return <FailedState icon={p.icon} title={p.title}>{p.sub}</FailedState>
        if (shown.why === 'rate-limited') return <FailedState icon={p.icon} title={p.title}>{p.sub}</FailedState>
        return <FailedState icon={p.icon} title={p.title} onRetry={load}>{p.sub}</FailedState>
      })()}

      {ready && flat.length === 0 && (() => {
        const d = describeGithub(filter, query, where ?? 'this repo')
        const none = d.fits.length === 0
        const showAll = filter.mine && !filter.label && !filter.milestone && !query.trim() && issues.length > 0
        return (
          <EmptyList
            icon={none || showAll ? 'checkCircle' : 'question'}
            title={showAll ? 'Nothing assigned to you' : none ? 'No open issues' : 'No issues match these filters'}
            action={showAll ? <Button onClick={() => setFilter({ ...filter, mine: false })}>Show all issues</Button> : !none ? <><Button onClick={clear}>Clear filters</Button><Button variant="ghost" onClick={() => { setQuery(''); setFilter({ ...DEFAULT_GITHUB_FILTER }) }}>Show all issues</Button></> : undefined}
          >
            {showAll ? 'Issues assigned to you on GitHub show up here, with the agents working on them.' : none ? `${d.where} has no open issues on GitHub.` : null}
          </EmptyList>
        )
      })()}

      {hidden && selId && <HiddenNote id={selId} fits={describeGithub(filter, query, where ?? 'this repo').fits} onClear={() => { setQuery(''); setFilter(DEFAULT_GITHUB_FILTER) }} />}

      {ready && flat.length > 0 && (
        <div className="is-body">
          <div className="is-list" ref={listEl} aria-label="Issues" onKeyDown={keys.onKeyDown}>
            <section aria-label="Open">
              <h3 className="is-group is-group-plain"><IssueState shape="todo" size={13} /><span className="is-gname">Open</span><span className="is-gn">{flat.length}</span></h3>
              <ul>
                {flat.map((i) => {
                  const live = status.get(i.id)
                  const who = i.assignees[0]
                  return (
                    <li key={i.id} data-keep-id={i.id}>
                      <button type="button" {...keys.rowProps(i.id)} className="is-row" aria-current={i.id === selId ? 'true' : undefined} aria-selected={i.id === selId} onClick={() => setSel(i.id)}>
                        <IssueState shape="todo" size={13} />
                        <span className="col grow">
                          <span className="is-title ellipsis">{i.title}</span>
                          <span className="is-sub"><span className="mono">{i.id}</span>{where && <><span aria-hidden="true" className="is-dot">·</span><span className="mono ellipsis">{where}</span></>}</span>
                        </span>
                        <span className="is-right">
                          {!filter.mine && (who
                            ? <span className="is-av is-av-row" role="img" aria-label={`Assigned to ${i.assignees.join(', ')}`}>{loginInitials(who)}</span>
                            : <span className="is-av-none" role="img" aria-label="Unassigned" />)}
                          {live ? <RowStatus who={live.who} state={live} /> : <span className="is-age" role="img" aria-label={ageTip(i.updatedAt)} data-tip={ageTip(i.updatedAt)}>{issueAge(i.updatedAt)}</span>}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
            {!flat.some((i) => status.get(i.id)) && <p className="is-hint"><Icon name="info" size={12} />No agent works on these yet. Hand one to Kernel to start.</p>}
            {issues.length >= 100 && <CapNote>Showing the newest 100. <LinkButton variant="inline" size="meta" onClick={() => void call('system.openExternal', { url: `https://github.com/${where ?? ''}/issues` })}>See the rest on GitHub<Icon name="ext" size={12} /></LinkButton></CapNote>}
          </div>
          <div className="is-pane" ref={detail}>
            {selId && <GithubDetail keep={keep} project={project} id={selId} summary={cur} tick={tick} />}
          </div>
        </div>
      )}
    </div>
  )
}
