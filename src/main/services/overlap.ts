import type { Overlap, Workspace } from '@shared/types'
import { bus } from '../bus'
import { git } from './exec'
import { changedFiles, overlaps as sharedPaths } from './worktrees'

/** Collapse sorted line numbers into "lines 20-34, 50" (FloorOverlap.png). */
export function formatRanges(ranges: [number, number][]): string {
  const merged: [number, number][] = []
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  if (!merged.length) return 'lines changed'
  const text = merged.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(', ')
  return merged.length === 1 && merged[0][0] === merged[0][1] ? `line ${text}` : `lines ${text}`
}

/** The lines of `file` this workspace touched since `since`, read from the hunk headers of a zero-context diff. */
export async function lineRanges(cwd: string, since: string, file: string, added = 0): Promise<string> {
  const out = await git(cwd, 'diff', '-U0', since, '--', file).catch(() => '')
  const ranges: [number, number][] = []
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    // A pure deletion has count 0 and sits between two lines: point at the line before the gap.
    ranges.push(count === 0 ? [Math.max(start, 1), Math.max(start, 1)] : [start, start + count - 1])
  }
  // A new file the diff cannot see yet (untracked) counts as all of its lines.
  if (!ranges.length && added > 0) ranges.push([1, added])
  return formatRanges(ranges)
}

export interface OverlapDeps {
  /** Every workspace of the room. */
  workspaces: (roomId: string) => Workspace[]
  /** What to diff a workspace against: its merge-base for a worktree, its baseline for a current-branch workspace. */
  since: (ws: Workspace) => Promise<string>
  /** The Lead is who "flags" the overlap in the log. */
  leadId: (roomId: string) => string | undefined
}

const live = (w: Workspace) => w.status === 'ready' && !w.mergedAt && w.prState !== 'merged' && w.prState !== 'closed'
const base = (p: string) => p.split('/').pop() ?? p

/**
 * Two workspaces changing the same file will conflict at merge, so the floor says so (KERNEL-24).
 * `check` runs after each turn and when a workspace merges or is archived: it compares the changed files of the room's open
 * workspaces, raises an Overlap for each shared file, and clears it when the overlap goes away. Dismissing one (`resolve`) keeps it
 * quiet until it clears and comes back.
 */
export class Overlaps {
  private known = new Map<string, Overlap>()
  private chain = new Map<string, Promise<unknown>>()

  constructor(private d: OverlapDeps) {}

  list(roomId: string): Overlap[] {
    return [...this.known.values()].filter((o) => o.roomId === roomId).sort((a, b) => b.ts - a.ts)
  }

  get(id: string): Overlap | undefined {
    return this.known.get(id)
  }

  /** One check at a time per room, so two turns ending together cannot raise the same overlap twice. */
  check(roomId: string): Promise<Overlap[]> {
    const next = (this.chain.get(roomId) ?? Promise.resolve()).catch(() => undefined).then(() => this.run(roomId))
    this.chain.set(roomId, next)
    return next
  }

  /** The user handed it to the Lead: it stays on record but leaves the floor. */
  resolve(id: string): Overlap | undefined {
    const o = this.known.get(id)
    if (!o) return undefined
    const next = { ...o, resolved: true }
    this.known.set(id, next)
    bus.push({ type: 'overlap', overlap: next })
    return next
  }

  forget(roomId: string) {
    for (const [id, o] of this.known) if (o.roomId === roomId) this.known.delete(id)
  }

  private async run(roomId: string): Promise<Overlap[]> {
    const open = this.d.workspaces(roomId).filter(live).sort((a, b) => a.createdAt - b.createdAt)
    const files = new Map<string, Awaited<ReturnType<typeof changedFiles>>>()
    const since = new Map<string, string>()
    await Promise.all(open.map(async (w) => {
      try {
        const ref = await this.d.since(w)
        since.set(w.id, ref)
        files.set(w.id, await changedFiles(w.path, ref))
      } catch { files.set(w.id, []) }
    }))

    const byPath = new Map<string, Workspace[]>()
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        for (const path of sharedPaths(files.get(open[i].id) ?? [], files.get(open[j].id) ?? [])) {
          const list = byPath.get(path) ?? []
          for (const w of [open[i], open[j]]) if (!list.includes(w)) list.push(w)
          byPath.set(path, list)
        }
      }
    }

    const now = new Set<string>()
    for (const [path, parties] of byPath) {
      const id = `ov:${roomId}:${path}`
      now.add(id)
      const before = this.known.get(id)
      const overlap: Overlap = {
        id, roomId, path, ts: before?.ts ?? Date.now(), resolved: before?.resolved,
        parties: await Promise.all(parties.map(async (w) => ({
          agentId: w.agentId, workspaceId: w.id,
          lines: await lineRanges(w.path, since.get(w.id) ?? 'HEAD', path, files.get(w.id)?.find((f) => f.path === path)?.added)
        })))
      }
      const same = before && JSON.stringify(before.parties) === JSON.stringify(overlap.parties)
      this.known.set(id, overlap)
      if (same) continue
      bus.push({ type: 'overlap', overlap })
      if (!before) {
        bus.activity({
          kind: 'overlap', roomId, agentId: this.d.leadId(roomId), text: 'flagged an overlap in', object: base(path), warn: true,
          data: { overlapId: id, path, workspaceIds: overlap.parties.map((p) => p.workspaceId) }
        })
      }
    }

    // Gone: a workspace merged or was archived, or the agents stopped touching the same file.
    for (const [id, o] of [...this.known]) {
      if (o.roomId !== roomId || now.has(id)) continue
      this.known.delete(id)
      bus.push({ type: 'overlap', overlap: { ...o, resolved: true } })
    }
    return this.list(roomId)
  }
}
