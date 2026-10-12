import type { IssueTaken, IssueTakenFinding } from '@shared/types'

/**
 * How long New chat waits for `issues.taken`. The engine gives each of its checks 10 seconds and runs them at once, so this only
 * covers a main process that doesn't answer at all.
 */
export const TAKEN_WAIT_MS = 12_000

/**
 * What Kernel found before a chat starts from `issue`, or nothing. Fails open: an error or no answer in `ms` is no findings,
 * since the check must never keep anyone from starting (KERNEL-500).
 */
export async function takenFindings(ask: (req: { roomId: string; issue: string }) => Promise<IssueTaken>, roomId: string, issue: string, ms = TAKEN_WAIT_MS): Promise<IssueTakenFinding[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<IssueTaken>((resolve) => { timer = setTimeout(() => resolve({ findings: [], notes: [] }), ms) })
  try { return (await Promise.race([ask({ roomId, issue }), late])).findings }
  catch { return [] }
  finally { clearTimeout(timer) }
}

/** What the Lead hears when the user started anyway, so create_workspace doesn't ask again (KERNEL-479). */
export const startAnywayLine = (issue: string) => `Someone else may already be on ${issue}. The user knows and chose to start anyway, so call create_workspace with confirm: true.`
