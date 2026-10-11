import type { Approval, Chat, Workspace } from '@shared/types'
import { isPlanApproval, permissionTitle, planReadyLine } from '../../screens/workspace/cards/steps'

/** What a chat row's hover card needs from the store, so the copy can be tested without a window (KERNEL-339). */
export interface ChatCardInput {
  tabs: Chat[]
  /** The workspaces this chat started. */
  owned: Workspace[]
  approvals: Approval[]
}

/** A wait on the chat: the approval, and the tab or workspace it is on. */
export interface Wait { approval: Approval; name: string; key: string }

/**
 * Everything that waits on you in this chat, longest wait first. One rule for the row and the card (KERNEL-339): a chat needs you
 * when one of its tabs, or a workspace it started, needs you. A wait is a pending approval, never a timer.
 */
export function chatWaits({ tabs, owned, approvals }: ChatCardInput): Wait[] {
  const waits: Wait[] = []
  for (const a of approvals) {
    if (a.status !== 'pending') continue
    const tab = tabs.find((c) => c.id === a.chatId)
    const ws = tab ? undefined : owned.find((w) => w.id === a.workspaceId)
    if (tab) waits.push({ approval: a, name: tab.title, key: `chat:${tab.id}` })
    else if (ws) waits.push({ approval: a, name: ws.title ?? ws.name, key: `ws:${ws.id}` })
  }
  return waits.sort((x, y) => x.approval.createdAt - y.approval.createdAt)
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** "Should we keep Google sign in?" reads as "whether to keep Google sign in". Any other question is lowercased as asked. */
function questionText(title: string): string {
  const q = title.trim().replace(/[?.]+$/, '')
  const asks = q.match(/^(?:should (?:we|i)|do you want to|would you like to) (.+)$/i)
  return asks ? `whether to ${asks[1]}` : lowerFirst(q)
}

/**
 * The line under the title for the wait that has gone longest. A question reads "{name} asks {what}". A plan or a permission uses the
 * line the app already shows for it (the Home list and the approval card), with the tab or workspace name in front, so no new copy.
 */
export function waitLine({ approval: a, name }: Wait, who: string): string {
  if (a.kind === 'question') return `${name} asks ${questionText(a.title)}.`
  if (isPlanApproval(a)) return `${name}: ${planReadyLine(a)}`
  return `${name}: ${permissionTitle(a, who)}`
}

const tabCount = (n: number) => `${n} tab${n === 1 ? '' : 's'}`

/** "2 tabs · 1 needs you", "3 tabs · 2 need you", "3 tabs · 1 working" or "3 tabs". Waiting wins over working, as in the row's icon. */
export function chatFoot(tabs: number, waiting: number, working: number): string {
  if (waiting) return `${tabCount(tabs)} · ${waiting} ${waiting === 1 ? 'needs' : 'need'} you`
  if (working) return `${tabCount(tabs)} · ${working} working`
  return tabCount(tabs)
}

/** The time on the card's right: how long the longest wait has gone, else the last thing that happened in any tab, else when the chat started. */
export function chatSince(waits: Wait[], lastItem: number, started: number): number {
  return waits[0]?.approval.createdAt ?? (lastItem || started)
}
