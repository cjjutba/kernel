import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IssueSummary } from '../src/shared/types'

const issue = (id: string): IssueSummary => ({ id, title: `Title ${id}`, url: `https://x/${id}` }) as IssueSummary

let disk: Map<string, string>
let invoke: ReturnType<typeof vi.fn>
/** A fresh renderer launch: modules reload, so the memory cache starts empty and only `disk` carries over. */
async function launch() {
  vi.resetModules()
  const store = await import('../src/renderer/src/store')
  vi.spyOn(store, 'isFixture').mockReturnValue(false)
  return import('../src/renderer/src/screens/workspace/upNextCache')
}

beforeEach(() => {
  disk = new Map()
  invoke = vi.fn()
  vi.stubGlobal('localStorage', { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) })
  vi.stubGlobal('window', { kernel: { invoke } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Up next cache', () => {
  it('is empty until a refresh succeeds, per project', async () => {
    const { readUpNext, storeUpNext } = await launch()
    expect(readUpNext('a')).toBeUndefined()
    storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    expect(readUpNext('a')?.rows).toHaveLength(1)
    expect(readUpNext('b')).toBeUndefined()
  })

  it('keeps the same entry when a refresh finds the same issues', async () => {
    const { storeUpNext } = await launch()
    const first = storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    expect(storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })).toBe(first)
  })

  it('replaces the entry when the list or the tracker differs', async () => {
    const { readUpNext, storeUpNext } = await launch()
    storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    expect(storeUpNext('a', { kind: 'linear', rows: [issue('K-2')] }).rows[0].id).toBe('K-2')
    expect(storeUpNext('a', { kind: 'github', rows: [issue('K-2')] }).kind).toBe('github')
    expect(readUpNext('a')?.kind).toBe('github')
  })

  it('starts from the saved list after a restart', async () => {
    const first = await launch()
    first.storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    first.storeUpNext('b', { kind: 'github', rows: [issue('G-1')] })
    const second = await launch()
    expect(second.readUpNext('a')).toEqual({ kind: 'linear', rows: [issue('K-1')] })
    expect(second.readUpNext('b')?.kind).toBe('github')
  })

  it('treats a corrupt saved entry as no cache', async () => {
    for (const junk of ['{not json', '[]', '"x"', JSON.stringify({ a: { rows: 'nope' }, b: { rows: [{ id: 1 }] }, c: null })]) {
      disk.set('upNext', junk)
      const { readUpNext, storeUpNext } = await launch()
      for (const id of ['a', 'b', 'c']) expect(readUpNext(id)).toBeUndefined()
      expect(storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] }).rows).toHaveLength(1)
    }
  })

  it('works when storage throws', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } })
    const { readUpNext, storeUpNext } = await launch()
    expect(readUpNext('a')).toBeUndefined()
    storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    expect(readUpNext('a')?.rows).toHaveLength(1)
  })

  it('clears the memory and the saved copy', async () => {
    const first = await launch()
    first.storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    first.clearUpNext()
    expect(first.readUpNext('a')).toBeUndefined()
    expect((await launch()).readUpNext('a')).toBeUndefined()
  })
})

describe('refreshUpNext', () => {
  const answer = (next: IssueSummary[] | Error, tracker: { kind?: string } | Error) =>
    invoke.mockImplementation(async (channel: string) => {
      const r = channel === 'issues.next' ? next : tracker
      if (r instanceof Error) throw r
      return r
    })

  it('stores what both calls return and saves it', async () => {
    answer([issue('K-1')], { kind: 'linear' })
    const { refreshUpNext, readUpNext } = await launch()
    expect(await refreshUpNext('a')).toEqual({ kind: 'linear', rows: [issue('K-1')] })
    expect(readUpNext('a')?.kind).toBe('linear')
    expect(JSON.parse(disk.get('upNext') ?? '{}').a.rows).toHaveLength(1)
  })

  it('returns the same entry when nothing changed', async () => {
    answer([issue('K-1')], { kind: 'linear' })
    const { refreshUpNext } = await launch()
    const first = await refreshUpNext('a')
    expect(await refreshUpNext('a')).toBe(first)
  })

  it('keeps the saved rows when a refresh fails', async () => {
    const first = await launch()
    first.storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    answer(new Error('offline'), new Error('offline'))
    const second = await launch()
    expect((await second.refreshUpNext('a'))?.rows).toEqual([issue('K-1')])
    answer(new Error('offline'), { kind: 'linear' })
    expect((await second.refreshUpNext('a'))?.rows).toEqual([issue('K-1')])
  })

  it('holds nothing for a project with no tracker', async () => {
    answer([], {})
    const { refreshUpNext } = await launch()
    expect(await refreshUpNext('a')).toEqual({ kind: undefined, rows: [] })
  })
})
