import type { Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go } from '../../store'
import { restoredFromHistory } from '../workspace/byHand'

/** Brings an archived workspace back and opens it, from History or Search. A failure says so in a toast and stays where it was. */
export async function restoreArchived(w: Workspace, name: string): Promise<void> {
  try {
    const back = await call('workspaces.restore', { workspaceId: w.id })
    restoredFromHistory(w.id)
    actions.workspaces.upsert(back)
    // A worktree sets up again before its agent goes on, and the workspace shows it (KERNEL-77).
    go({ name: 'workspace', workspaceId: w.id })
  } catch (e) {
    actions.ui.toast({ title: `Could not restore ${name}`, sub: cleanError(e) })
  }
}
