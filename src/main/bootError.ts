import { homedir } from 'node:os'
import { sep } from 'node:path'
import { NEWER_DATA } from './migrations'

/** Messages written for the user. Their dialog shows them as they are, with nothing added. */
const FOR_THE_USER = new Set([NEWER_DATA])

/**
 * The detail under "Kernel could not start" (KERNEL-268): the error's message, never its stack, which goes to the console
 * and main.log. An unexpected error adds where the log is, with the home folder shown as ~. No log, no line. A thrown
 * value that isn't an Error shows as String(err), as before.
 */
export function bootDetail(err: unknown, logFile?: string, home = homedir()): string {
  if (!(err instanceof Error)) return String(err)
  const message = err.message.trim() || err.name
  if (FOR_THE_USER.has(message) || !logFile) return message
  const shown = logFile.startsWith(home + sep) ? `~${logFile.slice(home.length)}` : logFile
  return `${message}\n\nDetails are in ${shown}.`
}
