import { linkText } from '@shared/links'
import { toolAsk } from '@shared/toolView'
import type { Approval, AskedQuestion, ChatPart, Decision, PlanStep } from '@shared/types'
import { leadingTitle, parseBlocks, type Block } from '../mdParse'

type PlanSource = Pick<Approval, 'steps' | 'detail' | 'input'>

/**
 * Before KERNEL-373 the Lead stored only its numbered steps in `detail` ("1. task\n2. task"), the same tasks as `steps`.
 * That is a plain list with one item per step and nothing else, so it adds no write-up and the rows already show it.
 */
function restatesSteps(text: string, steps: PlanStep[]): boolean {
  const blocks = parseBlocks(text)
  const [list] = blocks
  return blocks.length === 1 && list.type === 'ol' && list.items.length === steps.length && list.items.every((i) => !i.children.length && i.checked === undefined)
}

/**
 * A plan's markdown, from `detail` or ExitPlanMode's input. The Lead's plan carries its write-up here next to `steps`.
 * Empty for an older Lead plan whose `detail` only restates its steps, so the tasks show once.
 */
export function planText(a: PlanSource): string {
  const text = a.detail || String((a.input as { plan?: unknown } | undefined)?.plan ?? '')
  return a.steps?.length && restatesSteps(text, a.steps) ? '' : text
}

/** Markdown markers dropped, for one-line rows. */
export const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/\n+/g, ' ').trim()

const listItems = (blocks: Block[]) => blocks.flatMap((b) => (b.type === 'ol' || b.type === 'ul' ? b.items : []))

/**
 * The rows of a plan as a task list. The Lead sends `steps`, next to the write-up. A plan-mode plan with sections gives one row per section
 * heading; one without gives its list items, and plain lines as a last resort.
 */
export function planSteps(a: PlanSource): PlanStep[] {
  if (a.steps?.length) return a.steps
  const text = planText(a)
  const blocks = parseBlocks(text)
  const sections = (leadingTitle(blocks) ? blocks.slice(1) : blocks).filter((b) => b.type === 'h')
  if (sections.length) return sections.map((h) => ({ title: plain(h.type === 'h' ? h.text : '') }))
  const items = listItems(blocks)
  if (items.length) return items.map((i) => ({ title: plain(i.text) }))
  return text.split('\n').map((l) => plain(l.replace(/^\s*(\d+[.)]|[-*])\s+/, ''))).filter(Boolean).map((title) => ({ title }))
}

/** True when the plan is one short list and nothing else, which reads best as numbered rows. A Lead plan with a write-up is a document, then its rows. */
export function isStepList(a: PlanSource): boolean {
  if (a.steps?.length) return !planText(a).trim()
  const blocks = parseBlocks(planText(a))
  return blocks.length > 0 && blocks.every((b) => (b.type === 'ol' || b.type === 'ul') && b.items.every((i) => !i.children.length && i.checked === undefined))
}

/** The plan's own heading when it opens with one, else the approval's title ("Plan for invoice-table"). */
export function planTitle(a: PlanSource & Pick<Approval, 'title'>): string {
  return leadingTitle(parseBlocks(planText(a))) ?? a.title
}

export const isPlanApproval = (a: Pick<Approval, 'kind' | 'toolName'>) => a.kind === 'plan' || a.toolName === 'ExitPlanMode'

/** "Plan for T-15 is ready", or "Plan ready: Export invoices" when the title doesn't start with Plan. The Home list and the chat hover card say it this way. */
export const planReadyLine = (a: Pick<Approval, 'title'>): string => (/^Plan\b/i.test(a.title) ? `${a.title} is ready` : `Plan ready: ${a.title}`)

/**
 * What a tool permission asks, by the agent who asks: "Sean wants to run a command", "wants to edit a file", "wants to file
 * issue in Linear: Export invoices as PDF" or "wants to use WebFetch". The approval card and the chat hover card say it this way.
 */
export function permissionTitle(a: Pick<Approval, 'toolName' | 'input'>, who: string): string {
  const input = (a.input ?? {}) as Record<string, unknown>
  if (a.toolName === 'Bash') return `${who} wants to run a command`
  if (a.toolName?.startsWith('mcp__')) { const ask = toolAsk(a.toolName, input); return `${who} wants to ${ask.charAt(0).toLowerCase()}${ask.slice(1)}` }
  return String(input.file_path ?? input.path ?? '') ? `${who} wants to edit a file` : `${who} wants to use ${a.toolName ?? 'a tool'}`
}

