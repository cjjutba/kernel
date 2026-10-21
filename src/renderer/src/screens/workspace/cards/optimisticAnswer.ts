import type { Approval, ChatItem, Decision } from '@shared/types'
import { answerItemId, answerParts } from '@shared/approvalAnswer'
import { call } from '../../../api'
import { actions, getState } from '../../../store'
import { attempt } from '../MessageActions'
import { applyOwners } from '@shared/planOwners'
import { isPlanApproval } from './steps'
import { withOwners } from './planOwners'

/**
 * The row the engine will place for a decision made in the chat (`placeAnswer`), built from the decision before the call returns. A typed send shows at
 * once, so an answer does too. The id is the engine's, so its row replaces this one in place and the answer is never drawn twice.
 * A plan's change request carries its images as the same parts main keeps, so the bubble has the height it will keep.
 * Nothing when the card has no answer (a tool permission).
 */
export function answerRow(a: Approval, decision: Decision, ts = Date.now()): ChatItem | undefined {
  const status = decision.behavior === 'allow' ? 'allowed' : decision.behavior === 'deny' ? 'denied' : 'answered'
  const answer = decision.behavior === 'answer' ? decision.text
    : decision.behavior === 'deny' && isPlanApproval(a) ? decision.message?.trim() || undefined
    : a.answer
  const images = decision.behavior === 'deny' && decision.images?.length ? decision.images.map((i) => ({ type: 'image' as const, name: i.name, dataUrl: i.dataUrl })) : a.images
  const parts = answerParts({ ...a, status, answer, images, answers: decision.behavior === 'answer' ? decision.answers ?? a.answers : a.answers })
  return parts ? { kind: 'user', id: answerItemId(a.id), ts, parts, approvalId: a.id } : undefined
}

const statusOf = (d: Decision): Approval['status'] => (d.behavior === 'allow' ? 'allowed' : d.behavior === 'deny' ? 'denied' : 'answered')

/**
 * Puts the result of a decision in the chat now, in one render (KERNEL-895). The answer row appears. A plan also stops waiting, so its strip, the Plan placeholder
 * and the "Waiting for you" line go with it, and an approved one leaves plan mode as the engine will. Returns what undoes it when the call fails: each piece goes
 * back only while it is still the one drawn here, so a row or card the engine has since replaced stays.
 */
export function placeAnswerNow(a: Approval, decision: Decision): () => void {
  const row = a.chatId ? answerRow(a, decision) : undefined
  const chatId = a.chatId
  // The card keeps the owners the user chose while the answer is on its way.
  const owners = withOwners(a, decision)
  const steps = a.steps && owners.behavior === 'allow' && owners.owners ? applyOwners(a.steps, owners.owners, new Set(owners.owners.filter((o): o is string => !!o))) : a.steps
  const settled: Approval | undefined = isPlanApproval(a) ? { ...a, status: statusOf(decision), ...(steps ? { steps } : {}) } : undefined
  const chat = chatId && a.workspaceId ? getState().chats[a.workspaceId]?.find((c) => c.id === chatId) : undefined
  const left = settled && decision.behavior === 'allow' && chat?.plan ? { ...chat, plan: false } : undefined
  if (row && chatId) actions.chats.upsertItem(chatId, row)
  if (settled) actions.approvals.upsert(settled)
  if (chat && left) actions.chats.upsert(left)
  return () => {
    if (row && chatId) actions.chats.dropItem(chatId, row)
    if (settled && getState().approvals.find((x) => x.id === a.id) === settled) actions.approvals.upsert(a)
    if (chat && left && chat.workspaceId && getState().chats[chat.workspaceId]?.find((c) => c.id === chat.id) === left) actions.chats.upsert(chat)
  }
}

/** A decision made in the chat: the answer shows at once, and goes again when the call fails, with the same toast as any decision (`title` names it). */
export async function decideInChat(a: Approval, decision: Decision, title = 'Could not send your answer'): Promise<boolean> {
  const undo = placeAnswerNow(a, decision)
  const ok = await attempt(title, () => call('approvals.decide', { id: a.id, decision: withOwners(a, decision) }))
  if (!ok) undo()
  return ok
}
