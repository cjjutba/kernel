import { describe, expect, it } from 'vitest'
import type { Entry, FoldTurn } from '../src/renderer/src/screens/workspace/thread'
import { foldHeader, settle, wantOpen, windowEntries, WAITING, WINDOW } from '../src/renderer/src/screens/workspace/fold'

const turn = (p: Partial<FoldTurn> = {}): FoldTurn => ({ live: false, timer: true, short: false, ...p })
const sum = (text: string, bad = '') => ({ text, bad })
const entries = (n: number): Entry[] => Array.from({ length: n }, (_, i) => ({ kind: 'item', item: { kind: 'text', id: `t${i}`, ts: 0, text: `s${i}` } }))

describe('the fold header is the summary alone', () => {
  it('has no clock and no "Working" while the turn runs', () => {
    const t = turn({ live: true, startedAt: 1000 })
    expect(foldHeader(t, sum('Read 2 files, ran 2 commands, running 1 more'))).toBe('Read 2 files, ran 2 commands, running 1 more')
    expect(foldHeader(t, sum('Running a command'))).toBe('Running a command')
  })
  it('keeps a plain "Working" for a fold of only messages or thinking', () => {
    expect(foldHeader(turn({ live: true }), sum('Working'))).toBe('Working')
    expect(foldHeader(turn(), sum('Working'))).toBe('Worked')
  })
  it('has no "Worked for" when the turn ends', () => {
    const text = foldHeader(turn({ durationMs: 134_000 }), sum('Ran 5 commands, read 3 files'))
    expect(text).toBe('Ran 5 commands, read 3 files')
    expect(text).not.toMatch(/Worked for|\d+m|\d+s/)
  })
  it('reads the same on a later stretch', () => {
    expect(foldHeader(turn({ timer: false, durationMs: 134_000 }), sum('Ran 2 commands'))).toBe('Ran 2 commands')
  })
})

describe('the line at the end of a running turn', () => {
  it('says "Waiting for you" in place of the clock', () => expect(WAITING).toBe('Waiting for you'))
  it('is never part of a fold header, even while a request waits', () => {
    expect(foldHeader(turn({ live: true, startedAt: 1000 }), sum('Read a file'))).not.toContain(WAITING)
    expect(foldHeader(turn({ live: true, timer: false }), sum('Working'))).toBe('Working')
  })
})

describe('which way a fold goes', () => {
  it('wants open while working in auto, always in open, never in closed', () => {
    expect([wantOpen('auto', true), wantOpen('auto', false)]).toEqual([true, false])
    expect([wantOpen('open', true), wantOpen('open', false)]).toEqual([true, true])
    expect([wantOpen('closed', true), wantOpen('closed', false)]).toEqual([false, false])
  })
  const base = { shown: true, want: false, touched: false, mode: 'auto' as const, away: false, selecting: false }
  it('folds when the turn ends', () => expect(settle(base)).toBe(false))
  it('opens a fold whose turn is working', () => expect(settle({ ...base, shown: false, want: true })).toBe(true))
  it('waits while the reader is scrolled up or holds a selection, then folds', () => {
    expect(settle({ ...base, away: true })).toBe(true)
    expect(settle({ ...base, selecting: true })).toBe(true)
    expect(settle({ ...base, away: false, selecting: false })).toBe(false)
  })
  it("never overrides the reader's own toggle, in any mode", () => {
    for (const mode of ['auto', 'closed', 'open'] as const) {
      expect(settle({ ...base, mode, touched: true })).toBe(true)
      expect(settle({ ...base, mode, touched: true, shown: false, want: true })).toBe(false)
    }
  })
  it('closed and open never wait and never fold on their own', () => {
    expect(settle({ ...base, mode: 'closed', want: false, away: true })).toBe(false)
    expect(settle({ ...base, mode: 'open', want: true, shown: false })).toBe(true)
  })
})

describe('the rolling window', () => {
  it('lists the last 8 steps of a running fold and counts the earlier ones', () => {
    const all = entries(20)
    const w = windowEntries(all, true, false)
    expect(w.shown).toEqual(all.slice(-WINDOW))
    expect(w.earlier).toBe(12)
  })
  it('lists everything once opened, when finished, or when short', () => {
    const all = entries(20)
    expect(windowEntries(all, true, true)).toEqual({ shown: all, earlier: 0 })
    expect(windowEntries(all, false, false)).toEqual({ shown: all, earlier: 0 })
    expect(windowEntries(entries(8), true, false).earlier).toBe(0)
  })
})
