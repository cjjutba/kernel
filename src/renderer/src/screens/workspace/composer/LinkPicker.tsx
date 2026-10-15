import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ChatPart, IssueSummary, PrSummary, Workspace } from '@shared/types'
import { call, cleanError } from '../../../api'
import { useStore } from '../../../store'
import { oneOf, useRemembered } from '../../../remember'
import { Button, Icon, Tabs } from '../../../ui'
import { useLayer } from '../../../ui/hooks'
import { chooseTracker } from '../../issues/parts'
import { useProjectTracker } from '../../issues/useProjectTracker'

// + > Link issue, Link pull request and Link workspaces (D-093, KERNEL-786). Each adds chips the agent reads as a line of context.

type Source = 'linear' | 'github'
type Load = { state: 'loading' } | { state: 'ready'; rows: IssueSummary[] } | { state: 'error'; message: string }

const SOURCES = [{ id: 'linear', label: 'Linear' }, { id: 'github', label: 'GitHub' }]
const SOURCE_NAME: Record<Source, string> = { linear: 'Linear', github: 'GitHub' }
const TAB_KEY = 'kernel.issueSource'

/** The shell both pickers share: a search field over a list, anchored above the composer's + button. */
function Panel({ label, query, onQuery, placeholder, onKey, anchorRef, onClose, children, style }: { label: string; query: string; onQuery: (q: string) => void; placeholder: string; onKey: (e: React.KeyboardEvent) => void; anchorRef: React.RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ onEscape: onClose, onOutside: onClose, ref, anchorRef })
  useEffect(() => { ref.current?.querySelector('input')?.focus() }, [])
  useEffect(() => { ref.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' }) })
  return (
    <div ref={ref} role="dialog" aria-label={label} className="menu link-pop" style={style} onKeyDown={onKey}>
      <label className="pick-search">
        <Icon name="search" size={14} />
        <input aria-label={placeholder} placeholder={placeholder} autoComplete="off" spellCheck={false} value={query} onChange={(e) => onQuery(e.target.value)} />
      </label>
      {children}
    </div>
  )
}

/**
 * The project's issues: its tracker's (Linear with the token in Settings, Integrations, or GitHub Issues through gh). A Linear project can
 * also link one of its repo's GitHub issues, so it keeps the second tab. A project with no tracker says so. The stored tab only ever
 * applies to a Linear project. Enter links the active one.
 */
export function IssuePicker({ projectId, anchorRef, onPick, onClose, style }: { projectId: string; anchorRef: React.RefObject<HTMLElement | null>; onPick: (part: ChatPart) => void; onClose: () => void; style?: CSSProperties }) {
  const { read } = useProjectTracker(projectId)
  const kind = read.kind === 'ready' ? read.tracker.kind : undefined
  const projectName = useStore((s) => s.projects.find((r) => r.id === projectId)?.name)
  const [tab, setTab] = useRemembered<Source>(TAB_KEY, oneOf<Source>(['linear', 'github'], 'linear'))
  // A GitHub project has the one source and only a Linear project chooses between the two. A project with no tracker lists nothing, so
  // a tab stored from another project never lists that tracker's issues here.
  const source: Source | undefined = kind === 'github' ? 'github' : kind === 'linear' ? tab : undefined
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const none = kind === 'none'

  useEffect(() => {
    if (read.kind === 'error') { setLoad({ state: 'error', message: read.message }); return }
    if (!kind) { setLoad({ state: 'loading' }); return }
    if (!source) { setLoad({ state: 'ready', rows: [] }); return }
    let stale = false
    setLoad({ state: 'loading' })
    const t = setTimeout(() => {
      const query = q.trim() || undefined
      const req = source === 'linear' ? call('issues.list', { projectId, query }) : call('github.issues', { projectId, query })
      req.then((rows) => { if (!stale) setLoad({ state: 'ready', rows }) }, (e) => { if (!stale) setLoad({ state: 'error', message: cleanError(e) }) })
    }, q ? 200 : 0)
    return () => { stale = true; clearTimeout(t) }
  }, [source, q, projectId, kind, read])
  useEffect(() => { setAt(0) }, [source, q])

  const rows = load.state === 'ready' ? load.rows : []
  const pick = (i: IssueSummary) => { if (source) onPick({ type: 'issue', name: i.id, title: i.title, url: i.url, source: i.source ?? source }) }
  const switchTo = setTab
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[at]) pick(rows[at]) }
  }

  return (
    <Panel label="Link issue" placeholder="Search issues" query={q} onQuery={setQ} onKey={onKey} anchorRef={anchorRef} onClose={onClose} style={style}>
      {kind === 'linear' && <div className="link-tabs"><Tabs label="Issue source" tabs={SOURCES} value={tab} onChange={(id) => switchTo(id as Source)} /></div>}
      <div className="link-rows" role="listbox" aria-label={source ? `${SOURCE_NAME[source]} issues` : 'Issues'}>
        {rows.map((r, i) => (
          <button key={r.id} type="button" role="option" aria-selected={i === at} tabIndex={-1} className="menu-item link-row" data-active={i === at}
            onMouseEnter={() => setAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
            <span className="link-id mono">{r.id}</span>
            <span className="grow ellipsis">{r.title}</span>
          </button>
        ))}
        {load.state === 'loading' && <p className="link-note">Loading</p>}
        {load.state === 'error' && <p role="alert" className="link-note">{load.message}</p>}
        {none && (
          <div className="link-none">
            <p className="link-note">{projectName ?? 'This project'} has no issue tracker. Choose Linear or GitHub Issues in this project's settings.</p>
            <Button onClick={() => { onClose(); chooseTracker(projectId) }}>Choose a tracker</Button>
          </div>
        )}
        {load.state === 'ready' && source && !rows.length && <p className="link-note">{q.trim() ? 'No open issues match.' : 'No open issues.'}</p>}
      </div>
    </Panel>
  )
}

