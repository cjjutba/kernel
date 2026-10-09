import type { KernelApi } from '@shared/ipc'
import { call } from '../../api'

// Workspaces the user archived by hand, until they are restored. The open workspace reads it to tell the user's archive
// from one Kernel made on its own, such as a review once its work merged (KERNEL-132).
const marked = new Set<string>()

export const archivedByHand = (workspaceId: string) => marked.has(workspaceId)

/** Archive because the user asked. Marked first: the archived status can arrive before the call returns. */
export async function archiveByHand(req: KernelApi['workspaces.archive']['req']) {
  marked.add(req.workspaceId)
  try { await call('workspaces.archive', req) } catch (e) { marked.delete(req.workspaceId); throw e }
}

/** The workspace is back from History, so its next archive starts unmarked. */
export const restoredFromHistory = (workspaceId: string) => void marked.delete(workspaceId)
