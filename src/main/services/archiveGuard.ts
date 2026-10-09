import type { PrState, Workspace } from '@shared/types'

/** PR states a workspace may be archived over. Every other state is a PR still in flight. */
export const CLOSED_PR = new Set<PrState>(['none', 'merged', 'closed'])

export interface ArchiveGuardDeps {
  /** The Lead's own current-branch workspace, which is never archived. */
  isOwnLead: (ws: Workspace) => boolean
  /** Whether any of the workspace's chats is running a turn. */
  isRunning: (workspaceId: string) => boolean
  /** The workspace with its PR as GitHub has it now, or as saved when GitHub can't be asked. */
  latestPr: (ws: Workspace) => Promise<Workspace>
  /** Whether archiving would lose uncommitted work: 'dirty', 'unknown' when git can't tell, or false. */
  unsaved: (workspaceId: string) => Promise<'dirty' | 'unknown' | false>
}

/**
 * Why an open workspace can't be archived now, or nothing when it can (D-090). Archive removes the worktree with --force,
 * and Restore can't bring back what was never committed, so uncommitted work blocks; unpushed commits stay on the kept
 * branch (KERNEL-70). Shared by the Lead's archive_workspace and the review cleanup (KERNEL-131).
 */
export async function archiveSkip(ws: Workspace, d: ArchiveGuardDeps): Promise<string | undefined> {
  if (d.isOwnLead(ws)) return 'it is your own workspace'
  if (d.isRunning(ws.id)) return 'its agent is still working'
  const pr = await d.latestPr(ws)
  if (!CLOSED_PR.has(pr.prState)) return `its PR${pr.prNumber ? ' #' + pr.prNumber : ''} is open and not merged`
  const unsaved = await d.unsaved(ws.id)
  return unsaved === 'dirty' ? 'it has uncommitted changes' : unsaved === 'unknown' ? 'its git status could not be read' : undefined
}
