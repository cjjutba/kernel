import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { BranchCommit, Workspace } from '@shared/types'
import { call } from '../../api'
import { Icon, listKeyAction, type IconName } from '../../ui'
import { useLayer } from '../../ui/hooks'
import { commitAge, compareLabel, setCompare, shortSha, type Compare } from './compare'

type Read<T> = { ok: T } | { failed: true } | null

/** What `read` answers, once, when the menu opens. Null while it waits. */
function useRead<T>(read: () => Promise<T>, active = true): Read<T> {
  const [got, setGot] = useState<Read<T>>(null)
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    if (!active) return
    let live = true
    latest.current().then((ok) => { if (live) setGot({ ok }) }).catch(() => { if (live) setGot({ failed: true }) })
    return () => { live = false }
  }, [active])
  return got
}

/** A row of the menu: its icon, its words and, for what is picked, a check at the right (Pen 9.17, 9.21). */
function Row({ checked, icon, onSelect, children, note }: { checked?: boolean; icon: IconName; onSelect: () => void; children: ReactNode; note?: string }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={!!checked} className="compare-row" onClick={onSelect}>
      <Icon name={icon} size={14} />
      <span className="compare-name ellipsis">{children}</span>
      {note && <span className="compare-none">{note}</span>}
      <span className="compare-ck">{checked && <Icon name="check" size={14} />}</span>
    </button>
  )
}

/** A row that opens another page of the menu: what it is for, what is picked there and a chevron. */
function PageRow({ icon, label, value, onOpen }: { icon: IconName; label: string; value?: string; onOpen: () => void }) {
  return (
    <button type="button" role="menuitem" className="compare-row" aria-haspopup="menu" aria-label={value ? `${label}, ${value}` : label} onClick={onOpen}>
      <Icon name={icon} size={14} />
      <span className="compare-name ellipsis">{label}</span>
      {value && <span className="mono compare-value ellipsis">{value}</span>}
      <Icon name="right" size={12} />
    </button>
  )
}

function CommitRow({ commit, checked, onSelect }: { commit: BranchCommit; checked: boolean; onSelect: () => void }) {
  const age = commitAge(commit.time)
  const sha = shortSha(commit.sha)
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} className="compare-row compare-commit" aria-label={`${commit.subject}, ${sha}, ${commit.author}, ${age}`} data-tip={commit.subject} onClick={onSelect}>
      <Icon name="commit" size={14} />
      <span className="mono compare-sha">{sha}</span>
      <span className="compare-subject ellipsis">{commit.subject}</span>
      <span className="compare-ck">{checked && <Icon name="check" size={14} />}</span>
    </button>
  )
}

/**
 * The Changes compare menu (Pen 9.17, 9.21, KERNEL-517): All changes and Uncommitted changes, then Target branch and Commits, each of which opens a page of the same menu with a way back.
 * The shared Menu draws one line a row with the check at the right, so this is its own menu on the same `.menu` shell, as the model picker is. Arrow keys, Home and End move between
 * the rows, Enter picks, Escape goes back a page or closes, and ArrowLeft goes back.
 */
