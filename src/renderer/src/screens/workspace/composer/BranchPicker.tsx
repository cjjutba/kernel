import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { call } from '../../../api'
import { go, useStore } from '../../../store'
import { Icon, Kbd } from '../../../ui'
import { stripRemote } from '../../settings/remote'
import { useRemote } from '../../settings/useSettings'
import { branchLine, branchRows, type BranchRow } from './branchRows'
import { PopSearch, WherePop } from './WherePop'

/**
 * The branch a new Lead chat starts from: the picked one, else the repo's default on the project's remote. A Lead chat
 * never takes the workspace base from Settings (KERNEL-405), so the default here is the default branch, as the engine's is.
 */
export function useBaseBranch(projectId: string, picked: string): { target: string; fallback: string; remote: string } {
  const remote = useRemote(projectId)
  const main = useStore((s) => s.projects.find((r) => r.id === projectId)?.defaultBranch)
  const fallback = `${remote}/${main ? stripRemote(main, remote) : 'main'}`
  return { target: picked || fallback, fallback, remote }
}

/**
 * The branch New chat's chat starts from, opened from the + menu's Branch row or the chip beside + (KERNEL-786). Its menu searches the project's branches: each row has the
 * branch's name in mono and a muted line, its age and a tag (default, remote, has a workspace). A branch with an open workspace offers
 * Open workspace (⌘↵) on hover and focus, and picking the row still sets the base. Arrow keys, Home and End move, Enter picks, Escape closes.
 * `picked` is empty for the default.
 */
export function BranchPanel({ projectId, picked, anchorRef, onClose, onPick }: { projectId: string; picked: string; anchorRef: React.RefObject<HTMLElement | null>; onClose: (refocus?: boolean) => void; onPick: (ref: string) => void }) {
  const { target, fallback, remote } = useBaseBranch(projectId, picked)
  return <BranchMenu projectId={projectId} target={target} fallback={fallback} remote={remote} anchorRef={anchorRef} onClose={onClose} onPick={(ref) => onPick(ref === fallback ? '' : ref)} />
}

export type BranchRead = { ok: { name: string; committedAt: number }[] } | { failed: true } | null

/**
 * Each project's branches as last read. New chat reads them when it opens, so the menu opens on the list instead of a loading line that
 * the list then replaces, and opening the menu reads them again behind it. A failed read keeps the list from before.
 */
const branches = new Map<string, BranchRead>()
const reading = new Map<string, Promise<void>>()
const branchListeners = new Set<() => void>()

export function readBranches(projectId: string): Promise<void> {
  const now = reading.get(projectId)
  if (now) return now
  const set = (r: BranchRead) => { branches.set(projectId, r); for (const fn of [...branchListeners]) fn() }
  const p = call('git.branchList', { projectId })
    .then((ok) => set({ ok }), () => { if (!branches.get(projectId)) set({ failed: true }) })
    .finally(() => reading.delete(projectId))
  reading.set(projectId, p)
  return p
}

const onBranches = (fn: () => void) => { branchListeners.add(fn); return () => { branchListeners.delete(fn) } }

/** The project's branches as last read, null until the first read answers. */
export const useBranches = (projectId: string): BranchRead => useSyncExternalStore(onBranches, () => branches.get(projectId) ?? null)

function BranchMenu({ projectId, target, fallback, remote, anchorRef, onClose, onPick }: { projectId: string; target: string; fallback: string; remote: string; anchorRef: React.RefObject<HTMLElement | null>; onClose: (refocus?: boolean) => void; onPick: (ref: string) => void }) {
  const read = useBranches(projectId)
  const [text, setText] = useState('')
  const workspaces = useStore((s) => s.workspaces)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { void readBranches(projectId) }, [projectId])

  // A pick from before stays listed, even when the repo no longer has it, so the check always shows.
  const rows = useMemo(() => {
    const all = branchRows({ list: read && 'ok' in read ? read.ok : [], fallback, remote, workspaces, projectId })
    return all.some((r) => r.ref === target) ? all : [...all, { ref: target, name: stripRemote(target, remote), age: '', tag: '' } satisfies BranchRow]
  }, [read, fallback, remote, workspaces, projectId, target])
  const needle = text.trim().toLowerCase()
  const shown = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows

  // The menu opens on its checked row, and again once the branches arrive.
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [read])
  const openWorkspace = (workspaceId: string | undefined) => {
    if (!workspaceId) return false
    onClose()
    go({ name: 'workspace', workspaceId })
    return true
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey && openWorkspace((document.activeElement as HTMLElement | null)?.dataset.workspace)) e.preventDefault()
    else if (e.key === 'Enter' && e.target instanceof HTMLInputElement && shown[0]) { e.preventDefault(); onPick(shown[0].ref) }
  }

  return (
    <WherePop anchorRef={anchorRef} label="Branch from" width={440} align="end" onClose={onClose} onKey={onKey} focusFirst={false}>
      <PopSearch label="Search branches…" value={text} onChange={setText} />
      <div ref={list} className="where-list where-branches" role="group" aria-label="Branches">
        {shown.map((r) => (
          <div key={r.ref} className="where-branch">
            <button type="button" role="menuitemradio" aria-checked={r.ref === target} data-workspace={r.workspaceId} className="menu-item where-row where-mode" onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })} onClick={() => onPick(r.ref)}>
              <Icon name="branch" size={16} />
              <span className="where-tx"><span className="where-t mono ellipsis">{r.name}</span><span className="where-d">{branchLine(r)}</span></span>
              {r.ref === target && <Icon name="check" size={14} />}
            </button>
            {r.workspaceId && (
              <button type="button" tabIndex={-1} className="where-open" aria-label={`Open the workspace on ${r.name}`} onClick={() => openWorkspace(r.workspaceId)}>
                Open workspace <Kbd>⌘↵</Kbd>
              </button>
            )}
          </div>
        ))}
        {read === null && <p className="where-note">Loading branches</p>}
        {read && 'failed' in read && <p className="where-note">Could not list branches</p>}
        {!shown.length && read !== null && <p className="where-note">No branch matches</p>}
      </div>
    </WherePop>
  )
}
