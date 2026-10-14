import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { call } from '../../../api'
import { useStore } from '../../../store'
import { Button, Icon } from '../../../ui'
import { useLayer } from '../../../ui/hooks'
import { stripRemote } from '../../settings/remote'
import { useRemote } from '../../settings/useSettings'

/** A branch list this long gets a field to narrow it by name, as the Changes compare menu does. */
const FILTER_FROM = 8

/**
 * The branch a new Lead chat starts from: the picked one, else the repo's default on the room's remote. A Lead chat
 * never takes the workspace base from Settings (KERNEL-405), so the default here is the default branch, as the engine's is.
 */
export function useBaseBranch(roomId: string, picked: string): { target: string; fallback: string; remote: string } {
  const remote = useRemote(roomId)
  const main = useStore((s) => s.rooms.find((r) => r.id === roomId)?.defaultBranch)
  const fallback = `${remote}/${main ? stripRemote(main, remote) : 'main'}`
  return { target: picked || fallback, fallback, remote }
}

/** The branches the menu offers: the default first, then the remote's other branches in the order git lists them. */
export function branchRows(branches: string[], fallback: string, remote: string): string[] {
  const onRemote = branches.filter((b) => b.startsWith(`${remote}/`) && b !== `${remote}/HEAD` && b !== fallback)
  return [fallback, ...onRemote]
}

/**
 * New branch from main, in New chat's composer. The button names the branch the chat's worktree branches from, and its
 * menu lists the remote's branches with the default checked and marked. The list and its filter are the compare menu's
 * (PanelCompare.png): arrow keys, Home and End move between the rows, Enter picks, Escape closes. `picked` is empty for the default.
 */
export function BranchPicker({ roomId, lead, picked, open, disabled, onToggle, onClose, onPick }: { roomId: string; lead: string; picked: string; open: boolean; disabled?: boolean; onToggle: () => void; onClose: () => void; onPick: (ref: string) => void }) {
  const { target, fallback, remote } = useBaseBranch(roomId, picked)
  const anchor = useRef<HTMLSpanElement>(null)
  const close = (refocus?: boolean) => { onClose(); if (refocus) anchor.current?.querySelector<HTMLButtonElement>('.cmp-branch')?.focus() }
  const name = stripRemote(target, remote)
  return (
    <span ref={anchor} className="cmp-branch-anchor">
      <Button variant="ghost" className="cmp-model cmp-branch" disabled={disabled} aria-label={`New branch from ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>
        <Icon name="branch" size={14} /><span className="cmp-branch-name">New branch from {name}</span><Icon name="chevron" size={12} />
      </Button>
      {open && <BranchMenu roomId={roomId} lead={lead} target={target} fallback={fallback} remote={remote} anchorRef={anchor} onClose={close} onPick={(ref) => { onPick(ref === fallback ? '' : ref); close(true) }} />}
    </span>
  )
}

type Read = { ok: string[] } | { failed: true } | null

function BranchMenu({ roomId, lead, target, fallback, remote, anchorRef, onClose, onPick }: { roomId: string; lead: string; target: string; fallback: string; remote: string; anchorRef: React.RefObject<HTMLElement | null>; onClose: (refocus?: boolean) => void; onPick: (ref: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [read, setRead] = useState<Read>(null)
  const [text, setText] = useState('')
  useLayer({ onEscape: () => onClose(true), onOutside: () => onClose(), ref, anchorRef })
  useEffect(() => {
    let live = true
    call('git.branches', { roomId }).then((ok) => { if (live) setRead({ ok }) }, () => { if (live) setRead({ failed: true }) })
    return () => { live = false }
  }, [roomId])

  // A pick from before stays listed, even when the remote no longer has it, so the check always shows.
  const rows = useMemo(() => {
    const all = read && 'ok' in read ? branchRows(read.ok, fallback, remote) : [fallback]
    return all.includes(target) ? all : [...all, target]
  }, [read, fallback, remote, target])
  const needle = text.trim().toLowerCase()
  const shown = needle ? rows.filter((b) => b.toLowerCase().includes(needle)) : rows

  const stops = () => [...(ref.current?.querySelectorAll<HTMLElement>('button, input') ?? [])]
  // The menu opens on its checked row, and again once the branches arrive.
  useEffect(() => { (ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? stops()[0])?.focus({ preventScroll: true }) }, [read])
  const onKey = (e: KeyboardEvent) => {
    const all = stops()
    const i = all.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => { e.preventDefault(); e.stopPropagation(); all[(to + all.length) % all.length]?.focus() }
    // Home and End belong to the caret while the filter has focus.
    const typing = e.target instanceof HTMLInputElement
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - 1)
    else if (e.key === 'Home' && !typing) move(0)
    else if (e.key === 'End' && !typing) move(all.length - 1)
    else if (e.key === 'Tab') { e.preventDefault(); onClose(true) }
  }

  return (
    <div ref={ref} className="menu compare-menu cmp-branch-menu" role="menu" aria-label="Branch from" onKeyDown={onKey}>
      <div className="cmp-branch-head muted">Branch from</div>
      {rows.length >= FILTER_FROM && (
        <div className="compare-filter">
          <Icon name="search" size={14} />
          <input type="text" aria-label="Filter branches" placeholder="Filter branches" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </div>
      )}
      <div className="compare-list" role="group" aria-label="Branches">
        {shown.map((b) => (
          <button key={b} type="button" role="menuitemradio" aria-checked={b === target} className="compare-row" onClick={() => onPick(b)}>
            <span className="compare-ck">{b === target && <Icon name="check" size={16} />}</span>
            <span className="mono ellipsis grow">{b}</span>
            {b === fallback && <span className="cmp-branch-tag">Default</span>}
          </button>
        ))}
        {read === null && <p className="compare-note">Loading branches</p>}
        {read && 'failed' in read && <p className="compare-note">Could not list branches</p>}
        {!shown.length && <p className="compare-note">No branch matches</p>}
      </div>
      <div className="compare-rule" role="separator" />
      <p className="cmp-branch-hint">{lead}'s chat gets its own worktree, on a new branch from the one you pick.</p>
    </div>
  )
}
