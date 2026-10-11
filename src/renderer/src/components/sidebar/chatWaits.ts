import type { Approval, Chat, Workspace } from '@shared/types'

/** What a chat row needs from the store to know what waits on you, so the rule can be tested without a window (KERNEL-339). */
export interface ChatWaitsInput {
  tabs: Chat[]
  /** The workspaces this chat started. */
  owned: Workspace[]
  approvals: Approval[]
}

/** A wait on the chat: the approval, and the key of the tab or workspace it is on. */
export interface Wait { approval: Approval; key: string }

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
    if (tab) waits.push({ approval: a, key: `chat:${tab.id}` })
    else if (ws) waits.push({ approval: a, key: `ws:${ws.id}` })
  }
  return waits.sort((x, y) => x.approval.createdAt - y.approval.createdAt)
}

/** The workspaces this chat started that are held until the room's scripts are trusted. They wait on you like an approval, and clear when the status changes (KERNEL-342). */
export const chatTrusts = (owned: Workspace[]): Workspace[] => owned.filter((w) => w.status === 'trust')
