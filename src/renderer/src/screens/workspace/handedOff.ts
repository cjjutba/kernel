import type { Approval, Chat, Workspace } from '@shared/types'
import { threadIdOf } from '../../nav'

/** The stage word a handed-off workspace shows, from the same facts the Session rail's stages read (KERNEL-1094). */
export type HandedWord = 'Setting up' | 'Building' | 'Built' | 'Idle' | 'Waiting on you' | 'In review' | 'Merged' | 'Closed' | 'Failed'

export interface HandedRow {
  ws: Workspace
  word: HandedWord
  /** The teammate waits on an approval or a question, so the row comes first. */
  needs: boolean
}

/** What the rows read from the store. */
export interface HandedInput {
  workspaces: Workspace[]
  chats: Record<string, Chat[] | undefined>
  running: Record<string, boolean | undefined>
  approvals: Approval[]
}

/** Where a teammate's work stands, in the order the stages decide it: failed, merged, waiting on you, closed, setting up, in review, then building, built or idle. */
export function handedWord(ws: Workspace, running: boolean, waiting: boolean): HandedWord {
  if (ws.status === 'failed') return 'Failed'
  if (ws.prState === 'merged') return 'Merged'
  if (waiting) return 'Waiting on you'
  if (ws.prState === 'closed') return 'Closed'
  if (ws.status === 'setup' || ws.worktreePending) return 'Setting up'
  if (ws.prNumber || (ws.prState !== 'none' && ws.prState !== 'creating')) return 'In review'
  if (running) return 'Building'
  return ws.stat && ws.stat.files > 0 ? 'Built' : 'Idle'
}

/**
 * The workspaces a Lead chat handed off, one row each. A teammate belongs to the chat that created it (`threadId`, kept after that tab closes), or to a chat of the
 * workspace it was made from (`leadChatId`) when an older record has no thread. Reviews are the Lead's own helpers and are left out, and so is a workspace that was archived
 * without merging. Rows that wait on you come first, then the newest.
 */
export function handedOff(input: HandedInput, lead: Workspace, threadId: string | undefined): HandedRow[] {
  const mine = new Set((input.chats[lead.id] ?? []).filter((c) => !threadId || threadIdOf(c) === threadId).map((c) => c.id))
  const rows: HandedRow[] = []
  for (const w of input.workspaces) {
    if (w.lead || w.reviewOf || w.projectId !== lead.projectId || w.id === lead.id) continue
    const ours = threadId && w.threadId ? w.threadId === threadId : !!w.leadChatId && mine.has(w.leadChatId)
    if (!ours) continue
    if (w.status === 'archived' && w.prState !== 'merged') continue
    const waiting = input.approvals.some((a) => a.status === 'pending' && a.workspaceId === w.id)
    const running = (input.chats[w.id] ?? []).some((c) => !!input.running[c.id])
    rows.push({ ws: w, word: handedWord(w, running, waiting), needs: waiting })
  }
  return rows.sort((a, b) => Number(b.needs) - Number(a.needs) || b.ws.createdAt - a.ws.createdAt)
}
