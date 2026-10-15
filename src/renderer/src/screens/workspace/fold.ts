import type { ToolCalls } from '@shared/types'
import { fmtDuration, WORKING, type Entry, type FoldTurn, type Summary } from './thread'

/** An open fold of a running turn lists this many of its newest steps, and a row above them opens the rest. */
export const WINDOW = 8

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/**
 * A fold's header is one row that changes tense. Running: "Working · 43s · running a command", with the clock drawn live (`clock`). Done:
 * "Worked for 2m 14s · ran 5 commands, read 3 files". Only the turn's first fold carries the time; the others show their summary alone.
 * A fold of only messages or thinking has no summary to add.
 */
export function foldHeader(turn: FoldTurn, summary: Summary): { head: string; clock: boolean; tail: string } {
  const bare = summary.text === WORKING
  const tail = bare ? '' : lower(summary.text)
  if (!turn.timer) return { head: bare ? (turn.live ? WORKING : 'Worked') : summary.text, clock: false, tail: '' }
  if (turn.live) return { head: WORKING, clock: turn.startedAt !== undefined, tail }
  return { head: turn.durationMs === undefined ? 'Worked' : `Worked for ${fmtDuration(turn.durationMs)}`, clock: false, tail }
}

/** The header as one string, for a screen reader and for tests. `now` is the live clock's time. */
export function headerText(turn: FoldTurn, summary: Summary, now = Date.now()): string {
  const h = foldHeader(turn, summary)
  const clock = h.clock && turn.startedAt !== undefined ? fmtDuration(now - turn.startedAt) : ''
  return [h.head, clock, h.tail].filter(Boolean).join(' · ')
}

/** Whether a fold wants to be open, before the reader's own toggle: while its turn runs in `auto`, always in `open`, never in `closed`. */
export const wantOpen = (mode: ToolCalls, live: boolean) => (mode === 'open' ? true : mode === 'closed' ? false : live)

interface Settle { shown: boolean; want: boolean; touched: boolean; mode: ToolCalls; away: boolean; selecting: boolean }

/**
 * Whether an untouched fold shows its steps. `auto` opens on the turn's steps and folds when the turn ends, but never under the reader: while they
 * are scrolled away from the end or hold a selection in the fold, it stays as it is until they are back and the selection is gone. The other two
 * modes never wait. The reader's own toggle (`touched`) is not this function's to override.
 */
export function settle({ shown, want, touched, mode, away, selecting }: Settle): boolean {
  if (touched) return shown
  if (mode !== 'auto' || want) return want
  return shown && (away || selecting) ? true : false
}

/** The rows a fold lists. A running, open fold lists its newest `WINDOW` steps, and `earlier` counts the ones behind a row at the top. A finished fold, and one the reader opened the rest of, lists all. */
export function windowEntries(entries: Entry[], live: boolean, all: boolean): { shown: Entry[]; earlier: number } {
  if (!live || all || entries.length <= WINDOW) return { shown: entries, earlier: 0 }
  return { shown: entries.slice(-WINDOW), earlier: entries.length - WINDOW }
}
