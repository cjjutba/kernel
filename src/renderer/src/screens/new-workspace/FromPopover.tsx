import { useEffect, useRef, useState } from 'react'
import { call, cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { Button, Tabs } from '../../ui'
import { useLayer } from '../../ui/hooks'
import { useRemote } from '../settings/useSettings'
import { chooseTracker } from '../issues/parts'
import { loginInitials } from '../issues/model'
import { useRoomTracker } from '../issues/useRoomTracker'
import { branchRow, githubIssueRow, issueRow, matches, prRow, type FromRow, type FromTab } from './pick'

const TABS = [{ id: 'prs', label: 'PRs' }, { id: 'branches', label: 'Branches' }, { id: 'issues', label: 'Issues' }]
const EMPTY: Record<FromTab, string> = { prs: 'No open pull requests match.', branches: 'No branches match.', issues: 'No open issues match.' }

type Load = { state: 'loading' } | { state: 'ready'; rows: FromRow[] } | { state: 'error'; message: string }

/**
 * Start from a PR, a branch or an issue (NewWorkspaceFrom.png). Search is live, arrow keys move, Enter picks.
 * PRs come from gh, issues from the room's tracker (Linear with its token in Settings > Integrations, or GitHub Issues through gh),
 * branches from the room's repo. A room with no tracker keeps the Issues tab and says so (NewWorkspaceFromNone.png, KERNEL-438).
 */
export function FromPopover({ roomId, branches, tab, onTab, onPick, anchorRef }: { roomId: string; branches: string[]; tab: FromTab; onTab: (t: FromTab) => void; onPick: (r: FromRow) => void; anchorRef: React.RefObject<HTMLElement | null> }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const remote = useRemote(roomId)
  const roomName = useStore((s) => s.rooms.find((r) => r.id === roomId)?.name)
  const { read: tracker } = useRoomTracker(roomId)
  const noTracker = tab === 'issues' && tracker.kind === 'ready' && tracker.tracker.kind === 'none'
  const github = tracker.kind === 'ready' && tracker.tracker.kind === 'github'
  // The Issues tab waits for the room's tracker, since it decides where the rows come from.
  const waiting = tab === 'issues' && tracker.kind === 'loading'
  const ref = useRef<HTMLDivElement>(null)
  const close = actions.ui.closeMenu
  useLayer({ onEscape: close, onOutside: close, ref, anchorRef })
  useEffect(() => { ref.current?.querySelector('input')?.focus() }, [])

  useEffect(() => {
    if (tab === 'branches') { setLoad({ state: 'ready', rows: branches.filter((b) => matches(b, q)).map(branchRow) }); return }
    if (tab === 'issues' && (tracker.kind === 'loading' || (tracker.kind === 'ready' && tracker.tracker.kind === 'none'))) { setLoad({ state: 'ready', rows: [] }); return }
    if (tab === 'issues' && tracker.kind === 'error') { setLoad({ state: 'error', message: tracker.message }); return }
    let stale = false
    setLoad({ state: 'loading' })
    const t = setTimeout(() => {
      const done = (rows: FromRow[]) => { if (!stale) setLoad({ state: 'ready', rows }) }
      const fail = (e: unknown) => { if (!stale) setLoad({ state: 'error', message: cleanError(e) }) }
      if (tab === 'prs') call('github.prs', { roomId, query: q || undefined }).then((r) => done(r.map((p) => prRow(p, remote))), fail)
      else if (github) call('github.issueList', { roomId, query: q || undefined }).then((r) => done(r.map(githubIssueRow)), fail)
      else call('issues.list', { roomId, query: q || undefined }).then((r) => done(r.map(issueRow)), fail)
    }, q ? 200 : 0)
    return () => { stale = true; clearTimeout(t) }
  }, [tab, q, roomId, branches, remote, tracker, github])

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
            {r.who && <span className="nw-from-av" role="img" aria-label={`Assigned to ${r.who}`}>{loginInitials(r.who)}</span>}
            {/* A GitHub list keeps the hint's place in every row, so the avatars line up whether or not the row shows it. */}
            {github ? <span className="nw-from-slot">{i === at && <span className="nw-from-hint">Select ↵</span>}</span> : i === at && <span className="nw-from-hint">Select ↵</span>}
          </button>
        ))}
        {(load.state === 'loading' || waiting) && <p className="nw-from-note">Loading</p>}
        {load.state === 'error' && <p role="alert" className="nw-from-note">{load.message}</p>}
        {noTracker && (
          <div className="nw-from-none">
            <p className="nw-from-none-title">{roomName ?? 'This room'} has no issue tracker</p>
            <p className="nw-from-note">Choose Linear or GitHub Issues in this room's settings.</p>
            <Button onClick={() => { actions.ui.closeModal(); chooseTracker(roomId) }}>Choose a tracker</Button>
          </div>
        )}
        {load.state === 'ready' && !waiting && !noTracker && !rows.length && <p className="nw-from-note">{EMPTY[tab]}</p>}
      </div>
    </div>
  )
}
