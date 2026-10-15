import type { ToolCalls } from '@shared/types'
import { WORKING, type Entry, type FoldTurn, type Summary } from './thread'

/** An open fold of a running turn lists this many of its newest steps, and a row above them opens the rest. */
export const WINDOW = 8

/** What the line at the end of a running turn says while a request waits on the reader, in place of the ticking time. */
export const WAITING = 'Waiting for you'

/**
 * A fold's header is its summary alone, in the tense of its turn: "Read 2 files, ran 2 commands, running 1 more" while it runs, "Ran 5 commands, read 3 files"
 * when it is done. The clock and "Waiting for you" are on the line at the end of the turn (`TurnLine`), and the duration is under the reply. A fold of only
 * messages or thinking has no summary, so it reads "Working" while it runs and "Worked" after.
 */
export function foldHeader(turn: FoldTurn, summary: Summary): string {
  if (summary.text !== WORKING) return summary.text
  return turn.live ? WORKING : 'Worked'
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
