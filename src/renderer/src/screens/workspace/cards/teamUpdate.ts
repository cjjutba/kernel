import type { ChatItem, TeamEventKind, TeamUpdate, TeamUpdateRow } from '@shared/types'

type UserItem = Extract<ChatItem, { kind: 'user' }>

/** The text Kernel sent the Lead, which Copy copies. */
export const textOf = (item: UserItem) => item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')

/** The card's data: what Kernel saved with the update, or, for an update from before KERNEL-117, its lines read back. */
export function cardData(item: UserItem): TeamUpdate {
  return item.update ?? legacyRows(textOf(item))
}

/** Rows in the order the Lead read them, grouped under the closed Lead chat they came from, when they did. */
export function sections(rows: TeamUpdateRow[]): { fromChat?: string; rows: TeamUpdateRow[] }[] {
  const out: { fromChat?: string; rows: TeamUpdateRow[] }[] = []
  for (const row of rows) {
    const last = out.at(-1)
    if (last && last.fromChat === row.fromChat) last.rows.push(row)
    else out.push({ ...(row.fromChat ? { fromChat: row.fromChat } : {}), rows: [row] })
  }
  return out
}

/** A task that starts with an issue key ("KERNEL-182 New chats focus the composer") split so the card can set the key apart. */
export function taskParts(task: string): { key?: string; title: string } {
  const m = /^([A-Z][A-Z0-9]+-\d+)\s+(.+)$/.exec(task)
  return m ? { key: m[1], title: m[2] } : { title: task }
}

/**
 * The color an event's words take on the card (KERNEL-274): red for what needs fixing, violet for a merge, green for what
 * passed or was approved. Everything else stays grey, and an event that needs the Lead without one of those is brighter.
 */
export function eventTone(e: { kind: TeamEventKind; text: string; actionable: boolean }): 'del' | 'add' | 'merged' | 'ink2' | 'muted' {
  switch (e.kind) {
    case 'error': case 'crash': case 'setup.failed': case 'pr.cifail': case 'pr.changes': case 'pr.conflict': return 'del'
    case 'pr.merged': return 'merged'
    case 'pr.ready': case 'setup.passed': return 'add'
    case 'review': return /^Approved/.test(e.text) ? 'add' : 'del'
    default: return e.actionable ? 'ink2' : 'muted'
  }
}

// The lines of an update before KERNEL-117: "- Kai · Inbox actions (workspace <id>): PR #54 is ready to merge".
const LINE = /^- (.+?) · (.+?) \(workspace ([^)]+)\): (.+)$/
const CLOSED = /^From "(.+)", a Lead chat that is now closed:$/
const LEFT_OUT = /^- (\d+) earlier updates? (?:are|is) left out\.$/
const TURN = /^finished a turn: "(.*)"$/

const KINDS: [RegExp, TeamEventKind][] = [
  [/^opened /, 'pr.opened'], [/is ready to merge$/, 'pr.ready'], [/^checks failed/, 'pr.cifail'], [/^changes were requested/, 'pr.changes'],
  [/has conflicts/, 'pr.conflict'], [/was merged$/, 'pr.merged'], [/was closed/, 'pr.closed'], [/^stopped with an error/, 'error']
]

/** An update from before KERNEL-117, read back into rows: one per workspace, its events in order, a finished turn's excerpt as the reply. */
export function legacyRows(text: string): TeamUpdate {
  const rows: TeamUpdateRow[] = []
  let fromChat: string | undefined
  let omitted = 0
  for (const line of text.split('\n').slice(1)) {
    const closed = CLOSED.exec(line)
    if (closed) { fromChat = closed[1]; continue }
    const left = LEFT_OUT.exec(line)
    if (left) { omitted += Number(left[1]); continue }
    const m = LINE.exec(line)
    if (!m) continue
    const [, name, task, workspaceId, what] = m
    let row = rows.find((r) => r.workspaceId === workspaceId && r.fromChat === fromChat)
    if (!row) { row = { workspaceId, agentId: '', name, task, events: [], ...(fromChat ? { fromChat } : {}) }; rows.push(row) }
    const turn = TURN.exec(what)
    if (turn) { row.events.push({ kind: 'turn', text: 'Finished a turn', actionable: true }); row.reply = turn[1]; continue }
    // The PR number comes from the PR's own lines, not from a reply that mentions one.
    const pr = /PR #(\d+)/.exec(what)
    if (pr && !row.prNumber) row.prNumber = Number(pr[1])
    row.events.push({ kind: KINDS.find(([re]) => re.test(what))?.[1] ?? 'turn', text: what.charAt(0).toUpperCase() + what.slice(1), actionable: true })
  }
  return { rows, ...(omitted ? { omitted } : {}) }
}
