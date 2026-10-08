import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ChatPart, IssueSummary, Workspace } from '@shared/types'
import { call } from '../../../api'
import { useStore } from '../../../store'
import { Button, Icon, Tabs } from '../../../ui'
import { useLayer } from '../../../ui/hooks'

// + > Link issue and Link workspaces (D-086). Each adds chips the agent reads as a line of context.

type Source = 'linear' | 'github'
type Load = { state: 'loading' } | { state: 'ready'; rows: IssueSummary[] } | { state: 'error'; message: string }

const SOURCES = [{ id: 'linear', label: 'Linear' }, { id: 'github', label: 'GitHub' }]
const TAB_KEY = 'kernel.issueSource'
const errorText = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

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

/** Linear issues (the token in Settings, Integrations) or the room's GitHub issues through gh. Enter links the active one. */
export function IssuePicker({ roomId, anchorRef, onPick, onClose, style }: { roomId: string; anchorRef: React.RefObject<HTMLElement | null>; onPick: (part: ChatPart) => void; onClose: () => void; style?: CSSProperties }) {
  const [source, setSource] = useState<Source>(() => (localStorage.getItem(TAB_KEY) === 'github' ? 'github' : 'linear'))
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    let stale = false
    setLoad({ state: 'loading' })
    const t = setTimeout(() => {
      const query = q.trim() || undefined
      const req = source === 'linear' ? call('issues.list', { roomId, query }) : call('github.issues', { roomId, query })
      req.then((rows) => { if (!stale) setLoad({ state: 'ready', rows }) }, (e) => { if (!stale) setLoad({ state: 'error', message: errorText(e) }) })
    }, q ? 200 : 0)
    return () => { stale = true; clearTimeout(t) }
  }, [source, q, roomId])
  useEffect(() => { setAt(0) }, [source, q])

  const rows = load.state === 'ready' ? load.rows : []
  const pick = (i: IssueSummary) => onPick({ type: 'issue', name: i.id, title: i.title, url: i.url, source: i.source ?? source })
  const switchTo = (s: Source) => { setSource(s); try { localStorage.setItem(TAB_KEY, s) } catch { /* nothing to keep */ } }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[at]) pick(rows[at]) }
  }

  return (
    <Panel label="Link issue" placeholder="Search issues" query={q} onQuery={setQ} onKey={onKey} anchorRef={anchorRef} onClose={onClose} style={style}>
      <div className="link-tabs"><Tabs label="Issue source" tabs={SOURCES} value={source} onChange={(id) => switchTo(id as Source)} /></div>
      <div className="link-rows" role="listbox" aria-label={source === 'linear' ? 'Linear issues' : 'GitHub issues'}>
        {rows.map((r, i) => (
          <button key={r.id} type="button" role="option" aria-selected={i === at} tabIndex={-1} className="menu-item link-row" data-active={i === at}
            onMouseEnter={() => setAt(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
            <span className="link-id mono">{r.id}</span>
            <span className="grow ellipsis">{r.title}</span>
          </button>
        ))}
        {load.state === 'loading' && <p className="link-note">Loading</p>}
        {load.state === 'error' && <p role="alert" className="link-note">{load.message}</p>}
        {load.state === 'ready' && !rows.length && <p className="link-note">{q.trim() ? 'No open issues match.' : 'No open issues.'}</p>}
      </div>
    </Panel>
  )
}

const workspacePart = (w: Workspace): ChatPart => ({ type: 'workspace', name: w.name, workspaceId: w.id, branch: w.branch, path: w.path, prNumber: w.prNumber, prUrl: w.prUrl })

/**
 * The room's other open workspaces. Space or a click checks one, Enter links the checked ones (or the active one when none
 * is checked), and so does the Link button.
 */
export function WorkspacePicker({ roomId, exclude, anchorRef, onPick, onClose, style }: { roomId: string; exclude?: string; anchorRef: React.RefObject<HTMLElement | null>; onPick: (parts: ChatPart[]) => void; onClose: () => void; style?: CSSProperties }) {
  const all = useStore((s) => s.workspaces)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [picked, setPicked] = useState<string[]>([])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    // The Lead's own workspace isn't one of the room's workspaces, as in the sidebar.
    return all.filter((w) => w.roomId === roomId && w.id !== exclude && w.status !== 'archived' && w.name !== 'lead' && (!needle || `${w.name} ${w.branch}`.toLowerCase().includes(needle)))
  }, [all, roomId, exclude, q])
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
              <span className="link-box" data-on={on || undefined} aria-hidden="true">{on && <Icon name="check" size={10} stroke={2} />}</span>
              <span className="link-name ellipsis">{w.name}</span>
              <span className="grow mono link-sub ellipsis">{w.prNumber ? `#${w.prNumber}` : w.branch}</span>
            </button>
          )
        })}
        {!rows.length && <p className="link-note">{q.trim() ? 'No workspaces match.' : 'No other open workspaces in this room.'}</p>}
      </div>
      <div className="link-foot">
        <span className="link-hint">{picked.length ? `${picked.length} selected` : q ? 'Click to select' : 'Space or click to select'}</span>
        <Button variant="primary" disabled={!picked.length && !rows[at]} onClick={link}>{picked.length > 1 ? `Link ${picked.length}` : 'Link'}</Button>
      </div>
    </Panel>
  )
}
