import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { BranchCommit, Workspace } from '@shared/types'
import { call } from '../../api'
import { Icon, listKeyAction } from '../../ui'
import { useLayer } from '../../ui/hooks'
import { commitAge, setCompare, shortSha, type Compare } from './compare'
import { ToolButton } from './PanelTools'

/** A branch list this long gets a field to narrow it by name. */
const FILTER_FROM = 8

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

/** The check column, 16px wide, so a row with no check lines up with the ones that have it. */
const Check = ({ on }: { on: boolean }) => <span className="compare-ck">{on && <Icon name="check" size={16} />}</span>

function Row({ checked, onSelect, children }: { checked: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} className="compare-row" onClick={onSelect}>
      <Check on={checked} />
      <span className="ellipsis">{children}</span>
    </button>
  )
}

function CommitRow({ commit, checked, onSelect }: { commit: BranchCommit; checked: boolean; onSelect: () => void }) {
  const age = commitAge(commit.time)
  const sha = shortSha(commit.sha)
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} className="compare-row compare-commit" aria-label={`${commit.subject}, ${sha}, ${commit.author}, ${age}`} data-tip={commit.subject} onClick={onSelect}>
      <Check on={checked} />
      <span className="compare-text">
        <span className="compare-subject">{commit.subject}</span>
        <span className="compare-sub" aria-hidden="true">
          <span className="mono compare-sha">{sha}</span>
          <span className="compare-dot">·</span>
          <span className="ellipsis">{commit.author}</span>
          <span className="compare-age">{age}</span>
        </span>
      </span>
    </button>
  )
}

/**
 * The Changes ⋯ menu (PanelCompare.png, KERNEL-517): the Target branch picker, then All changes, Uncommitted changes and one row per commit
 * on the branch since its base, with a check on the pick. The shared Menu draws one line a row with the check at the right, so this is
 * its own menu on the same `.menu` shell, as the model picker is. Arrow keys, Home and End move between the rows, Enter picks, Escape closes.
 * The branch picker is a second page of the same menu, since PanelCompare draws no dropdown: ArrowLeft or Escape goes back to the first.
 */
function CompareMenu({ ws, compare, anchorRef, onClose }: { ws: Workspace; compare: Compare; anchorRef: RefObject<HTMLElement | null>; onClose: (refocus?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<'targets' | 'branches'>('targets')
  const [text, setText] = useState('')
  const commits = useRead(() => call('workspaces.commits', { workspaceId: ws.id }))
  const branches = useRead(() => call('workspaces.compareBranches', { workspaceId: ws.id }), page === 'branches')
  const branch = compare.branch ?? ws.baseRef
  const back = () => { setPage('targets'); setText('') }
  useLayer({ onEscape: () => (page === 'branches' ? back() : onClose(true)), onOutside: () => onClose(), ref, anchorRef })

  const stops = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])]
  // A page opens with its checked row focused, else its first stop. Coming back from the branches lands on the picker.
  const was = useRef<typeof page | null>(null)
  useEffect(() => {
    const first = was.current === 'branches' && page === 'targets' ? ref.current?.querySelector<HTMLElement>('.compare-pick') : ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? stops()[0]
    first?.focus({ preventScroll: true })
    was.current = page
  }, [page])
  // The branch list arrives after its page opens, so the pick is focused once it is there.
  useEffect(() => { if (page === 'branches' && branches && 'ok' in branches) (ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? stops()[0])?.focus({ preventScroll: true }) }, [page, branches])

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
    else if (e.key === 'ArrowLeft' && page === 'branches' && !typing) { e.preventDefault(); back() }
    else if (e.key === 'Tab') { e.preventDefault(); onClose(true) }
  }

  const needle = text.trim().toLowerCase()
  const list = useMemo(() => (branches && 'ok' in branches ? branches.ok.filter((b) => !needle || b.toLowerCase().includes(needle)) : []), [branches, needle])

  if (page === 'branches') {
    return (
      <div ref={ref} className="menu compare-menu" role="menu" aria-label="Target branch" onKeyDown={onKey}>
        <button type="button" role="menuitem" className="compare-back" aria-label="Back to compare options" onClick={back}>
          <Icon name="left" size={14} />
          <span>Target branch</span>
        </button>
        <div className="compare-rule" role="separator" />
        {branches && 'ok' in branches && branches.ok.length >= FILTER_FROM && (
          <div className="compare-filter">
            <Icon name="search" size={14} />
            <input type="text" aria-label="Filter branches" placeholder="Filter branches" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
          </div>
        )}
        <div className="compare-list" role="group" aria-label="Branches">
          {branches === null && <p className="compare-note">Loading branches</p>}
          {branches && 'failed' in branches && <p className="compare-note">Could not list branches</p>}
          {list.map((b) => (
            <button key={b} type="button" role="menuitemradio" aria-checked={b === branch} className="compare-row" onClick={() => pick({ branch: b === ws.baseRef ? undefined : b })}>
              <Check on={b === branch} />
              <span className="mono ellipsis">{b}</span>
            </button>
          ))}
          {branches && 'ok' in branches && !list.length && <p className="compare-note">No branch matches</p>}
        </div>
      </div>
    )
  }

  return (
    <div ref={ref} className="menu compare-menu" role="menu" aria-label="Compare changes" onKeyDown={onKey}>
      <div className="compare-target">
        <span className="muted">Target branch</span>
        <button type="button" role="menuitem" className="compare-pick" aria-label={`Target branch, ${branch}`} aria-haspopup="menu" onClick={() => setPage('branches')}>
          <span className="mono ellipsis">{branch}</span>
          <Icon name="chevron" size={12} />
        </button>
      </div>
      <div className="compare-rule" role="separator" />
      <Row checked={!compare.only} onSelect={() => pick({ branch: compare.branch })}>All changes</Row>
      <Row checked={compare.only?.kind === 'uncommitted'} onSelect={() => pick({ ...compare, only: { kind: 'uncommitted' } })}>Uncommitted changes</Row>
      <div className="compare-rule" role="separator" />
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

/** The ⋯ at the end of the Changes toolbar and the menu it opens. */
export function CompareButton({ ws, compare }: { ws: Workspace; compare: Compare }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const close = (refocus?: boolean) => { setOpen(false); if (refocus) button.current?.focus() }
  return (
    <span ref={anchor} className="compare-anchor">
      <ToolButton ref={button} icon="more" label="Compare changes" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && <CompareMenu ws={ws} compare={compare} anchorRef={anchor} onClose={close} />}
    </span>
  )
}
