import type { AgentDef, Workspace } from '@shared/types'
import { call } from './api'
import { actions, getState, go } from './store'

/** The room's Lead: the agent marked `lead: true`. */
export const leadOf = (agents: Record<string, AgentDef[]>, roomId: string | undefined): AgentDef | undefined => (roomId ? agents[roomId]?.find((a) => a.lead) : undefined)

/** The Lead's own workspace on the main checkout, the one `Kernel.leadChat` finds. A worktree the Lead works in doesn't count. */
export const isLeadWorkspace = (w: Workspace, roomId: string, leadId: string | undefined) =>
  !!leadId && w.roomId === roomId && w.agentId === leadId && w.mode === 'current' && w.status !== 'archived'

/**
 * Opens the room's Lead chat. The engine finds the Lead's workspace, or creates it on the main checkout when nobody has
 * briefed the Lead yet, so the sidebar row, Cmd+K, Cmd+Shift+L and Ask Rowan all work the same.
 */
export async function openLead(roomId: string): Promise<void> {
  try {
    const ws = await call('lead.open', { roomId })
    // The engine pushes the workspace too, but it may land after the route changes.
    actions.workspaces.upsert(ws)
    go({ name: 'workspace', workspaceId: ws.id })
  } catch (e) {
    const name = leadOf(getState().agents, roomId)?.name
    actions.ui.toast({ title: `Could not open ${name ? `${name}'s` : "the Lead's"} chat`, sub: (e as Error).message })
  }
}

/** Where a room opens, now the floor is hidden (D-104): the Lead's chat, or Team when the room has no Lead to open. */
export async function openRoom(roomId: string): Promise<void> {
  try {
    const ws = await call('lead.open', { roomId })
    actions.workspaces.upsert(ws)
    go({ name: 'workspace', workspaceId: ws.id })
  } catch {
    go({ name: 'team', roomId })
  }
}
