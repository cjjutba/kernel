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

/**
 * Opens one of the Lead's chats: the Lead's workspace with that chat's tab selected. The workspace screen clears the tab when the
 * workspace changes, so set it after `openLead` has navigated. `openLead` swallows its errors, so the tab is set only if the Lead's
 * workspace is on screen. When it already is, the tab is set at once.
 */
export async function openLeadChat(roomId: string, chatId: string): Promise<void> {
  const shownLead = () => {
    const s = getState()
    const lead = leadOf(s.agents, roomId)
    const shown = s.ui.route.name === 'workspace' ? s.workspaces.find((w) => w.id === (s.ui.route as { workspaceId: string }).workspaceId) : undefined
    return shown && isLeadWorkspace(shown, roomId, lead?.id) ? shown : undefined
  }
  if (!shownLead()) await openLead(roomId)
  const shown = shownLead()
  if (shown) actions.ui.openTab(shown.id, chatId)
}
