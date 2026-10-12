import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@shared/types'
import { filterEntries, filterQuery, matchRanges, matchesPath } from '../src/renderer/src/screens/workspace/panelFilter'
import { visibleRows } from '../src/renderer/src/screens/workspace/tree'
import { checksUrl } from '../src/renderer/src/screens/workspace/Panels'
import { Marked } from '../src/renderer/src/screens/workspace/PanelTools'

const dirs = (...paths: string[]): FileEntry[] => paths.map((path) => ({ path, dir: true }))
const files = (...paths: string[]): FileEntry[] => paths.map((path) => ({ path, dir: false }))
const tree: FileEntry[] = [
  ...dirs('docs', 'docs/decisions', 'src', 'src/main', 'src/renderer', 'src/renderer/src', 'src/renderer/src/screens', 'src/renderer/src/screens/inbox', 'test'),
  ...files('docs/PRODUCT.md', 'docs/decisions/KERNEL-155.md', 'src/main/db.ts', 'src/main/inbox.ts', 'src/renderer/src/screens/inbox/Inbox.tsx', 'src/renderer/src/store.ts', 'test/inbox.test.ts', 'README.md')
]

describe('panel filter', () => {
  it('matches the path in any case, folders included, and an empty query matches everything', () => {
    expect(filterQuery('  Inbox ')).toBe('inbox')
    expect(matchesPath('src/shared/Inbox.ts', 'inbox')).toBe(true)
    expect(matchesPath('src/shared/ipc.ts', 'inbox')).toBe(false)
    expect(matchesPath('src/renderer/src/screens/inbox/Row.tsx', 'screens/inbox')).toBe(true)
    expect(matchesPath('anything', '')).toBe(true)
  })

  it('finds every match in a path for the highlight', () => {
    expect(matchRanges('src/renderer/src/screens/inbox/Inbox.tsx', 'inbox')).toEqual([[25, 30], [31, 36]])
    expect(matchRanges('src/main/db.ts', 'inbox')).toEqual([])
    expect(matchRanges('src/main/db.ts', '')).toEqual([])
  })

  it('keeps the matches and the folders above them, drawn open', () => {
    const { entries, dirs: open } = filterEntries(tree, 'inbox')
    expect(entries.map((e) => e.path)).toEqual([
      'src', 'src/main', 'src/renderer', 'src/renderer/src', 'src/renderer/src/screens', 'src/renderer/src/screens/inbox', 'test',
      'src/main/inbox.ts', 'src/renderer/src/screens/inbox/Inbox.tsx', 'test/inbox.test.ts'
    ])
    expect([...open]).toEqual(['src', 'src/main', 'src/renderer', 'src/renderer/src', 'src/renderer/src/screens', 'src/renderer/src/screens/inbox', 'test'])
    expect(visibleRows(entries, open).map((r) => r.name)).toEqual(['src', 'main', 'inbox.ts', 'renderer/src/screens/inbox', 'Inbox.tsx', 'test', 'inbox.test.ts'])
  })

  it('keeps a matching folder with everything in it', () => {
    const { entries, dirs: open } = filterEntries(tree, 'decisions')
    expect(entries.map((e) => e.path)).toEqual(['docs', 'docs/decisions', 'docs/decisions/KERNEL-155.md'])
    expect([...open]).toEqual(['docs', 'docs/decisions'])
  })

  it('leaves nothing when nothing matches', () => {
    expect(filterEntries(tree, 'zzz')).toEqual({ entries: [], dirs: new Set() })
  })
})

describe('the highlight', () => {
  const lit = (text: string, from: number, path: string, query: string) => renderToStaticMarkup(createElement(Marked, { text, from, ranges: matchRanges(path, query) }))

  it('lights the match in the name and in the folder', () => {
    const path = 'src/renderer/src/screens/inbox/Inbox.tsx'
    expect(lit('src/renderer/src/screens/inbox', 0, path, 'inbox')).toBe('src/renderer/src/screens/<mark class="hl">inbox</mark>')
    expect(lit('Inbox.tsx', 31, path, 'inbox')).toBe('<mark class="hl">Inbox</mark>.tsx')
  })

  it('lights both sides of a match that crosses the slash', () => {
    const path = 'src/main/features/inbox.ts'
    expect(lit('src/main/features', 0, path, 'features/inbox')).toBe('src/main/<mark class="hl">features</mark>')
    expect(lit('inbox.ts', 18, path, 'features/inbox')).toBe('<mark class="hl">inbox</mark>.ts')
  })

  it('leaves text with no match as it is', () => {
    expect(lit('db.ts', 9, 'src/main/db.ts', 'inbox')).toBe('db.ts')
  })
})

describe('the Checks tab link', () => {
  it('is the PR page on GitHub with /checks, and nothing without a PR', () => {
    expect(checksUrl('https://github.com/samrivera/client-a/pull/147')).toBe('https://github.com/samrivera/client-a/pull/147/checks')
    expect(checksUrl('https://github.com/samrivera/client-a/pull/147/')).toBe('https://github.com/samrivera/client-a/pull/147/checks')
    expect(checksUrl(undefined)).toBeUndefined()
    expect(checksUrl('')).toBeUndefined()
  })
})
