import type { Approval, Chat, Workspace } from '@shared/types'

/** What a chat row needs from the store to know what waits on you, so the rule can be tested without a window (KERNEL-339). */
export interface ChatWaitsInput {
  tabs: Chat[]
  /** The workspaces this chat started. */
  owned: Workspace[]
  approvals: Approval[]
}

/** A wait on the chat: the approval, the tab or workspace it is on, and the agent who is waiting when that isn't the Lead. */
export interface Wait { approval: Approval; name: string; key: string; agentId?: string }

/**
 * Everything that waits on you in this chat, longest wait first. One rule for the row (KERNEL-339): a chat needs you
 * when one of its tabs, or a workspace it started, needs you. A wait is a pending approval, never a timer.
 */
export function chatWaits({ tabs, owned, approvals }: ChatWaitsInput): Wait[] {
  const waits: Wait[] = []
  for (const a of approvals) {
    if (a.status !== 'pending') continue
    const tab = tabs.find((c) => c.id === a.chatId)
    const ws = tab ? undefined : owned.find((w) => w.id === a.workspaceId)
    if (tab) waits.push({ approval: a, name: tab.title, key: `chat:${tab.id}`, agentId: a.agentId })
    // A workspace's own agent asks in it, so the approval's agent, else the workspace's, is who a permission names.
    else if (ws) waits.push({ approval: a, name: ws.title ?? ws.name, key: `ws:${ws.id}`, agentId: a.agentId ?? ws.agentId })
  }
  return waits.sort((x, y) => x.approval.createdAt - y.approval.createdAt)
}

/** The workspaces this chat started that are held until the project's scripts are trusted. They wait on you like an approval, and clear when the status changes (KERNEL-342). */
export const chatTrusts = (owned: Workspace[]): Workspace[] => owned.filter((w) => w.status === 'trust')
