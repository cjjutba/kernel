import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL, commitAge, compareEmpty, compareLabel, compareNote, compareTitle, targetOf, type Compare } from '../src/renderer/src/screens/workspace/compare'

const uncommitted: Compare = { only: { kind: 'uncommitted' } }
const commit: Compare = { only: { kind: 'commit', sha: '3e1f9a2c5d8b04f7a61e9d3c2b8a5f40d17e6c93' } }

describe('the Changes ⋯ menu pick', () => {
  it('asks the engine for the base by default, and for the other picks as they are', () => {
    expect(targetOf(ALL)).toEqual({ kind: 'base' })
    expect(targetOf({ branch: 'origin/develop' })).toEqual({ kind: 'branch', ref: 'origin/develop' })
    expect(targetOf(uncommitted)).toEqual({ kind: 'uncommitted' })
    expect(targetOf(commit)).toEqual({ kind: 'commit', sha: '3e1f9a2c5d8b04f7a61e9d3c2b8a5f40d17e6c93' })
  })

  it('keeps the branch picked while a narrower pick is on, but the narrower pick is what is read', () => {
    expect(targetOf({ branch: 'origin/develop', ...uncommitted })).toEqual({ kind: 'uncommitted' })
  })

  it('says what the count line, the diff tab and an empty list compare, and nothing for the default', () => {
    expect(compareNote(ALL)).toBe('')
    expect(compareNote({ branch: 'origin/develop' })).toBe('against origin/develop')
    expect(compareNote(uncommitted)).toBe('since the last commit')
    expect(compareNote(commit)).toBe('in 3e1f9a2')
    expect(compareTitle(ALL)).toBe('All changes')
    expect(compareTitle({ branch: 'origin/develop' })).toBe('All changes against origin/develop')
    expect(compareTitle(uncommitted)).toBe('Uncommitted changes')
    expect(compareTitle(commit)).toBe('Commit 3e1f9a2')
    expect(compareEmpty(ALL).title).toBe('No file changes yet')
    expect(compareEmpty(uncommitted).title).toBe('Nothing uncommitted')
    expect(compareEmpty({ branch: 'origin/develop' }).title).toBe('No changes against origin/develop')
    expect(compareEmpty(commit).title).toBe('No file changes')
  })

  it('labels the Compare button with the base branch, without its remote', () => {
    expect(compareLabel({ baseRef: 'origin/main' }, ALL)).toBe('Against main')
    expect(compareLabel({ baseRef: 'main' }, { branch: 'origin/develop' })).toBe('Against develop')
    expect(compareLabel({ baseRef: 'main' }, uncommitted)).toBe('Uncommitted')
    expect(compareLabel({ baseRef: 'main' }, commit)).toBe('Commit 3e1f9a2')
  })
})

describe('a commit\'s age in the menu', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime()
  const ago = (ms: number) => commitAge(now - ms, now)
  it('counts minutes, then hours, then says Yesterday, then days', () => {
    expect(ago(20_000)).toBe('Just now')
    expect(ago(12 * 60_000)).toBe('12 min ago')
    expect(ago(60 * 60_000)).toBe('1 h ago')
    expect(ago(3 * 3600_000)).toBe('3 h ago')
    expect(ago(30 * 3600_000)).toBe('Yesterday')
    expect(ago(4 * 86400_000)).toBe('4 days ago')
  })
  it('gives the date after a week, with the year only when it is another one', () => {
    expect(ago(20 * 86400_000)).toBe('Sep 22')
    expect(ago(400 * 86400_000)).toBe('Sep 7, 2025')
  })
  it('never reads a clock that is a little ahead as the future', () => {
    expect(commitAge(now + 5000, now)).toBe('Just now')
  })
})

describe('the pick lasts while its workspace is on screen', () => {
  let disk: Map<string, string>
  beforeEach(() => {
    disk = new Map()
    vi.stubGlobal('localStorage', { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) })
  })
  afterEach(() => vi.unstubAllGlobals())

  /** A fresh store and pick, as a new launch. */
  async function launch() {
    vi.resetModules()
    const store = await import('../src/renderer/src/store')
    const compare = await import('../src/renderer/src/screens/workspace/compare')
    const show = (workspaceId: string) => store.setState((s) => ({ ui: { ...s.ui, route: { name: 'workspace', workspaceId } } }))
    return { store, show, ...compare }
  }

  it('is All changes until a pick is made, and only in the workspace it was made in', async () => {
    const { ALL, show, setCompare, compareOf } = await launch()
    show('ws-a')
    expect(compareOf('ws-a')).toBe(ALL)
    setCompare('ws-a', uncommitted)
    expect(compareOf('ws-a')).toBe(uncommitted)
    expect(compareOf('ws-b')).toBe(ALL)
  })

  it('goes back to All changes when another workspace comes on screen, and stays gone on the way back', async () => {
    const { ALL, show, setCompare, compareOf } = await launch()
    show('ws-a')
    setCompare('ws-a', commit)
    show('ws-b')
    expect(compareOf('ws-a')).toBe(ALL)
    show('ws-a')
    expect(compareOf('ws-a')).toBe(ALL)
  })

  it('goes back to All changes when the route leaves the workspace, and is kept through changes that are not a route', async () => {
    const { ALL, store, show, setCompare, compareOf } = await launch()
    show('ws-a')
    setCompare('ws-a', { branch: 'origin/develop' })
    store.setState((s) => ({ ui: { ...s.ui, toasts: [] } }))
    expect(compareOf('ws-a')).toEqual({ branch: 'origin/develop' })
    store.setState((s) => ({ ui: { ...s.ui, route: { name: 'projects' } } }))
    expect(compareOf('ws-a')).toBe(ALL)
  })

  it('forgets a pick that is put back to All changes, with or without the branch', async () => {
    const { ALL, show, setCompare, compareOf } = await launch()
    show('ws-a')
    setCompare('ws-a', uncommitted)
    setCompare('ws-a', ALL)
    expect(compareOf('ws-a')).toBe(ALL)
    setCompare('ws-a', { branch: undefined })
    expect(compareOf('ws-a')).toBe(ALL)
  })
})
