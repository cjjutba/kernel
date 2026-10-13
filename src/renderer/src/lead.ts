import { useMemo } from 'react'
import type { AgentDef, Approval, Workspace } from '@shared/types'
import { isLeadWorkspace as isLead } from '@shared/leadWorkspace'
import { call, cleanError } from './api'
import { roomAgents } from './nav'
import { actions, getState, go, useStore } from './store'

/** The room's Lead: the agent marked `lead: true`. */
export const leadOf = (agents: Record<string, AgentDef[]>, roomId: string | undefined): AgentDef | undefined => (roomId ? agents[roomId]?.find((a) => a.lead) : undefined)

/** One of the room's Lead workspaces: a chat with Rowan's own, or the shared one from before KERNEL-405. A worktree the Lead works in doesn't count. */
export const isLeadWorkspace = (w: Workspace, roomId: string, leadId: string | undefined) => w.roomId === roomId && isLead(w, leadId)

export { chatWorkspaces } from './nav'

const NONE: Approval[] = []

/** The pending approvals on the Lead's workspace. Without a Lead workspace nothing waits, since approvals without a workspace belong to other rooms. */
export const leadWaiting = (approvals: Approval[], workspaceId: string | undefined): Approval[] =>
  workspaceId ? approvals.filter((a) => a.workspaceId === workspaceId && a.status === 'pending') : NONE

/** The Lead's pending approvals, on any of its chats' workspaces. The row and the card read the same ones, so they show the same icon. */
export function useLeadWaiting(roomId: string): Approval[] {
  const leadId = useStore((s) => leadOf(s.agents, roomId)?.id)
  const ids = useStore((s) => s.workspaces.filter((w) => isLeadWorkspace(w, roomId, leadId)).map((w) => w.id).join())
  const approvals = useStore((s) => s.approvals)
  return useMemo(() => (ids ? approvals.filter((a) => !!a.workspaceId && ids.split(',').includes(a.workspaceId) && a.status === 'pending') : NONE), [approvals, ids])
}

/**
 * The workspace of the room's newest open chat with Rowan, or null when no chat is open (KERNEL-405). The engine never starts a
 * chat for it, so the sidebar row, Cmd+K and Cmd+Shift+L land on New chat with Rowan instead. A failure toasts and
 * returns undefined.
 */
async function leadWorkspace(roomId: string): Promise<Workspace | null | undefined> {
  try {
    const ws = await call('lead.open', { roomId })
    // The engine pushes the workspace too, but it may land after the route changes.
    if (ws) actions.workspaces.upsert(ws)
    return ws
  } catch (e) {
    const name = leadOf(getState().agents, roomId)?.name
    actions.ui.toast({ title: `Could not open ${name ? `${name}'s` : "the Lead's"} chat`, sub: cleanError(e) })
    return undefined
  }
}

/**
 * Opens the room's newest chat with Rowan, on the tab it last showed, or New chat with Rowan when none is open. Returns the chat's
 * workspace, or undefined when there is none.
 */
export async function openLead(roomId: string): Promise<Workspace | undefined> {
  const ws = await leadWorkspace(roomId)
  if (ws) go({ name: 'workspace', workspaceId: ws.id })
  else if (ws === null) go({ name: 'leadNew', roomId })
  return ws ?? undefined
}

/**
 * Where a room opens: its newest chat with Rowan, New chat with Rowan when none is open, or the room's Agents page
 * in Settings when the room has no Lead.
 */
export async function openRoom(roomId: string): Promise<void> {
  try {
    const ws = await call('lead.open', { roomId })
    if (!ws) { go({ name: 'leadNew', roomId }); return }
    actions.workspaces.upsert(ws)
    go({ name: 'workspace', workspaceId: ws.id })
  } catch {
    go(roomAgents(roomId))
  }
}

/**
 * Opens a tab of a chat with Rowan: its chat's workspace with that tab selected (KERNEL-405). Each workspace keeps its own tab, so
 * the tab is set first and the navigation shows it. A tab the store doesn't know yet is in the room's newest chat, the one a new
 * chat or a question just made.
 */
export async function openLeadChat(roomId: string, chatId: string): Promise<void> {
  const s = getState()
  const known = Object.entries(s.chats).find(([, list]) => list.some((c) => c.id === chatId))?.[0]
  const shown = s.ui.route.name === 'workspace' ? s.ui.route.workspaceId : undefined
  if (known && known === shown) return actions.ui.openTab(known, chatId)
  const workspaceId = known ?? (await leadWorkspace(roomId))?.id
  if (!workspaceId) return
  actions.ui.openTab(workspaceId, chatId)
  go({ name: 'workspace', workspaceId })
}
