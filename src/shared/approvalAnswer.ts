import type { Approval, ChatItem, ChatPart } from './types'

/**
 * What the user said on a plan, question or agent card, as their own message in the chat (KERNEL-836). Pure, so the engine
 * writes the same words the window shows.
 */

type Answerable = Pick<Approval, 'kind' | 'toolName' | 'agentFile' | 'status' | 'answer' | 'questions' | 'answers' | 'images'>

/** The answered list for several questions, in the order asked. Nothing when the answers were not kept, so the plain line shows. */
export function answeredList(a: Pick<Approval, 'questions' | 'answers'>): { question: string; answer: string }[] | undefined {
  const qs = a.questions
  if (!qs || qs.length < 2 || !a.answers) return undefined
  return qs.map((q) => ({ question: q.question, answer: a.answers?.[q.question] ?? '' }))
}

/** What the user's bubble says under a settled plan: "Approved", or the notes of Request changes. Nothing for an expired plan, which says why instead. */
export function planAnswer(a: Pick<Approval, 'status' | 'answer'>): string | undefined {
  if (a.status === 'allowed') return 'Approved'
  if (a.status === 'denied' || a.status === 'answered') return a.answer?.trim() || 'Changes requested'
  return undefined
}

/** What the user's bubble says under an answered question: one line per answer, in the order asked. Nothing when no answer was kept. */
export function questionAnswer(a: Pick<Approval, 'status' | 'answer' | 'questions' | 'answers'>): string | undefined {
  if (a.status !== 'answered') return undefined
  const list = answeredList(a)
  if (list) return list.map((r) => r.answer).join('\n')
  return a.answer?.trim() || undefined
}

/** What the user's bubble says under an agent proposal: Approve, or Not now. Nothing while it waits or once it expired. */
export function agentAnswer(a: Pick<Approval, 'status'>): string | undefined {
  if (a.status === 'allowed') return 'Approve'
  if (a.status === 'denied') return 'Not now'
  return undefined
}

/** The user's answer to a plan, question or agent card, by kind. Nothing for a tool permission, whose Allow or Deny is not a message. */
export function approvalAnswer(a: Answerable): string | undefined {
  if (a.kind === 'plan' || a.toolName === 'ExitPlanMode') return planAnswer(a)
  if (a.kind === 'question') return questionAnswer(a)
  if (a.kind === 'agent' || a.agentFile) return agentAnswer(a)
  return undefined
}

/** The answer as a user message's parts: its text, then the images of Request changes. Nothing when the card has no answer. */
export function answerParts(a: Answerable): ChatPart[] | undefined {
  const text = approvalAnswer(a)
  return text ? [{ type: 'text', text }, ...(a.images ?? [])] : undefined
}

/** The transcript row that holds the user's answer to approval `approvalId`. One per approval, so a second settle replaces it. */
export const answerItemId = (approvalId: string) => `answer-${approvalId}`

/** A user row that is the user's answer to a card: drawn as their bubble, never sent to the agent. */
export const isAnswerItem = (i: ChatItem): boolean => i.kind === 'user' && !!i.approvalId && !i.from

/** A user row the agent received as a prompt: every user row but an answer to a card. */
export const isSentItem = (i: ChatItem): i is ChatItem & { kind: 'user' } => i.kind === 'user' && !isAnswerItem(i)
