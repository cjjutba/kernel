import type { Approval, ChatItem, Decision } from '@shared/types'
import { answerItemId, answerParts } from '@shared/approvalAnswer'
import { call } from '../../../api'
import { actions } from '../../../store'
import { attempt } from '../MessageActions'
import { isPlanApproval } from './steps'

/**
 * The row the engine will place for a decision made in the chat (`placeAnswer`), built from the decision before the call returns. A typed send shows at
 * once, so an answer does too, and it anchors the same way. The id is the engine's, so its row replaces this one in place and the answer is never drawn twice.
 * Nothing when the card has no answer (a tool permission), or for a plan's change request with images, which main saves first and words itself.
 */
export function answerRow(a: Approval, decision: Decision, ts = Date.now()): ChatItem | undefined {
  if (decision.behavior === 'deny' && decision.images?.length) return undefined
  const status = decision.behavior === 'allow' ? 'allowed' : decision.behavior === 'deny' ? 'denied' : 'answered'
  const answer = decision.behavior === 'answer' ? decision.text
    : decision.behavior === 'deny' && isPlanApproval(a) ? decision.message?.trim() || undefined
    : a.answer
  const parts = answerParts({ ...a, status, answer, answers: decision.behavior === 'answer' ? decision.answers ?? a.answers : a.answers })
  return parts ? { kind: 'user', id: answerItemId(a.id), ts, parts, approvalId: a.id } : undefined
}

/** Puts the answer in the chat now. Returns what undoes it when the call fails: it removes only this row, so one the engine has replaced it with stays. */
export function placeAnswerNow(a: Approval, decision: Decision): () => void {
  const row = a.chatId ? answerRow(a, decision) : undefined
  if (!row || !a.chatId) return () => undefined
  const chatId = a.chatId
  actions.chats.upsertItem(chatId, row)
  return () => actions.chats.dropItem(chatId, row)
}

/** A decision made in the chat: the answer shows at once, and goes again when the call fails, with the same toast as any decision (`title` names it). */
export async function decideInChat(a: Approval, decision: Decision, title = 'Could not send your answer'): Promise<boolean> {
  const undo = placeAnswerNow(a, decision)
  const ok = await attempt(title, () => call('approvals.decide', { id: a.id, decision }))
  if (!ok) undo()
  return ok
}
