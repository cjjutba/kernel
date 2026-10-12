import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ChangedFile, CompareTarget, Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { getState, subscribe as watchStore } from '../../store'

/**
 * What the Changes ⋯ menu has picked (PanelCompare, KERNEL-517). `branch` is the branch All changes is against, the workspace's base
 * when it is left out. `only` narrows the list to what isn't committed yet, or to one commit. Both are kept, so All changes goes back
 * to the branch picked before Uncommitted changes.
 */
export interface Compare {
  branch?: string
  only?: { kind: 'uncommitted' } | { kind: 'commit'; sha: string }
}

export const ALL: Compare = {}

export const isAll = (c: Compare) => !c.branch && !c.only

/** What `workspaces.changes`, `workspaces.diff` and `workspaces.readImage` take for a pick. */
export function targetOf(c: Compare): CompareTarget {
  if (c.only) return c.only
  return c.branch ? { kind: 'branch', ref: c.branch } : { kind: 'base' }
}

export const targetKey = (t: CompareTarget) => JSON.stringify(t)

export const shortSha = (sha: string) => sha.slice(0, 7)

/** What the count line adds after "3 files changed" for a target that isn't the default. Empty for the default. */
export function compareNote(c: Compare): string {
  if (c.only?.kind === 'uncommitted') return 'since the last commit'
  if (c.only) return `in ${shortSha(c.only.sha)}`
  return c.branch ? `against ${c.branch}` : ''
}

/** The title of the diff tab for All changes, which says what it compares when that isn't the default. */
export function compareTitle(c: Compare): string {
  if (c.only?.kind === 'uncommitted') return 'Uncommitted changes'
  if (c.only) return `Commit ${shortSha(c.only.sha)}`
  return c.branch ? `All changes against ${c.branch}` : 'All changes'
}

/** What the list says when the target has no files. */
export function compareEmpty(c: Compare): { title: string; sub: string } {
  if (c.only?.kind === 'uncommitted') return { title: 'Nothing uncommitted', sub: 'Every change is committed.' }
  if (c.only) return { title: 'No file changes', sub: 'This commit changes no files.' }
  if (c.branch) return { title: `No changes against ${c.branch}`, sub: 'Nothing differs from it.' }
  return { title: 'No file changes yet', sub: 'Changes appear here.' }
}

/** A commit's age as the compare menu draws it: "12 min ago", "3 h ago", "Yesterday", "4 days ago", then the date. */
export function commitAge(time: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - time) / 1000))
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 2 * 86400) return 'Yesterday'
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`
  const year = new Date(time).getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' as const }
  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...year })
}

// ---------- the pick, for the workspace on screen

/**
 * One pick at a time, for the workspace it was made in, shared by the Changes tab and the diff tabs it opens. It lasts while that workspace
 * is on screen: the route going anywhere else, another workspace included, puts it back to All changes, as a new workspace starts without a filter.
 */
let picked: { workspaceId: string; compare: Compare } | null = null
const listeners = new Set<() => void>()
let unwatch: (() => void) | undefined

const notify = () => { for (const l of listeners) l() }

function forget() {
  picked = null
  unwatch?.()
  unwatch = undefined
  notify()
}

export function setCompare(workspaceId: string, compare: Compare) {
  if (isAll(compare)) { if (picked) forget(); return }
  picked = { workspaceId, compare }
  unwatch ??= watchStore(() => {
    const route = getState().ui.route
    if (picked && !(route.name === 'workspace' && route.workspaceId === picked.workspaceId)) forget()
  })
  notify()
}

const listen = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** The pick for a workspace: All changes unless it was picked in this one. */
export const compareOf = (workspaceId: string): Compare => (picked?.workspaceId === workspaceId ? picked.compare : ALL)

export const useCompare = (workspaceId: string): Compare => useSyncExternalStore(listen, () => compareOf(workspaceId))

type Read = { workspaceId: string; key: string; files?: ChangedFile[]; error?: string }

/**
 * The files of the pick, read again when it changes and whenever `base`, the workspace's own changed files, is read again. For All changes
 * against the base that is `base` itself. `files` is null until the first answer for a pick, and `error` says why a read failed, so a pick
 * is never drawn with another's files.
 */
export function useCompared(ws: Pick<Workspace, 'id'>, base: ChangedFile[]) {
  const compare = useCompare(ws.id)
  const target = useMemo(() => targetOf(compare), [compare])
  const key = targetKey(target)
  const isBase = target.kind === 'base'
  const [read, setRead] = useState<Read | null>(null)
  useEffect(() => {
    if (isBase) return
    let live = true
    call('workspaces.changes', { workspaceId: ws.id, target })
      .then((files) => { if (live) setRead({ workspaceId: ws.id, key, files }) })
      .catch((e) => { if (live) setRead({ workspaceId: ws.id, key, error: cleanError(e) }) })
    return () => { live = false }
  }, [ws.id, key, isBase, base])
  const mine = read?.workspaceId === ws.id && read.key === key ? read : null
  return { compare, target, files: isBase ? base : mine?.files ?? null, error: isBase ? undefined : mine?.error }
}
