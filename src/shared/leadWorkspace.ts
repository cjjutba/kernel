import type { Thread, Workspace } from './types'

/**
 * The Lead's own open workspace: marked `lead`, and still the Lead agent's (KERNEL-353). A worktree handed to the Lead when an
 * agent retired carries no mark, and neither does a workspace whose agent is no longer the Lead.
 */
export const isLeadWorkspace = (ws: Workspace, leadId: string | undefined) => !!ws.lead && !!leadId && ws.agentId === leadId && ws.status !== 'archived'

/**
 * A Lead chat's own workspace (KERNEL-405): marked `lead`, with the chat it hosts in `threadId`, open or archived. The
 * old shared Lead workspace from before KERNEL-405 is `lead` with no `threadId`, and isn't one.
 */
export const isLeadChatWorkspace = (ws: Workspace) => !!ws.lead && !!ws.threadId

/** The open workspace of the Lead chat `threadId` (KERNEL-405). */
export const leadChatWorkspaceOf = (workspaces: Workspace[], threadId: string): Workspace | undefined =>
  workspaces.find((w) => isLeadChatWorkspace(w) && w.threadId === threadId && w.status !== 'archived')

/** A chat that runs in the project's shared main folder and has no worktree, branch, ports or setup of its own (KERNEL-1050). */
export const onSharedFolder = (ws: Workspace) => !!ws.shared

/**
 * A Lead chat that has a folder of its own, a worktree or the checkout, rather than the shared main folder. Its PRs take a
 * teammate's path (review, Team updates, auto-merge), and it may edit files (docs/decisions/one-lead-chat.md).
 */
export const ownsFolder = (ws: Workspace | undefined): boolean => !!ws && isLeadChatWorkspace(ws) && !ws.shared

/**
 * Another open workspace on the project's checkout, which "One current-branch workspace per project" refuses a second to share: a
 * teammate's, or a chat with Kernel that works there (KERNEL-1051). `self` is the one asking, so it never counts, nor does a chat of the
 * same agent unless both are chats with Kernel.
 */
export const checkoutHolder = (workspaces: Workspace[], projectId: string, self: { id?: string; agentId: string; lead?: boolean }): Workspace | undefined =>
  workspaces.find((w) => w.projectId === projectId && w.mode === 'current' && w.status !== 'archived' && w.id !== self.id
    && (w.agentId !== self.agentId || (!!self.lead && ownsFolder(w))))

/** Whether a new tab can join the Lead chat workspace `ws`: its own worktree, open and made, its folder on disk and its chat still open. */
export const canTakeTab = (ws: Workspace, threads: Record<string, Thread | undefined>): boolean => {
  const t = ws.threadId ? threads[ws.threadId] : undefined
  return ownsFolder(ws) && ws.mode === 'worktree' && ws.status === 'ready' && !ws.worktreePending && !ws.folderGone && !!t && !t.closedAt
}

/**
 * The worktrees a new chat can reuse (Previous worktree in New chat's Workspace menu): the project's open Lead chat workspaces that can
 * take a tab, the chat touched last first, up to `limit`.
 */
export function reusableWorktrees(workspaces: Workspace[], threads: Record<string, Thread | undefined>, projectId: string, limit = 5): Workspace[] {
  const touched = (w: Workspace) => { const t = threads[w.threadId!]; return t ? t.lastSentAt ?? t.createdAt : w.createdAt }
  return workspaces.filter((w) => w.projectId === projectId && canTakeTab(w, threads)).sort((a, b) => touched(b) - touched(a) || b.createdAt - a.createdAt).slice(0, limit)
}
