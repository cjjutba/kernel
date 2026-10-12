import type { ChatItem, TeamUpdateEvent } from '@shared/types'
import { instructionOf } from './pr/model'
import { userView } from './sender'
import { cardData } from './cards/teamUpdate'

/** One thing the chat rail lists: a message the user sent, or in Rowan's chat a Team update. `more` counts the update's rows after the first. */
export interface RailEntry { id: string; label: string; more: number; update: boolean }

/** The rail is hidden until the chat has this many entries to list. */
export const RAIL_MIN = 2

/** A message's top sits this far under the tab row once a jump lands, and the item in view is the newest one whose top is at or above that line, give or take a pixel of rounding. */
export const JUMP_OFFSET = 16
const PASSED_PX = JUMP_OFFSET + 1
/** The view counts as at the bottom this close to the end, so the last entry is the one in view. A chat that follows its end rests 8px short of it, on the scroll area's bottom padding. */
const BOTTOM_PX = 12
/** A row never needs more than a line of the message. */
const LABEL_MAX = 160

type UserItem = Extract<ChatItem, { kind: 'user' }>

/** The first line of what the user wrote, or the name of the first chip when they sent only a file or an image. */
function messageLabel(item: UserItem): string {
  const text = item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')
  const line = text.split('\n').map((l) => l.trim()).find(Boolean)
  return (line ?? item.parts.find((p) => p.type !== 'text')?.name ?? 'Message').slice(0, LABEL_MAX)
}

/** "Opened PR #7" reads "opened PR #7" after the name, and "PR #7 merged" and "PR ready" keep their capitals. */
const lower = (text: string) => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text)

/** The event in a few words for a row after the teammate's name, from the wording the card already saved. */
function eventWords(e: TeamUpdateEvent): string {
  switch (e.kind) {
    case 'pr.ready': case 'pr.unblocked': return 'PR ready'
    case 'pr.cifail': return 'checks failed'
    case 'pr.changes': return 'changes requested'
    case 'pr.conflict': return 'PR has conflicts'
    case 'pr.blocked': return 'PR blocked'
    case 'pr.closed': return 'PR closed'
    // "Approved PR #7", "Code review approved PR #7", "Found 2 blockers in PR #7": the reviewer's name leads the row, so the verdict is all it says.
    case 'review': return /\bapproved\b/i.test(e.text) ? 'approved' : /found \d+ blockers?/i.exec(e.text)?.[0].toLowerCase() ?? lower(e.text)
    default: return lower(e.text)
  }
}

/** A Team update as the first teammate in it and that teammate's newest event, "Kai, PR ready", and how many more rows it has. Nothing for an update that has no rows, which the thread draws as Kernel's note. */
export function updateLabel(item: UserItem): { label: string; more: number } | undefined {
  const rows = cardData(item).rows
  const row = rows[0]
  if (!row) return undefined
  // A ready PR's review follows its event as a grey segment of its own, so the event before it is the news.
  const event = [...row.events].reverse().find((e) => e.kind !== 'pr.review') ?? row.events.at(-1)
  const words = event ? eventWords(event) : row.shared?.length ? 'shared a file' : ''
  return { label: words ? `${row.name}, ${words}` : row.name, more: rows.length - 1 }
}

/**
 * What the rail lists, oldest first: the messages the user sent, as the thread draws them in a bubble, and in Rowan's chat the
 * Team updates (KERNEL-599). Replies, tool calls, Kernel's notes and the instruction cards a button sent are not listed.
 */
export function railEntries(items: ChatItem[], lead: boolean): RailEntry[] {
  const out: RailEntry[] = []
  for (const item of items) {
    if (item.kind !== 'user') continue
    const view = userView(item)
    if (view === 'update') {
      const u = lead ? updateLabel(item) : undefined
      if (u) out.push({ id: item.id, label: u.label, more: u.more, update: true })
    } else if (view === 'bubble' && !instructionOf(item)) {
      out.push({ id: item.id, label: messageLabel(item), more: 0, update: false })
    }
  }
  return out
}

/**
 * The entry in view: the newest one whose top has passed the top of the view, or the last one when the view is at the bottom. `tops`
 * are each entry's distance from the view's top, oldest first, and NaN for one that isn't on the page. Before the first entry's top has
 * passed, the first is the one in view.
 */
export function entryInView(tops: number[], atBottom: boolean): number {
  if (!tops.length) return -1
  if (atBottom) return tops.length - 1
  let at = 0
  tops.forEach((top, i) => { if (top <= PASSED_PX) at = i })
  return at
}

/** The same entries again, so the rail keeps the list it has while a streamed reply redraws the transcript. */
export const sameEntries = (a: RailEntry[], b: RailEntry[]) => a.length === b.length && a.every((e, i) => e.id === b[i].id && e.label === b[i].label && e.more === b[i].more && e.update === b[i].update)

/** What a key does to the list: open or move the active row, jump to it, or close. Nothing for a key the rail leaves alone. */
export function railKey(key: string, s: { open: boolean; active: number; count: number }): { open: boolean; active: number; jump?: boolean } | undefined {
  const last = s.count - 1
  switch (key) {
    case 'ArrowDown': return { open: true, active: s.open ? Math.min(last, s.active + 1) : s.active }
    case 'ArrowUp': return { open: true, active: s.open ? Math.max(0, s.active - 1) : s.active }
    case 'Home': return { open: true, active: 0 }
    case 'End': return { open: true, active: last }
    // Closed, Enter is the button's own press and opens the list.
    case 'Enter': return s.open ? { open: false, active: s.active, jump: true } : undefined
    case 'Escape': return s.open ? { open: false, active: s.active } : undefined
    default: return undefined
  }
}

/** Whether a scroll box is at its end, as far as the rail cares. */
export const atEnd = (box: { scrollHeight: number; scrollTop: number; clientHeight: number }) => box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_PX

/** Each mark is 2px with 6px between them, the 8px the canvas draws, until the stack would be taller than the room it has. */
const MARK = 2
const GAP = 6

/** The room a stack of `count` marks has left for itself in a column `height` tall: 12px of rail padding and 12px clear above and below. Returns the mark's height and the gap between marks, tightening the gap first and the marks only once they touch. */
export function markFit(count: number, height: number): { mark: number; gap: number } {
  const room = height - 36
  if (count < 2 || room <= 0) return { mark: MARK, gap: GAP }
  const gap = (room - MARK * count) / (count - 1)
  if (gap >= GAP) return { mark: MARK, gap: GAP }
  return gap >= 0 ? { mark: MARK, gap } : { mark: room / count, gap: 0 }
}
