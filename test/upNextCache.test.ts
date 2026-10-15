import { beforeEach, describe, expect, it } from 'vitest'
import type { IssueSummary } from '../src/shared/types'
import { clearUpNext, readUpNext, storeUpNext } from '../src/renderer/src/screens/workspace/upNextCache'

const issue = (id: string): IssueSummary => ({ id, title: `Title ${id}`, url: `https://x/${id}` }) as IssueSummary

describe('Up next cache', () => {
  beforeEach(() => clearUpNext())

  it('is empty until a refresh succeeds, per project', () => {
    expect(readUpNext('a')).toBeUndefined()
    storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    expect(readUpNext('a')?.rows).toHaveLength(1)
    expect(readUpNext('b')).toBeUndefined()
  })

  it('keeps the same entry when a refresh finds the same issues', () => {
    const first = storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    expect(storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })).toBe(first)
  })

  it('replaces the entry when the list or the tracker differs', () => {
    storeUpNext('a', { kind: 'linear', rows: [issue('K-1')] })
    expect(storeUpNext('a', { kind: 'linear', rows: [issue('K-2')] }).rows[0].id).toBe('K-2')
    expect(storeUpNext('a', { kind: 'github', rows: [issue('K-2')] }).kind).toBe('github')
    expect(readUpNext('a')?.kind).toBe('github')
  })
})
