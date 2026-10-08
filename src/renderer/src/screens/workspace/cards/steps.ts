import { linkText } from '@shared/links'
import type { Approval, ChatPart, PlanStep } from '@shared/types'
import { leadingTitle, parseBlocks, type Block } from '../mdParse'

type PlanSource = Pick<Approval, 'steps' | 'detail' | 'input'>

/** A plan-mode plan's markdown, from `detail` or ExitPlanMode's input. Empty for the Lead's task list, which comes as `steps`. */
export function planText(a: PlanSource): string {
  return a.steps?.length ? '' : a.detail || String((a.input as { plan?: unknown } | undefined)?.plan ?? '')
}

/** Markdown markers dropped, for one-line rows. */
export const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/\n+/g, ' ').trim()

const listItems = (blocks: Block[]) => blocks.flatMap((b) => (b.type === 'ol' || b.type === 'ul' ? b.items : []))

/**
 * The rows of a plan as a task list. Rowan sends `steps`. A plan-mode plan with sections gives one row per section
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

/** True when the plan is one short list and nothing else, which reads best as numbered rows (WorkspacePlan.png). */
export function isStepList(a: PlanSource): boolean {
  if (a.steps?.length) return true
  const blocks = parseBlocks(planText(a))
  return blocks.length > 0 && blocks.every((b) => (b.type === 'ol' || b.type === 'ul') && b.items.every((i) => !i.children.length && i.checked === undefined))
}

/** The plan's own heading when it opens with one, else the approval's title ("Plan for invoice-table"). */
export function planTitle(a: PlanSource & Pick<Approval, 'title'>): string {
  return leadingTitle(parseBlocks(planText(a))) ?? a.title
}

export const isPlanApproval = (a: Pick<Approval, 'kind' | 'toolName'>) => a.kind === 'plan' || a.toolName === 'ExitPlanMode'

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
    default: return 'Expired'
  }
}
