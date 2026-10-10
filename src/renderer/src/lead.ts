import { useMemo } from 'react'
import type { AgentDef, Approval, Workspace } from '@shared/types'
import { call } from './api'
import { actions, getState, go, useStore } from './store'

/** The room's Lead: the agent marked `lead: true`. */
export const leadOf = (agents: Record<string, AgentDef[]>, roomId: string | undefined): AgentDef | undefined => (roomId ? agents[roomId]?.find((a) => a.lead) : undefined)

/** The Lead's own workspace on the main checkout, the one `Kernel.leadChat` finds. A worktree the Lead works in doesn't count. */
export const isLeadWorkspace = (w: Workspace, roomId: string, leadId: string | undefined) =>
  !!leadId && w.roomId === roomId && w.agentId === leadId && w.mode === 'current' && w.status !== 'archived'

const NONE: Approval[] = []

/** The pending approvals on the Lead's workspace. Without a Lead workspace nothing waits, since approvals without a workspace belong to other rooms. */
export const leadWaiting = (approvals: Approval[], workspaceId: string | undefined): Approval[] =>
  workspaceId ? approvals.filter((a) => a.workspaceId === workspaceId && a.status === 'pending') : NONE

/** The Lead's pending approvals, found on its own workspace. The row and the card read the same ones, so they show the same icon. */
export function useLeadWaiting(roomId: string): Approval[] {
  const leadId = useStore((s) => leadOf(s.agents, roomId)?.id)
  const workspaceId = useStore((s) => s.workspaces.find((w) => isLeadWorkspace(w, roomId, leadId))?.id)
  const approvals = useStore((s) => s.approvals)
  return useMemo(() => leadWaiting(approvals, workspaceId), [approvals, workspaceId])
}

/**
 * Finds the room's Lead workspace. The engine finds it, or creates it on the main checkout when nobody has briefed the Lead yet,
 * so the sidebar row, Cmd+K, Cmd+Shift+L and Ask Rowan all work the same. A failure toasts and returns undefined.
 */
async function leadWorkspace(roomId: string): Promise<Workspace | undefined> {
  try {
    const ws = await call('lead.open', { roomId })
    // The engine pushes the workspace too, but it may land after the route changes.
    actions.workspaces.upsert(ws)
    return ws
  } catch (e) {
    const name = leadOf(getState().agents, roomId)?.name
    actions.ui.toast({ title: `Could not open ${name ? `${name}'s` : "the Lead's"} chat`, sub: (e as Error).message })
    return undefined
  }
}

/** Opens the room's Lead chat, on the tab it last showed. Returns the Lead's workspace, or undefined when it could not be opened. */
export async function openLead(roomId: string): Promise<Workspace | undefined> {
  const ws = await leadWorkspace(roomId)
  if (ws) go({ name: 'workspace', workspaceId: ws.id })
  return ws
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

/**
 * Opens one of the Lead's chats: the Lead's workspace with that chat's tab selected. Each workspace keeps its own tab,
 * so the tab is set first and the navigation shows it.
 */
export async function openLeadChat(roomId: string, chatId: string): Promise<void> {
  // With the Lead's workspace already on screen there is nothing to look up, so switching chats doesn't wait on the engine.
  const s = getState()
  const shown = s.ui.route.name === 'workspace' ? s.workspaces.find((w) => w.id === (s.ui.route as { workspaceId: string }).workspaceId) : undefined
  if (shown && isLeadWorkspace(shown, roomId, leadOf(s.agents, roomId)?.id)) return actions.ui.openTab(shown.id, chatId)
  const ws = await leadWorkspace(roomId)
  if (!ws) return
  actions.ui.openTab(ws.id, chatId)
  go({ name: 'workspace', workspaceId: ws.id })
}
