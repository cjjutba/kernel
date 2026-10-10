import { scriptKey, type State } from '../../store'

/** The run scripts running in a workspace, by name, from their output and exits alone. Settings may have renamed or removed one since it started. */
export function runningRuns(s: Pick<State, 'scripts' | 'scriptExit'>, workspaceId: string): string[] {
  const names = new Set((s.scripts[workspaceId] ?? []).filter((l) => l.kind === 'run').map((l) => l.name ?? 'run'))
  return [...names].filter((n) => s.scriptExit[workspaceId]?.[scriptKey('run', n)] === undefined)
}

/**
 * The scripts the Run tab offers: the room's, then any that is running without being listed, so it can still be stopped
 * after Settings renamed or removed it, or before Settings load.
 */
export const pickerNames = (listed: string[], running: string[]): string[] => [...listed, ...running.filter((n) => !listed.includes(n))]
