/**
 * What a collapsed bottom panel says the scripts are doing (KERNEL-529). Folded, the panel is its tab bar alone (KERNEL-513), so this
 * word is how you tell whether the app is up without opening it. It reads script state only: setup running or failed, the run scripts
 * running, and whether the room has one. A room with several run scripts names the ones running.
 */
export function collapsedWord(o: { setupRunning: boolean; setupFailed: boolean; running: string[]; scripts: number; noRun: boolean; port: number }): string {
  if (o.setupRunning) return 'Setting up'
  if (o.setupFailed) return 'Setup failed'
  if (o.running.length) return o.scripts > 1 ? `Running ${o.running.join(', ')}` : 'Running'
  if (o.noRun) return 'No run script'
  return `Idle, port ${o.port}`
}
