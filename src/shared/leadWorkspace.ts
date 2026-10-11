import type { Workspace } from './types'

/**
 * The Lead's own open workspace: marked `lead`, and still the Lead agent's (KERNEL-353). A worktree handed to the Lead when an
 * agent retired carries no mark, and neither does a workspace whose agent is no longer the Lead.
 */
export const isLeadWorkspace = (ws: Workspace, leadId: string | undefined) => !!ws.lead && !!leadId && ws.agentId === leadId && ws.status !== 'archived'
