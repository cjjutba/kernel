import type { AppUpdate } from '@shared/types'
import { call, cleanError } from '../../api'
import { failToast } from '../../retry'
import { actions } from '../../store'
import { updateFailed, updateReason } from './updateModel'

/** The key the toasts' Try again use to check for updates again. `UpdateCard`, which is always mounted, registers it. */
export const UPDATE_CHECK_RETRY = 'update-check'
/** The key the "Couldn't restart Kernel" toast's Try again uses to press Restart again. */
export const UPDATE_INSTALL_RETRY = 'update-install'

/** What a failed check says under its title: the reason the updater gave, or that GitHub didn't answer when it gave none. */
export function checkFailedReason(error: string | undefined, online = true): string {
  const reason = updateReason(error, online)
  return reason === 'Could not check for updates' ? "GitHub releases didn't answer." : reason
}

/**
 * Restart to update. Kernel quits on success, so this resolves only when it did not: `canceled` when the person kept Kernel running in the
 * "agents are working" dialog, `failed` after the toast that says why (Pen 17.4, WhatsNewRestartFailed). The dialog and the toast both
 * keep their buttons busy until this resolves.
 */
export async function restartToUpdate(): Promise<'canceled' | 'failed' | 'quit'> {
  try {
    const r = await call('update.install', undefined)
    return r.canceled ? 'canceled' : 'quit'
  } catch (e) {
    actions.ui.toast({ title: "Couldn't restart Kernel", sub: cleanError(e), glyph: 'error', action: { label: 'Try again', retry: UPDATE_INSTALL_RETRY, primary: true } })
    return 'failed'
  }
}

/** Checks for an update on the person's say, and raises the Try again toast when it fails. Resolves to the state the check left. */
export async function checkAgain(online = true): Promise<AppUpdate | undefined> {
  try {
    const u = await call('update.check', undefined)
    actions.system.setUpdate(u)
    if (updateFailed(u)) failToast("Couldn't check for updates", checkFailedReason(u.error, online), UPDATE_CHECK_RETRY)
    return u
  } catch (e) {
    failToast("Couldn't check for updates", cleanError(e), UPDATE_CHECK_RETRY)
    return undefined
  }
}
