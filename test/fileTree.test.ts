import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@shared/types'
import { changesToEntries, folderStatus, openByDefault, visibleRows } from '../src/renderer/src/screens/workspace/tree'
import { gitDecoration } from '../src/renderer/src/screens/workspace/gitStatus'

const dirs = (...paths: string[]): FileEntry[] => paths.map((path) => ({ path, dir: true }))
const tree: FileEntry[] = [
  ...dirs('.claude', '.claude/agents', 'src', 'src/app', 'src/app/invoices'),
  { path: 'src/app/invoices/empty-state.tsx', dir: false, status: 'A' },
  { path: 'src/app/invoices/page.tsx', dir: false, status: 'M' },
  ...dirs('src/db'),
  { path: 'src/db/schema.ts', dir: false },
  { path: 'README.md', dir: false }
]

describe('file tree', () => {
  it('opens the folders above a changed file', () => {
    expect([...openByDefault(tree)]).toEqual(['src', 'src/app', 'src/app/invoices'])
  })

  it('puts a chain of single-child folders on one row that opens the innermost', () => {
    const rows = visibleRows(tree, openByDefault(tree))
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ['.claude/agents', 0], ['src', 0], ['app/invoices', 1], ['empty-state.tsx', 2], ['page.tsx', 2], ['db', 1], ['README.md', 0]
    ])
    expect(rows[2].entry.path).toBe('src/app/invoices')
    expect(rows[3].ancestors).toEqual(['src', 'src/app/invoices'])
  })

  it('keeps every folder on its own row without compact', () => {
    expect(visibleRows(tree, new Set(['src']), false).map((r) => r.entry.path)).toEqual(['.claude', 'src', 'src/app', 'src/db', 'README.md'])
  })

  it('colors a folder by the strongest change inside it', () => {
    const status = folderStatus([...tree, { path: 'src/db/old.ts', dir: false, status: 'D' }])
    expect(status.get('src')).toBe('M')
    expect(status.get('src/db')).toBe('D')
    expect(status.get('src/app')).toBe('M')
    expect(status.get('src/app/invoices')).toBe('M')
    expect(status.get('.claude')).toBeUndefined()
  })

  it('marks untracked files U and deleted ones struck through, as VS Code does', () => {
    expect(gitDecoration('?')).toMatchObject({ letter: 'U', color: 'var(--add)' })
    expect(gitDecoration('D')).toMatchObject({ letter: 'D', struck: true })
    expect(gitDecoration('M')?.color).toBe('var(--mod)')
    expect(gitDecoration(undefined)).toBeUndefined()
  })

  it('builds the Changes tree with the folders above each file, folders first', () => {
    const entries = changesToEntries([
      { path: 'README.md', status: 'M', added: 1, removed: 0 },
      { path: 'src/b.ts', status: 'A', added: 3, removed: 0 },
      { path: 'src/a/c.ts', status: 'D', added: 0, removed: 4 }
    ])
    expect(entries.map((e) => e.path)).toEqual(['src', 'src/a', 'src/a/c.ts', 'src/b.ts', 'README.md'])
    expect(entries.find((e) => e.path === 'src/b.ts')).toEqual({ path: 'src/b.ts', dir: false, status: 'A' })
  })
})
