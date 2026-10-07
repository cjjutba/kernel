import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ChangedFile, FileEntry } from '@shared/types'
import { git } from './exec'

const MAX_ENTRIES = 5000
export const MAX_FILE_BYTES = 1024 * 1024

/**
 * The All files tree: every tracked file and every untracked file git does not ignore, plus the directories above them.
 * Files in `changed` carry their change status. Directories first, then files, each sorted by name.
 */
export async function listTree(root: string, changed: ChangedFile[] = []): Promise<FileEntry[]> {
  const out = await git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
  const files = [...new Set(out.split('\0').filter(Boolean))].slice(0, MAX_ENTRIES)
  const status = new Map(changed.map((c) => [c.path, c.status]))
  const entries = new Map<string, FileEntry>()
  for (const file of files) {
    const parts = file.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!entries.has(dir)) entries.set(dir, { path: dir, dir: true })
    }
    entries.set(file, { path: file, dir: false, ...(status.has(file) ? { status: status.get(file) } : {}) })
  }
  return [...entries.values()].sort(compare)
}

/** Siblings sort directories first. Walking path segments keeps a directory next to its own children. */
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

/** Text of one file in the worktree, for the file viewer. Refuses paths outside it (symlinks included), big files and binaries. */
export async function readWorkspaceFile(root: string, path: string): Promise<string> {
  const outside = () => new Error('That file is outside this workspace.')
  if (!path) throw outside()
  const base = await realpath(root)
  const full = await realpath(resolve(base, path)).catch(() => null)
  if (!full) throw new Error(`${path} is not a file in this workspace.`)
  const rel = relative(base, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw outside()
  const info = await stat(full)
  if (!info.isFile()) throw new Error(`${path} is not a file in this workspace.`)
  if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is too large to preview (${Math.round(info.size / 1024)} KB).`)
  const buf = await readFile(full)
  if (buf.includes(0)) throw new Error(`${path} is a binary file.`)
  return buf.toString('utf8')
}
