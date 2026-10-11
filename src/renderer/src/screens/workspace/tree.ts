import type { ChangedFile, FileEntry } from '@shared/types'
import { strongest, type GitStatus } from './gitStatus'

/** A visible row. `name` is the folder chain for a compact row (`src/renderer/src`), and `ancestors` are the paths of the rows it sits under, outermost first. */
export interface Row { entry: FileEntry; depth: number; name: string; ancestors: string[] }

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const parentOf = (path: string) => { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i) }
const dirsAbove = (path: string) => { const parts = path.split('/'); return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/')) }

/** Directories with a changed file inside start open, like the canvas (src, app, invoices). */
export function openByDefault(tree: FileEntry[]): Set<string> {
  const open = new Set<string>()
  for (const e of tree) if (!e.dir && e.status) for (const dir of dirsAbove(e.path)) open.add(dir)
  return open
}

/**
 * The rows to draw, in tree order. A folder's children show while it is open. With `compact`, a folder whose only child is a folder
 * shares its row with that child, as VS Code's compact folders do, and the row opens and closes the innermost one (KERNEL-399).
 */
export function visibleRows(tree: FileEntry[], open: Set<string>, compact = true): Row[] {
  const kids = new Map<string, FileEntry[]>()
  for (const e of tree) { const p = parentOf(e.path); const list = kids.get(p); if (list) list.push(e); else kids.set(p, [e]) }
  const rows: Row[] = []
  const walk = (parent: string, ancestors: string[]) => {
    for (const first of kids.get(parent) ?? []) {
      let entry = first
      let name = base(first.path)
      for (let only = kids.get(entry.path); compact && entry.dir && only?.length === 1 && only[0].dir; only = kids.get(entry.path)) {
        entry = only[0]
        name += `/${base(entry.path)}`
      }
      rows.push({ entry, depth: ancestors.length, name, ancestors })
      if (entry.dir && open.has(entry.path)) walk(entry.path, [...ancestors, entry.path])
    }
  }
  walk('', [])
  return rows
}

/** The status each folder shows for the changed files inside it, modified over deleted over the rest. */
export function folderStatus(tree: FileEntry[]): Map<string, GitStatus> {
  const out = new Map<string, GitStatus>()
  for (const e of tree) if (!e.dir && e.status) for (const dir of dirsAbove(e.path)) out.set(dir, strongest(out.get(dir), e.status))
  return out
}

/** Siblings sort folders first, then by name, as the All files tree does. Walking path segments keeps a folder next to its children. */
function compare(a: FileEntry, b: FileEntry): number {
  const x = a.path.split('/'), y = b.path.split('/')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    const aDir = i < x.length - 1 || a.dir, bDir = i < y.length - 1 || b.dir
    if (aDir !== bDir) return aDir ? -1 : 1
    return x[i].localeCompare(y[i])
  }
  return x.length - y.length
}

/** The changed files as a tree, with the folders above them, for the Changes tab's tree view. */
export function changesToEntries(changes: ChangedFile[]): FileEntry[] {
  const entries = new Map<string, FileEntry>()
  for (const c of changes) {
    for (const dir of dirsAbove(c.path)) if (!entries.has(dir)) entries.set(dir, { path: dir, dir: true })
    entries.set(c.path, { path: c.path, dir: false, status: c.status })
  }
  return [...entries.values()].sort(compare)
}
