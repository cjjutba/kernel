import type { FileEntry } from '@shared/types'

export interface Row { entry: FileEntry; depth: number; name: string }

/** Directories with a changed file inside start open, like the canvas (src, app, invoices). */
export function openByDefault(tree: FileEntry[]): Set<string> {
  const open = new Set<string>()
  for (const e of tree) {
    if (e.dir || !e.status) continue
    const parts = e.path.split('/')
    for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/'))
  }
  return open
}

export function visibleRows(tree: FileEntry[], open: Set<string>): Row[] {
  const rows: Row[] = []
  for (const entry of tree) {
    const parts = entry.path.split('/')
    let shown = true
    for (let i = 1; i < parts.length; i++) if (!open.has(parts.slice(0, i).join('/'))) { shown = false; break }
    if (shown) rows.push({ entry, depth: parts.length - 1, name: parts[parts.length - 1] })
  }
  return rows
}

