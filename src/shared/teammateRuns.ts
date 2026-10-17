import type { AppSettings, ProjectSettings, TeammatesRunIn } from './types'
import { TEAMMATES_RUN_IN } from './types'

/** Where one teammate runs: in Kernel, as a chat, or in a terminal tab (KERNEL-1004). */
export type RunsIn = 'kernel' | 'terminal'

export const RUNS_IN: RunsIn[] = ['kernel', 'terminal']

/**
 * Where a hand-off's teammate runs. The Lead's `runs_in` wins, then the project's `[terminal] teammates_run_in`, then Settings,
 * Terminal. `lead` means the same as the Lead that handed the task off: a terminal in a terminal Lead's hand-off, Kernel in
 * a chat Lead's. Whatever is unset or invalid falls through to the next level, and nothing at all means Kernel.
 */
export function teammateRunsIn(o: {
  runsIn?: unknown
  project?: Pick<ProjectSettings, 'terminal'>
  app?: { terminal?: Partial<Pick<AppSettings['terminal'], 'teammatesRunIn'>> }
  leadIsTerminal: boolean
}): RunsIn {
  if (RUNS_IN.includes(o.runsIn as RunsIn)) return o.runsIn as RunsIn
  const valid = (v: unknown): v is TeammatesRunIn => TEAMMATES_RUN_IN.includes(v as TeammatesRunIn)
  const own = o.project?.terminal?.teammatesRunIn
  const all = o.app?.terminal?.teammatesRunIn
  const where = valid(own) ? own : valid(all) ? all : 'kernel'
  return where === 'lead' ? (o.leadIsTerminal ? 'terminal' : 'kernel') : where
}
