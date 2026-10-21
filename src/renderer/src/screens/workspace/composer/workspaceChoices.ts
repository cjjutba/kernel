import { useMemo } from 'react'
import type { LeadWhere, Thread, Workspace, WorkspaceMode } from '@shared/types'
import { checkoutHolder, reusableWorktrees } from '@shared/leadWorkspace'
import { leadOf } from '../../../lead'
import { useStore } from '../../../store'
import type { DraftPicks } from './draftStore'
import type { PreviousWorktree } from './WorkspaceMenu'

/** Kernel's placeholder titles for a chat that has none yet. */
const PLACEHOLDERS = new Set(['New chat', 'New tab'])

/** A chat workspace's name for a person: its chat's title, else the workspace's own. */
export function chatTitle(ws: Workspace, threads: Record<string, Thread | undefined>): string {
  const t = ws.threadId ? threads[ws.threadId]?.title : undefined
  return (t && !PLACEHOLDERS.has(t) ? t : undefined) || ws.title || ws.name
}

/**
 * What New chat's Workspace menu offers in a project: the chat that holds the checkout while "One current-branch workspace per project" keeps
 * a second off it, and up to five worktrees an earlier chat has open, newest chat first.
 */
export function useWorkspaceChoices(projectId: string): { taken?: string; previous: PreviousWorktree[] } {
  const workspaces = useStore((s) => s.workspaces)
  const threads = useStore((s) => s.threads)
  const leadId = useStore((s) => leadOf(s.agents, projectId)?.id)
  const chats = useStore((s) => s.chats)
  const running = useStore((s) => s.running)
  const one = useStore((s) => s.settings?.workspace.oneCurrentBranchPerProject ?? true)
  return useMemo(() => {
    const held = one ? checkoutHolder(workspaces, projectId, { agentId: leadId ?? '', lead: true }) : undefined
    const previous = reusableWorktrees(workspaces, threads, projectId).map((w) => ({ id: w.id, title: chatTitle(w, threads), branch: w.branch, at: threads[w.threadId!]?.lastSentAt ?? threads[w.threadId!]?.createdAt ?? w.createdAt, busy: (chats[w.id] ?? []).some((c) => running[c.id]) }))
    return { taken: held ? chatTitle(held, threads) : undefined, previous }
  }, [workspaces, threads, chats, running, projectId, leadId, one])
}

/**
 * What `lead.start` gets for a pick: Previous worktree always, and Current checkout or New worktree only when it differs from Settings' workspace
 * type, so a box nobody touched leaves the choice to the project's file and Settings, as before.
 */
export function whereToSend(kind: WorkspaceMode, previous: string | undefined, appPlace: WorkspaceMode): LeadWhere | undefined {
  if (previous) return { kind: 'previous', workspaceId: previous }
  return kind === appPlace ? undefined : { kind }
}

/**
 * The choice the box shows and sends. A pick of Previous worktree holds only while that worktree is still on offer, else it falls back to
 * the pick before it. The Current checkout falls back to a new worktree while another chat holds it. With no pick, the default is Settings' workspace type.
 */
export function shownWhere(picks: DraftPicks | undefined, appPlace: WorkspaceMode, c: { taken?: string; previous: PreviousWorktree[] }): LeadWhere {
  if (picks?.previous && c.previous.some((p) => p.id === picks.previous)) return { kind: 'previous', workspaceId: picks.previous }
  const place = picks?.place ?? appPlace
  return place === 'current' && !c.taken ? { kind: 'current' } : { kind: 'worktree' }
}
