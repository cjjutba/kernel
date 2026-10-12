/**
 * When the Run panel folds to its tab row (KERNEL-529): on the Setup and Run tabs, while there is no output, nothing runs or starts,
 * and the workspace isn't setting up or stuck in a failed setup, where the panel is the screen's main content. The first line of output
 * opens it again, from a script started here, by setup or by an agent. The Terminal tab never folds. Real script events only, no timers.
 */
export function bottomFolds(o: { tab: 'setup' | 'run' | 'terminal'; lines: number; running: boolean; setupBusy: boolean; starting: boolean; setupHolds: boolean }): boolean {
  if (o.tab === 'terminal' || o.lines > 0 || o.starting || o.setupHolds) return false
  return o.tab === 'run' ? !o.running : !o.setupBusy
}

/** What the folded row says it is waiting for. */
export function foldedWord(tab: 'setup' | 'run', o: { noRun: boolean; noSetup: boolean; port: number }): string {
  if (tab === 'run') return o.noRun ? 'No run script' : `Idle, port ${o.port}`
  return o.noSetup ? 'No setup script' : 'No output yet'
}
