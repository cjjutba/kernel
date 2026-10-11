import { useEffect, useRef, useState } from 'react'
import { call } from '../../api'
import { actions } from '../../store'
import { Tabs } from '../../ui'
import { useLayer } from '../../ui/hooks'
import { useRemote } from '../settings/useSettings'
import { branchRow, issueRow, matches, prRow, type FromRow, type FromTab } from './pick'

const TABS = [{ id: 'prs', label: 'PRs' }, { id: 'branches', label: 'Branches' }, { id: 'issues', label: 'Issues' }]
const EMPTY: Record<FromTab, string> = { prs: 'No open pull requests match.', branches: 'No branches match.', issues: 'No open issues match.' }

type Load = { state: 'loading' } | { state: 'ready'; rows: FromRow[] } | { state: 'error'; message: string }

/**
 * Start from a PR, a branch or a Linear issue (NewWorkspaceFrom.png). Search is live, arrow keys move, Enter picks.
 * PRs come from gh, issues from Linear (token in Settings > Integrations), branches from the room's repo.
 */
export function FromPopover({ roomId, branches, tab, onTab, onPick, anchorRef }: { roomId: string; branches: string[]; tab: FromTab; onTab: (t: FromTab) => void; onPick: (r: FromRow) => void; anchorRef: React.RefObject<HTMLElement | null> }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const remote = useRemote(roomId)
  const ref = useRef<HTMLDivElement>(null)
  const close = actions.ui.closeMenu
  useLayer({ onEscape: close, onOutside: close, ref, anchorRef })
  useEffect(() => { ref.current?.querySelector('input')?.focus() }, [])

  useEffect(() => {
    if (tab === 'branches') { setLoad({ state: 'ready', rows: branches.filter((b) => matches(b, q)).map(branchRow) }); return }
    let stale = false
    setLoad({ state: 'loading' })
    const t = setTimeout(() => {
      const done = (rows: FromRow[]) => { if (!stale) setLoad({ state: 'ready', rows }) }
      const fail = (e: unknown) => { if (!stale) setLoad({ state: 'error', message: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }) }
      if (tab === 'prs') call('github.prs', { roomId, query: q || undefined }).then((r) => done(r.map((p) => prRow(p, remote))), fail)
      else call('issues.list', { roomId, query: q || undefined }).then((r) => done(r.map(issueRow)), fail)
    }, q ? 200 : 0)
    return () => { stale = true; clearTimeout(t) }
  }, [tab, q, roomId, branches, remote])

  const rows = load.state === 'ready' ? load.rows : []
  useEffect(() => { setAt(0) }, [tab, q])
  useEffect(() => { ref.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [at, rows.length])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter' && !e.metaKey) { e.preventDefault(); e.stopPropagation(); if (rows[at]) onPick(rows[at]) }
  }

  return (
    <div ref={ref} role="dialog" aria-label="Start from" className="nw-pop nw-from" onKeyDown={onKey}>
      <input className="nw-from-q" aria-label="Search by title, number, or author" placeholder="Search by title, number, or author" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="nw-from-tabs"><Tabs label="Start from" tabs={TABS} value={tab} onChange={(t) => onTab(t as FromTab)} /></div>
      <div className="nw-from-rows" role="listbox" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {rows.map((r, i) => (
          <button key={r.key} type="button" role="option" aria-selected={i === at} data-active={i === at} className="nw-from-row" onMouseEnter={() => setAt(i)} onClick={() => onPick(r)}>
            <span className="nw-from-id">{r.id}</span>
            <span className="grow ellipsis">{r.title}</span>
            {i === at && <span className="nw-from-hint">Select ↵</span>}
          </button>
        ))}
        {load.state === 'loading' && <p className="nw-from-note">Loading</p>}
        {load.state === 'error' && <p role="alert" className="nw-from-note">{load.message}</p>}
        {load.state === 'ready' && !rows.length && <p className="nw-from-note">{EMPTY[tab]}</p>}
      </div>
    </div>
  )
}
