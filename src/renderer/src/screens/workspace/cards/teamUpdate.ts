import type { ChatItem, TeamEventKind, TeamUpdate, TeamUpdateRow, Workspace } from '@shared/types'

type UserItem = Extract<ChatItem, { kind: 'user' }>

/** The text Kernel sent the Lead, which Copy copies. */
export const textOf = (item: UserItem) => item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')

/** The card's data: what Kernel saved with the update, or, for an update from before KERNEL-117, its lines read back. */
export function cardData(item: UserItem): TeamUpdate {
  return item.update ?? legacyRows(textOf(item))
}

/** The workspace a row's Merge button merges: a reviewer's row merges the work it reviewed (`reviewOf`), every other row its own. */
export const mergeTargetOf = (ws: Pick<Workspace, 'id' | 'reviewOf'>) => ws.reviewOf ?? ws.id

const newest = new WeakMap<ChatItem[], WeakMap<Workspace[], Map<string, string>>>()

/**
 * For each workspace a PR belongs to, the id of the newest item in the chat with a Team update row about it (KERNEL-351). Only
 * that row offers Merge, so older cards about the same PR keep Open alone. Review rows carry no PR number, so a row is
 * matched to its target through its workspace. Kept per `items` and `workspaces` array, so every row of every card reads
 * one map and a new array is the only thing that rebuilds it.
 */
export function newestRows(items: ChatItem[] | undefined, workspaces: Workspace[]): Map<string, string> {
  if (!items) return EMPTY
  let byWorkspaces = newest.get(items)
  if (!byWorkspaces) newest.set(items, (byWorkspaces = new WeakMap()))
  let map = byWorkspaces.get(workspaces)
  if (map) return map
  map = new Map()
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  for (const item of items) {
    if (item.kind !== 'user' || !item.update) continue
    for (const row of item.update.rows) {
      const ws = byId.get(row.workspaceId)
      if (ws) map.set(mergeTargetOf(ws), item.id)
    }
  }
  byWorkspaces.set(workspaces, map)
  return map
}
const EMPTY = new Map<string, string>()

/** Rows in the order the Lead read them, grouped under the closed Lead chat, or closed tab (`fromTab`), they came from, when they did. */
export function sections(rows: TeamUpdateRow[]): { fromChat?: string; fromTab?: boolean; rows: TeamUpdateRow[] }[] {
  const out: { fromChat?: string; fromTab?: boolean; rows: TeamUpdateRow[] }[] = []
  for (const row of rows) {
    const last = out.at(-1)
    if (last && last.fromChat === row.fromChat && !!last.fromTab === !!row.fromTab) last.rows.push(row)
    else out.push({ ...(row.fromChat ? { fromChat: row.fromChat } : {}), ...(row.fromTab ? { fromTab: true } : {}), rows: [row] })
  }
  return out
}

/** A task that starts with an issue key ("KERNEL-182 New chats focus the composer") split so the card can set the key apart. */
export function taskParts(task: string): { key?: string; title: string } {
  const m = /^([A-Z][A-Z0-9]+-\d+)\s+(.+)$/.exec(task)
  return m ? { key: m[1], title: m[2] } : { title: task }
}

/**
 * The color an event's words take on the card (KERNEL-274): red for what needs fixing, violet for a merge, green for a PR
 * ready to merge or an approval. Everything else stays grey, and an event that needs the Lead without one of those is brighter.
 */
export function eventTone(e: { kind: TeamEventKind; text: string; actionable: boolean }): 'del' | 'add' | 'merged' | 'ink2' | 'muted' {
  switch (e.kind) {
    case 'error': case 'crash': case 'setup.failed': case 'pr.cifail': case 'pr.changes': case 'pr.conflict': return 'del'
    case 'pr.merged': return 'merged'
    // GitHub no longer blocking a ready PR reads like the PR being ready (KERNEL-401). A block takes the default below.
    case 'pr.ready': case 'pr.unblocked': return 'add'
    case 'review': return /^Approved/.test(e.text) ? 'add' : 'del'
    default: return e.actionable ? 'ink2' : 'muted'
  }
}

// The lines of an update before KERNEL-117: "- Kai · Inbox actions (workspace <id>): PR #54 is ready to merge".
const LINE = /^- (.+?) · (.+?) \(workspace ([^)]+)\): (.+)$/
const CLOSED = /^From "(.+)", (a Lead chat that is now closed|a tab you closed):$/
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
  let fromTab = false
  let omitted = 0
  for (const line of text.split('\n').slice(1)) {
    const closed = CLOSED.exec(line)
    if (closed) { fromChat = closed[1]; fromTab = closed[2] === 'a tab you closed'; continue }
    const left = LEFT_OUT.exec(line)
    if (left) { omitted += Number(left[1]); continue }
    const m = LINE.exec(line)
    if (!m) continue
    const [, name, task, workspaceId, what] = m
    let row = rows.find((r) => r.workspaceId === workspaceId && r.fromChat === fromChat && !!r.fromTab === fromTab)
    if (!row) { row = { workspaceId, agentId: '', name, task, events: [], ...(fromChat ? { fromChat } : {}), ...(fromChat && fromTab ? { fromTab } : {}) }; rows.push(row) }
    const turn = TURN.exec(what)
    if (turn) { row.events.push({ kind: 'turn', text: 'Finished a turn', actionable: true }); row.reply = turn[1]; continue }
    // The PR number comes from the PR's own lines, not from a reply that mentions one.
    const pr = /PR #(\d+)/.exec(what)
    if (pr && !row.prNumber) row.prNumber = Number(pr[1])
    row.events.push({ kind: KINDS.find(([re]) => re.test(what))?.[1] ?? 'turn', text: what.charAt(0).toUpperCase() + what.slice(1), actionable: true })
  }
  return { rows, ...(omitted ? { omitted } : {}) }
}
