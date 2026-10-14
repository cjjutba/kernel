import type { Workspace } from './types'

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
