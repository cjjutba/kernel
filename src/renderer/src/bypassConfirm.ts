import { readSaved, writeSaved } from './remember'

/**
 * Whether the user has already answered ConfirmBypass (KERNEL-455). Every way into Bypass permissions asks once: Settings,
 * a room's override, Shift+Tab, the mode menu and the + menu. The onboarding step counts as the answer, because it shows
 * Bypass with its warning. Renderer only: localStorage keeps it across launches and may be missing or blocked, in which
 * case Kernel asks again. Fixture mode keeps it in memory, since it must neither read nor write what a real launch saved.
 */
const KEY = 'kernel.bypassConfirmed'
let confirmed: boolean | undefined

export function bypassConfirmed(): boolean {
  if (confirmed !== undefined) return confirmed
  return (confirmed = readSaved(KEY) === '1')
}

export function rememberBypassConfirmed() {
  confirmed = true
  writeSaved(KEY, '1')
}