function CompareMenu({ ws, compare, anchorRef, onClose }: { ws: Workspace; compare: Compare; anchorRef: RefObject<HTMLElement | null>; onClose: (refocus?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<'root' | 'branches' | 'commits'>('root')
  const [text, setText] = useState('')
  const commits = useRead(() => call('workspaces.commits', { workspaceId: ws.id }), page === 'commits')
  const branches = useRead(() => call('workspaces.compareBranches', { workspaceId: ws.id }), page === 'branches')
  // Whether anything is uncommitted, so the row can say none. It is read when the menu opens.
  const loose = useRead(() => call('workspaces.changes', { workspaceId: ws.id, target: { kind: 'uncommitted' } }))
  const branch = compare.branch ?? ws.baseRef
  const back = () => { setPage('root'); setText('') }
  useLayer({ onEscape: () => (page !== 'root' ? back() : onClose(true)), onOutside: () => onClose(), ref, anchorRef })

  const stops = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])]
  // A page opens with its checked row focused, else its first stop. Coming back lands on the row that opened the page.
  const was = useRef<typeof page | null>(null)
  useEffect(() => {
    const opener = was.current && was.current !== 'root' && page === 'root' ? [...(ref.current?.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]') ?? [])][was.current === 'branches' ? 0 : 1] : undefined
    ;(opener ?? ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? stops()[0])?.focus({ preventScroll: true })
    was.current = page
  }, [page])
  // A list arrives after its page opens, so the pick is focused once it is there.
  useEffect(() => {
    const got = page === 'branches' ? branches : page === 'commits' ? commits : null
    if (got && 'ok' in got) (ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? stops()[0])?.focus({ preventScroll: true })
  }, [page, branches, commits])

  const pick = (next: Compare) => { setCompare(ws.id, next); onClose(true) }
  const onKey = (e: KeyboardEvent) => {
    const all = stops()
    const i = all.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => { e.preventDefault(); e.stopPropagation(); all[(to + all.length) % all.length]?.focus() }
    // Home, End and ArrowLeft belong to the caret while the branch filter has focus.
    const typing = e.target instanceof HTMLInputElement
    const action = listKeyAction(e, i, all.length, true)
    const to = action?.kind === 'move' && (!typing || e.key.startsWith('Arrow')) ? action.to : null
    if (to !== null) move(to)
    else if (e.key === 'ArrowLeft' && page !== 'root' && !typing) { e.preventDefault(); back() }
    else if (e.key === 'Tab') { e.preventDefault(); onClose(true) }
  }

  const needle = text.trim().toLowerCase()
  const list = useMemo(() => (branches && 'ok' in branches ? branches.ok.filter((b) => !needle || b.toLowerCase().includes(needle)) : []), [branches, needle])
  const header = (title: string) => (
    <>
      <button type="button" role="menuitem" className="compare-back" aria-label="Back to compare options" onClick={back}>
        <Icon name="left" size={12} />
        <span>{title}</span>
      </button>
      <div className="compare-rule" role="separator" />
    </>
  )

  if (page === 'branches') {
    return (
      <div ref={ref} className="menu compare-menu" role="menu" aria-label="Target branch" onKeyDown={onKey}>
        {header('Back to compare options')}
        <div className="compare-filter">
          <Icon name="search" size={14} />
          <input type="text" aria-label="Filter branches" placeholder="Filter branches" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </div>
        <div className="compare-list" role="group" aria-label="Branches">
          {branches === null && <p className="compare-note">Loading branches</p>}
          {branches && 'failed' in branches && <p className="compare-note">Could not list branches</p>}
          {list.map((b) => (
            <button key={b} type="button" role="menuitemradio" aria-checked={b === branch} className="compare-row" onClick={() => pick({ branch: b === ws.baseRef ? undefined : b })}>
              <Icon name="branch" size={14} />
              <span className="mono compare-name ellipsis">{b}</span>
              <span className="compare-ck">{b === branch && <Icon name="check" size={14} />}</span>
            </button>
          ))}
          {branches && 'ok' in branches && !list.length && <p className="compare-note">No branch matches</p>}
        </div>
      </div>
    )
  }

  if (page === 'commits') {
    return (
      <div ref={ref} className="menu compare-menu" role="menu" aria-label="Commits" onKeyDown={onKey}>
        {header('Back to compare options')}
        <div className="compare-commits" role="group" aria-label="Commits">
          {commits === null && <p className="compare-note">Loading commits</p>}
          {commits && 'failed' in commits && <p className="compare-note">Could not read the commits</p>}
          {commits && 'ok' in commits && !commits.ok.length && <p className="compare-note">No commits since {ws.baseRef}</p>}
          {commits && 'ok' in commits && commits.ok.map((c) => (
            <CommitRow key={c.sha} commit={c} checked={compare.only?.kind === 'commit' && compare.only.sha === c.sha} onSelect={() => pick({ ...compare, only: { kind: 'commit', sha: c.sha } })} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div ref={ref} className="menu compare-menu" role="menu" aria-label="Compare changes" onKeyDown={onKey}>
      <div className="compare-heading">Compare changes</div>
      <Row icon="layers" checked={!compare.only} onSelect={() => pick({ branch: compare.branch })}>All changes</Row>
      <Row icon="doc" checked={compare.only?.kind === 'uncommitted'} note={loose && 'ok' in loose && !loose.ok.length ? 'none' : undefined} onSelect={() => pick({ ...compare, only: { kind: 'uncommitted' } })}>Uncommitted changes</Row>
      <div className="compare-rule" role="separator" />
      <PageRow icon="branch" label="Target branch" value={branch.replace(/^origin\//, '')} onOpen={() => setPage('branches')} />
      <PageRow icon="commit" label="Commits" onOpen={() => setPage('commits')} />
    </div>
  )
}

/** The compare button at the end of the Changes toolbar and the menu it opens: "Against main" with a chevron, like a select. */
export function CompareButton({ ws, compare }: { ws: Workspace; compare: Compare }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const close = (refocus?: boolean) => { setOpen(false); if (refocus) button.current?.focus() }
  return (
    <span ref={anchor} className="compare-anchor">
      <button ref={button} type="button" className="compare-btn" aria-label="Compare changes" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ellipsis">{compareLabel(ws, compare)}</span><Icon name="chevron" size={12} />
      </button>
      {open && <CompareMenu ws={ws} compare={compare} anchorRef={anchor} onClose={close} />}
    </span>
  )
}
