import type { ScriptKind, ScriptLine } from './types'

/**
 * How much script and terminal output is kept. The window keeps it for the screen, and main keeps the same amount so a
 * window that reloads or reopens gets it back (KERNEL-340). Both trim with these, so the two copies match.
 */
export const SCRIPT_LINES = 400
/** Characters of output kept for each terminal, and for each script's terminal output (KERNEL-655). */
export const TERMINAL_KEEP = 200_000

/** The size a script's terminal starts at, before a view resizes it (KERNEL-655). */
export const SCRIPT_COLS = 120
export const SCRIPT_ROWS = 30

/** `kept` with a script's or terminal's new output added, trimmed to its last `TERMINAL_KEEP` characters. */
export const keepData = (kept: string | undefined, data: string) => ((kept ?? '') + data).slice(-TERMINAL_KEEP)

/** A run script's name, `run` for the default one. Setup and archive have none. */
export const runName = (kind: ScriptKind, name?: string) => (kind === 'run' ? name ?? 'run' : undefined)

/**
 * Where a script's exit code lives: `setup`, `archive`, `run` for the default run script and `run:<name>` for the rest.
 * A run script may be named `setup`, so its key can't be the bare name.
 */
export const scriptKey = (kind: ScriptKind, name?: string) => {
  const n = runName(kind, name)
  return n && n !== 'run' ? `run:${n}` : kind
}

/**
 * `list` with `line` added and named. A chatty script drops its own oldest line, so it can't push another script's output
 * out. The lines that stay are the same objects, so the log's rows keep their keys and only new lines are drawn (KERNEL-211).
 */
export function keepLine(list: ScriptLine[], line: ScriptLine): ScriptLine[] {
  return keepLines(list, line.kind, line.name, [line])
}

/** `keepLine` for each of one script's `lines` in turn, with one copy of the list (KERNEL-216). */
export function keepLines(list: ScriptLine[], kind: ScriptKind, name: string | undefined, lines: Pick<ScriptLine, 'line' | 'stream'>[]): ScriptLine[] {
  const n = runName(kind, name)
  const next = [...list, ...lines.map((l): ScriptLine => ({ kind, name: n, line: l.line, stream: l.stream }))]
  const mine = next.filter((l) => l.kind === kind && l.name === n)
  if (mine.length <= SCRIPT_LINES) return next
  const drop = new Set(mine.slice(0, mine.length - SCRIPT_LINES))
  return next.filter((l) => !drop.has(l))
}
