import type { Workspace } from '@shared/types'
import { stripRemote } from '../../settings/remote'

/** One row of the branch menu. `ref` is what picking sets as the base, `name` what the row shows, without the remote. */
export interface BranchRow {
  ref: string
  name: string
  /** "8d", "40m": since the branch's last commit. Empty when git gave no time. */
  age: string
  tag: 'default' | 'has a workspace' | 'remote' | ''
  /** The open workspace on this branch, for Open workspace. */
  workspaceId?: string
}

/** "40m", "3h", "8d", then weeks from a month on ("6w"): tight, for the line under a branch. */
export function ageOf(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (86400 * 7))}w`
}

/**
 * The rows the menu offers: the default first, then every branch git lists, newest first. That is the remote's branches and the repo's
 * own, which the New workspace modal's From popover offered (KERNEL-788 removes it). A branch on both shows once, as the remote's.
 * A tag says why a branch is worth a look: it is the default, an open workspace is on it, or it lives on the remote. A local branch
 * nobody has a workspace on gets none.
 */
export function branchRows({ list, fallback, remote, workspaces, roomId, now }: {
  list: { name: string; committedAt: number }[]; fallback: string; remote: string; workspaces: Pick<Workspace, 'id' | 'roomId' | 'branch' | 'status'>[]; roomId: string; now?: number
}): BranchRow[] {
  const open = workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived')
  const rows = new Map<string, BranchRow>()
  const add = (ref: string, committedAt?: number) => {
    const name = stripRemote(ref, remote)
    if (rows.has(name) && !ref.startsWith(`${remote}/`)) return
    const workspaceId = open.find((w) => w.branch === name)?.id
    const tag = ref === fallback ? 'default' : workspaceId ? 'has a workspace' : ref.startsWith(`${remote}/`) ? 'remote' : ''
    rows.set(name, { ref, name, age: committedAt ? ageOf(committedAt, now) : '', tag, ...(workspaceId ? { workspaceId } : {}) })
  }
  const time = new Map(list.map((b) => [b.name, b.committedAt]))
  add(fallback, time.get(fallback))
  for (const b of list) if (b.name !== `${remote}/HEAD`) add(b.name, b.committedAt)
  const first = stripRemote(fallback, remote)
  return [...rows.values()].sort((a, b) => (a.name === first ? -1 : b.name === first ? 1 : 0))
}

/** The line under a branch's name: its age and its tag, "8d · default". */
export const branchLine = (r: BranchRow) => [r.age, r.tag].filter(Boolean).join(' · ')
