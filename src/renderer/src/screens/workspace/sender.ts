import type { ChatItem } from '@shared/types'
import { isKernelUpdate } from '@shared/teamUpdate'

/**
 * How the transcript draws a user message (KERNEL-120). The user's own messages, and the Lead's briefs and follow-ups in
 * a teammate's chat, are the bubble WorkspaceMerged.png shows. Kernel's team updates are a card; Kernel's other messages,
 * such as its restart and limit nudges, are a one-line note. The ones that answer a plan are hidden, since the plan card draws the answer.
 */
export type UserView = 'bubble' | 'update' | 'note' | 'hidden'

export function userView(item: Extract<ChatItem, { kind: 'user' }>): UserView {
  // An unmarked message with the old header is an update only when its lines are an update's (`isKernelUpdate`).
  if (isKernelUpdate(item)) return 'update'
  // Kernel's message that answers a plan (after a restart, or on Codex) is drawn as the user's own bubble from the approval.
  if (item.from === 'kernel') return item.approvalId ? 'hidden' : 'note'
  return 'bubble'
}

/** The note a quit or a crash leaves in a chat whose turn it cut off. Kernel's message after the relaunch folds into it (KernelNote). Same words as sessions.ts. */
export const isQuitNote = (item: ChatItem): boolean => item.kind === 'note' && /^Kernel (quit|closed unexpectedly) while this agent was working\.$/.test(item.text)
