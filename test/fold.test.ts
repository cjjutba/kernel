import { describe, expect, it } from 'vitest'
import type { Entry, FoldTurn } from '../src/renderer/src/screens/workspace/thread'
import { foldHeader, headerText, settle, wantOpen, windowEntries, WINDOW } from '../src/renderer/src/screens/workspace/fold'

const turn = (p: Partial<FoldTurn> = {}): FoldTurn => ({ live: false, timer: true, short: false, ...p })
const sum = (text: string, bad = '') => ({ text, bad })
const entries = (n: number): Entry[] => Array.from({ length: n }, (_, i) => ({ kind: 'item', item: { kind: 'text', id: `t${i}`, ts: 0, text: `s${i}` } }))

describe('the fold header changes tense', () => {
  it('reads "Working · 43s · running a command" while the turn runs', () => {
    const t = turn({ live: true, startedAt: 1000 })
    expect(headerText(t, sum('Running a command'), 44_000)).toBe('Working · 43s · running a command')
    expect(headerText(t, sum('Working'), 44_000)).toBe('Working · 43s')
  })
  it('reads "Worked for 2m 14s · ran 5 commands, read 3 files" when it ends', () => {
    expect(headerText(turn({ durationMs: 134_000 }), sum('Ran 5 commands, read 3 files'))).toBe('Worked for 2m 14s · ran 5 commands, read 3 files')
    expect(headerText(turn({ durationMs: 12_000 }), sum('Working'))).toBe('Worked for 12s')
    expect(headerText(turn(), sum('Ran 2 commands'))).toBe('Worked · ran 2 commands')
  })
  it('shows only the summary on a later stretch', () => {
    expect(headerText(turn({ timer: false, durationMs: 134_000 }), sum('Ran 2 commands'))).toBe('Ran 2 commands')
    expect(foldHeader(turn({ timer: false, live: true }), sum('Running a command')).clock).toBe(false)
    expect(headerText(turn({ timer: false }), sum('Working'))).toBe('Worked')
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