/** The project's open pull requests, from gh. Enter links the active one, as in the issue picker. */
export function PrPicker({ projectId, anchorRef, onPick, onClose, style }: { projectId: string; anchorRef: React.RefObject<HTMLElement | null>; onPick: (part: ChatPart) => void; onClose: () => void; style?: CSSProperties }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [load, setLoad] = useState<{ state: 'loading' } | { state: 'ready'; rows: PrSummary[] } | { state: 'error'; message: string }>({ state: 'loading' })
  useEffect(() => {
    let stale = false
    setLoad({ state: 'loading' })
    const t = setTimeout(() => {
      call('github.prs', { projectId, query: q.trim() || undefined }).then((rows) => { if (!stale) setLoad({ state: 'ready', rows }) }, (e) => { if (!stale) setLoad({ state: 'error', message: cleanError(e) }) })
    }, q ? 200 : 0)
    return () => { stale = true; clearTimeout(t) }
  }, [q, projectId])
  useEffect(() => { setAt(0) }, [q])

  const rows = load.state === 'ready' ? load.rows : []
  const pick = (p: PrSummary) => onPick({ type: 'pr', name: `#${p.number}`, number: p.number, title: p.title })
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[at]) pick(rows[at]) }
  }
  return (
    <Panel label="Link pull request" placeholder="Search pull requests" query={q} onQuery={setQ} onKey={onKey} anchorRef={anchorRef} onClose={onClose} style={style}>
      <div className="link-rows" role="listbox" aria-label="Open pull requests">
        {rows.map((p, i) => (
          <button key={p.number} type="button" role="option" aria-selected={i === at} tabIndex={-1} className="menu-item link-row" data-active={i === at}
            onMouseEnter={() => setAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
            <span className="link-id mono">#{p.number}</span>
            <span className="grow ellipsis">{p.title}</span>
          </button>
        ))}
        {load.state === 'loading' && <p className="link-note">Loading</p>}
        {load.state === 'error' && <p role="alert" className="link-note">{load.message}</p>}
        {load.state === 'ready' && !rows.length && <p className="link-note">{q.trim() ? 'No open pull requests match.' : 'No open pull requests.'}</p>}
      </div>
    </Panel>
  )
}

const workspacePart = (w: Workspace): ChatPart => ({ type: 'workspace', name: w.name, workspaceId: w.id, branch: w.branch, path: w.path, prNumber: w.prNumber, prUrl: w.prUrl })

/**
 * The project's other open workspaces. Space or a click checks one, Enter links the checked ones (or the active one when none
 * is checked), and so does the Link button.
 */
export function WorkspacePicker({ projectId, exclude, anchorRef, onPick, onClose, style }: { projectId: string; exclude?: string; anchorRef: React.RefObject<HTMLElement | null>; onPick: (parts: ChatPart[]) => void; onClose: () => void; style?: CSSProperties }) {
  const all = useStore((s) => s.workspaces)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [picked, setPicked] = useState<string[]>([])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    // The Lead's own workspace isn't one of the project's workspaces, as in the sidebar.
    return all.filter((w) => w.projectId === projectId && w.id !== exclude && w.status !== 'archived' && !w.lead && (!needle || `${w.name} ${w.branch}`.toLowerCase().includes(needle)))
  }, [all, projectId, exclude, q])
  useEffect(() => { setAt(0) }, [q])

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const link = () => {
    const chosen = picked.length ? all.filter((w) => picked.includes(w.id)) : rows[at] ? [rows[at]] : []
    if (chosen.length) onPick(chosen.map(workspacePart))
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    // Space types into a search that has text, so it checks a row only while the field is empty.
    else if (e.key === ' ' && !q && rows[at]) { e.preventDefault(); toggle(rows[at].id) }
    else if (e.key === 'Enter') { e.preventDefault(); link() }
  }

  return (
    <Panel label="Link workspaces" placeholder="Search workspaces" query={q} onQuery={setQ} onKey={onKey} anchorRef={anchorRef} onClose={onClose} style={style}>
      <div className="link-rows" role="listbox" aria-label="Workspaces" aria-multiselectable="true">
        {rows.map((w, i) => {
          const on = picked.includes(w.id)
          return (
            <button key={w.id} type="button" role="option" aria-selected={on} tabIndex={-1} className="menu-item link-row" data-active={i === at}
              onMouseEnter={() => setAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(w.id)}>
              <span className="link-box" data-on={on || undefined} aria-hidden="true">{on && <Icon name="check" size={12} />}</span>
              <span className="link-name ellipsis">{w.name}</span>
              <span className="grow mono link-sub ellipsis">{w.prNumber ? `#${w.prNumber}` : w.branch}</span>
            </button>
          )
        })}
        {!rows.length && <p className="link-note">{q.trim() ? 'No workspaces match.' : 'No other open workspaces in this project.'}</p>}
      </div>
      <div className="link-foot">
        <span className="link-hint">{picked.length ? `${picked.length} selected` : q ? 'Click to select' : 'Space or click to select'}</span>
        <Button variant="primary" disabled={!picked.length && !rows[at]} onClick={link}>{picked.length > 1 ? `Link ${picked.length}` : 'Link'}</Button>
      </div>
    </Panel>
  )
}