/** The plan waiting on you in this chat, if any. Its Copy and Approve go on the composer. */
export function waitingPlan(approvals: Approval[], chat: { id: string; workspaceId: string }): Approval | undefined {
  return approvals.find((a) => a.status === 'pending' && isPlanApproval(a) && (a.chatId ? a.chatId === chat.id : a.workspaceId === chat.workspaceId))
}

/** Composer chips as the text of a "Request changes" note: what was typed, pasted text inline, files by path. */
export function noteFromParts(parts: ChatPart[]): string {
  return parts.map((p) => {
    if (p.type === 'text') return p.text
    if (p.type === 'skill') return `/${p.name}`
    if (p.type === 'file') return p.text ? `<pasted name="${p.name}">\n${p.text}\n</pasted>` : `@${p.path ?? p.name}`
    if (p.type === 'agent') return `@${p.name}`
    if (p.type === 'issue' || p.type === 'workspace') return linkText(p)
    return ''
  }).filter((t) => t.trim()).join(' ').trim()
}

/** What a resolved approval says in place of its buttons. */
export function outcome(a: Approval): string {
  switch (a.status) {
    case 'allowed': return a.kind === 'plan' || a.kind === 'agent' ? 'Approved' : a.kind === 'tool' ? 'Allowed' : 'Approved'
    case 'denied': return a.kind === 'plan' ? 'Changes requested' : 'Denied'
    case 'answered': return a.answer ? `You answered: ${a.answer}` : 'Answered'
    default: return a.expiredBy ? EXPIRED_BY[a.expiredBy] : 'Expired'
  }
}

/** Why a plan card expired, when it says (`expiredBy`). */
const EXPIRED_BY: Record<NonNullable<Approval['expiredBy']>, string> = { replaced: 'Replaced by a newer plan', closed: 'Chat closed', archived: 'Workspace archived' }

/** What one question holds while you step through them: the options ticked, and a typed answer when Something else is on. */
export interface Picked { sel: string[]; other: boolean; text: string }

export const emptyPick = (): Picked => ({ sel: [], other: false, text: '' })

/**
 * Several questions, or any that takes more than one answer, step with tabs, Back and Next. One single-select question has none of
 * those: you pick a row and press Send, like the last step of a longer one. Every pending question renders as the same card.
 */
export const isStepped = (a: Pick<Approval, 'questions'>): boolean => (a.questions?.length ?? 0) > 1 || !!a.questions?.some((q) => q.multiSelect)

/** Next or Send waits until something is checked, and until Something else has text. */
export const pickReady = (p: Picked): boolean => (p.sel.length > 0 || p.other) && (!p.other || !!p.text.trim())

/** Every question has an answer, so Send is the next move. */
export const allAnswered = (picks: Picked[]): boolean => picks.every(pickReady)

/** The next question without an answer after `from`, wrapping to the start. -1 when every other question has one. */
export function nextUnanswered(picks: Picked[], from: number): number {
  for (let k = 1; k < picks.length; k++) {
    const i = (from + k) % picks.length
    if (!pickReady(picks[i])) return i
  }
  return -1
}

/** One question's answer: the ticked labels in the order asked, then the typed text, joined with ", ". */
export function pickAnswer(q: AskedQuestion, p: Picked): string {
  const labels = q.options.map((o) => o.label).filter((l) => p.sel.includes(l))
  return [...labels, ...(p.other && p.text.trim() ? [p.text.trim()] : [])].join(', ')
}

/** The one decision that sends every answer: keyed by question text, joined with " · " for display. */
export function answerDecision(questions: AskedQuestion[], picks: Picked[]): Extract<Decision, { behavior: 'answer' }> {
  const answers: Record<string, string> = {}
  questions.forEach((q, i) => { answers[q.question] = pickAnswer(q, picks[i] ?? emptyPick()) })
  return { behavior: 'answer', text: Object.values(answers).join(' · '), answers }
}

/** The answered list for several questions, in the order asked. Nothing when the answers were not kept, so the plain line shows. */
export function answeredList(a: Pick<Approval, 'questions' | 'answers'>): { question: string; answer: string }[] | undefined {
  const qs = a.questions
  if (!qs || qs.length < 2 || !a.answers) return undefined
  return qs.map((q) => ({ question: q.question, answer: a.answers?.[q.question] ?? '' }))
}
