import { useMemo } from 'react'
import type { AgentDef, Approval, NewChatPicks, Workspace, WorkspaceSource } from '@shared/types'
import { isLeadWorkspace as isLead } from '@shared/leadWorkspace'
import { call, cleanError } from './api'
import { projectAgents } from './nav'
import { focusComposerIn } from './screens/workspace/composer/bus'
import { leadNewKey } from './components/sidebar/slots'
import { actions, getState, go, useStore } from './store'

/** The project's Lead: the agent marked `lead: true`. */
export const leadOf = (agents: Record<string, AgentDef[]>, projectId: string | undefined): AgentDef | undefined => (projectId ? agents[projectId]?.find((a) => a.lead) : undefined)

/** One of the project's Lead workspaces: a Lead chat's own, or the shared one from before KERNEL-405. A worktree the Lead works in doesn't count. */
export const isLeadWorkspace = (w: Workspace, projectId: string, leadId: string | undefined) => w.projectId === projectId && isLead(w, leadId)

export { chatWorkspaces } from './nav'

const NONE: Approval[] = []

/** The pending approvals on the Lead's workspace. Without a Lead workspace nothing waits, since approvals without a workspace belong to other projects. */
export const leadWaiting = (approvals: Approval[], workspaceId: string | undefined): Approval[] =>
  workspaceId ? approvals.filter((a) => a.workspaceId === workspaceId && a.status === 'pending') : NONE

/** The Lead's pending approvals, on any of its chats' workspaces. The row and the card read the same ones, so they show the same icon. */
export function useLeadWaiting(projectId: string): Approval[] {
  const leadId = useStore((s) => leadOf(s.agents, projectId)?.id)
  const ids = useStore((s) => s.workspaces.filter((w) => isLeadWorkspace(w, projectId, leadId)).map((w) => w.id).join())
  const approvals = useStore((s) => s.approvals)
  return useMemo(() => (ids ? approvals.filter((a) => !!a.workspaceId && ids.split(',').includes(a.workspaceId) && a.status === 'pending') : NONE), [approvals, ids])
}

/**
 * The workspace of the project's newest open Lead chat, or null when no chat is open (KERNEL-405). The engine never starts a
 * chat for it, so the sidebar row, Cmd+K and Cmd+Shift+L land on New chat instead. A failure toasts and
 * returns undefined.
 */
async function leadWorkspace(projectId: string): Promise<Workspace | null | undefined> {
  try {
    const ws = await call('lead.open', { projectId })
    // The engine pushes the workspace too, but it may land after the route changes.
    if (ws) actions.workspaces.upsert(ws)
    return ws
  } catch (e) {
    const name = leadOf(getState().agents, projectId)?.name
    actions.ui.toast({ title: `Could not open ${name ? `${name}'s` : "the Lead's"} chat`, sub: cleanError(e) })
    return undefined
  }
}

/**
 * Opens the project's newest Lead chat, on the tab it last showed, or New chat when none is open. Returns the chat's
 * workspace, or undefined when there is none.
 */
export async function openLead(projectId: string): Promise<Workspace | undefined> {
  const ws = await leadWorkspace(projectId)
  if (ws) go({ name: 'workspace', workspaceId: ws.id })
  else if (ws === null) go({ name: 'leadNew', projectId })
  return ws ?? undefined
}

/**
 * New chat, the one way to start a chat (KERNEL-788): the page on the `leadNew` route, in `projectId` or the project in view, else the first project.
 * `source` arrives in the box as a chip, and `picks` are what the box had chosen when the issue warning sent it back.
 */
export function openNewChat(projectId: string | undefined, opts?: { source?: WorkspaceSource; picks?: NewChatPicks }): void {
  const project = projectId ?? getState().projects[0]?.id ?? ''
  // With no project yet, New chat still opens, and asks for a project first (KERNEL-943).
  // The box takes the caret when it mounts, or at once when New chat is already showing.
  if (project) focusComposerIn(leadNewKey(project))
  go({ name: 'leadNew', projectId: project, ...opts })
}

/**
 * Where a project opens: its newest Lead chat, New chat when none is open, or the project's Agents page
 * in Settings when the project has no Lead.
 */
export async function openProject(projectId: string): Promise<void> {
  try {
    const ws = await call('lead.open', { projectId })
    if (!ws) { go({ name: 'leadNew', projectId }); return }
    actions.workspaces.upsert(ws)
    go({ name: 'workspace', workspaceId: ws.id })
  } catch {
    go(projectAgents(projectId))
  }
}

/**
 * Opens a tab of a Lead chat: its chat's workspace with that tab selected (KERNEL-405). Each workspace keeps its own tab, so
 * the tab is set first and the navigation shows it. A tab the store doesn't know yet is in the project's newest chat, the one a new
 * chat or a question just made.
 */
export async function openLeadChat(projectId: string, chatId: string): Promise<void> {
  const s = getState()
  const known = Object.entries(s.chats).find(([, list]) => list.some((c) => c.id === chatId))?.[0]
  const shown = s.ui.route.name === 'workspace' ? s.ui.route.workspaceId : undefined
  if (known && known === shown) return actions.ui.openTab(known, chatId)
  const workspaceId = known ?? (await leadWorkspace(projectId))?.id
  if (!workspaceId) return
  actions.ui.openTab(workspaceId, chatId)
  go({ name: 'workspace', workspaceId })
}
