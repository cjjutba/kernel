import type { ScriptKind, ScriptLine } from './types'

/**
 * How much script and terminal output is kept. The window keeps it for the screen, and main keeps the same amount so a
 * window that reloads or reopens gets it back (KERNEL-340). Both trim with these, so the two copies match.
 */
export const SCRIPT_LINES = 400
/** Characters of output kept for each terminal. */
export const TERMINAL_KEEP = 200_000

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
  const named: ScriptLine = { ...line, name: runName(line.kind, line.name) }
  const next = [...list, named]
  if (next.length > SCRIPT_LINES) {
    const mine = next.filter((l) => l.kind === named.kind && l.name === named.name)
    if (mine.length > SCRIPT_LINES) next.splice(next.indexOf(mine[0]), 1)
  }
  return next
}
