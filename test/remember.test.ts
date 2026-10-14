import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A choice the user makes stays until they change it (DESIGN.md, Remembered choices). Screens keep one through `remember.ts`, so each
// gets the same guards: storage missing or blocked, junk stored, fixture mode. store.ts and the draft store keep their own, older files.
const root = join(__dirname, '..')
const OWN = ['src/renderer/src/remember.ts', 'src/renderer/src/store.ts', 'src/renderer/src/screens/workspace/composer/draftStore.ts']

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name)
  if (e.isDirectory()) return files(p)
  return /\.(tsx?|jsx?)$/.test(e.name) ? [p] : []
})

let disk: Map<string, string>
async function launch(fixture = false) {
  vi.resetModules()
  const store = await import('../src/renderer/src/store')
  vi.spyOn(store, 'isFixture').mockReturnValue(fixture)
  return import('../src/renderer/src/remember')
}

beforeEach(() => {
  disk = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('remembered choices', () => {
  it('only remember.ts, store.ts and the draft store touch localStorage in the renderer', () => {
    const hits = files(join(root, 'src/renderer/src'))
      .filter((f) => !OWN.includes(f.slice(root.length + 1)))
      .flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (/\blocalStorage\s*\.\s*(getItem|setItem|removeItem|clear|key)\b/.test(line) ? [`${f.slice(root.length + 1)}:${i + 1}`] : [])))
    expect(hits).toEqual([])
  })

  it('reads back what it wrote, removes on null, and parses junk as nothing', async () => {
    const r = await launch()
    r.writeSaved('kernel.a', 'x')
    expect([r.readSaved('kernel.a'), disk.get('kernel.a')]).toEqual(['x', 'x'])
    r.writeSaved('kernel.a', null)
    expect(disk.has('kernel.a')).toBe(false)
    disk.set('kernel.j', '{not json')
    expect(r.readSavedJson('kernel.j', (v) => v ?? 'fallback')).toBe('fallback')
    expect(r.oneOf(['all', 'needs'] as const, 'all')('bogus')).toBe('all')
  })

  it('keeps a choice in memory when localStorage throws', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } })
    const r = await launch()
    r.writeSaved('kernel.a', 'x')
    expect(r.readSaved('kernel.a')).toBe('x')
  })

  it('neither reads nor writes what a real launch saved in fixture mode', async () => {
    disk.set('kernel.a', 'real')
    const r = await launch(true)
    expect(r.readSaved('kernel.a')).toBeNull()
    r.writeSaved('kernel.a', 'shot')
    expect([r.readSaved('kernel.a'), disk.get('kernel.a')]).toEqual(['shot', 'real'])
  })
})
