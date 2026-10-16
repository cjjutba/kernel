import { REVIEW_KINDS, type ChatItem, type TeamEventKind, type TeamUpdate, type TeamUpdateRow, type Workspace } from '@shared/types'
import { lensOf, reviewVerdicts } from '@shared/merge'

type UserItem = Extract<ChatItem, { kind: 'user' }>

/** The text Kernel sent the Lead, which Copy copies. */
const textOf = (item: UserItem) => item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')

/** The card's data: what Kernel saved with the update, or, for an update from before KERNEL-117, its lines read back. */
export function cardData(item: UserItem): TeamUpdate {
  return item.update ?? legacyRows(textOf(item))
}

/** Events that only say the chat's own PR went well. A blocker, failed check, conflict or requested change is never one (KERNEL-990). */
const isSuccess = (e: TeamUpdateRow['events'][number]) => ['pr.opened', 'pr.ready', 'pr.unblocked', 'pr.merged'].includes(e.kind) || (e.kind === 'pr.review' && eventTone(e) !== 'del')

/**
 * The rows of an older Team update left once the chat's own workspace's success-only rows are gone. In Build here those are
 * lines of the transcript now, so the card no longer repeats them (KERNEL-990). `selfId` is the chat's workspace.
 */
export const withoutSelfSuccess = (rows: TeamUpdateRow[], selfId: string | undefined): TeamUpdateRow[] =>
  selfId ? rows.filter((r) => r.workspaceId !== selfId || !r.events.length || !r.events.every(isSuccess) || !!r.shared?.length) : rows

/** Whether a Team update draws nothing in the chat `selfId`: every row it holds was about that chat's own PR going well. */
export const isHiddenUpdate = (item: UserItem, selfId: string | undefined): boolean => {
  const data = cardData(item)
  return !!selfId && data.rows.length > 0 && !data.omitted && withoutSelfSuccess(data.rows, selfId).length === 0
}

/** A review-only update, as the compact card: the reviewer's verdict without the "Team update" header (KERNEL-990). */
export const isReviewOnly = (rows: TeamUpdateRow[]) => rows.length > 0 && rows.every((r) => r.events.length > 0 && r.events.every((e) => e.kind === 'review' || e.kind === 'pr.review'))

/** "Approved PR #7" as "Approved", "Code review found 2 blockers on PR #7" as "Found 2 blockers": the PR is already in the line before it. */
export const verdictText = (text: string) => {
  const t = text.replace(/\.$/, '').replace(/^\S+ review (?=\S)/i, '').replace(/\s+(?:on|of|for)?\s*PR #\d+$/i, '')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** The workspace a row's Merge button merges: a reviewer's row merges the work it reviewed (`reviewOf`), every other row its own. */
export const mergeTargetOf = (ws: Pick<Workspace, 'id' | 'reviewOf'>) => ws.reviewOf ?? ws.id

/** The row's PR came to the Lead unmerged: the reviews still block it after the review rounds `[review] rounds` allows, so Kernel starts no more (KERNEL-552). */
export const isStillBlocked = (row: Pick<TeamUpdateRow, 'events'>) => row.events.some((e) => e.kind === 'pr.review' && /^Still blocked after \d+ review rounds?$/.test(e.text))

/** The row's PR merged because the user allowed it, and Kernel said so (KERNEL-556). */
export const mergedAutomatically = (row: Pick<TeamUpdateRow, 'events'>) => row.events.some((e) => e.kind === 'pr.merged' && e.text === 'Merged automatically')

/** What is still open on a PR: each blocker on its head commit, with the review it came from, as the reviews came in (KERNEL-557). */
export function openItems(ws: Pick<Workspace, 'reviews' | 'prNumber' | 'prHead'>): { kind: string; text: string }[] {
  return reviewVerdicts(ws).current.filter((v) => v.verdict === 'blockers').flatMap((v) => {
    const kind = REVIEW_KINDS.find((k) => k.id === lensOf(v))?.label ?? 'Code'
    return (v.blockers ?? []).map((b) => ({ kind, text: b.text }))
  })
}

/** The one row that offers Merge for a PR: a card's item id, and the workspace id of the row in it. */
export interface NewestRow { itemId: string; workspaceId: string }

const newest = new WeakMap<ChatItem[], WeakMap<Workspace[], Map<string, NewestRow>>>()

/**
 * For each workspace a PR belongs to, the one row in the chat that offers Merge for it (KERNEL-351): the newest card with a
 * row about the PR, and in that card the author's row when it has one, else the first reviewer's (KERNEL-581). Every other
 * row about the PR, in that card or an older one, keeps Open alone. Review rows carry no PR number, so a row is matched to
 * its target through its workspace. Kept per `items` and `workspaces` array, so every row of every card reads one map and
 * a new array is the only thing that rebuilds it.
 */
export function newestRows(items: ChatItem[] | undefined, workspaces: Workspace[]): Map<string, NewestRow> {
  if (!items) return EMPTY
  let byWorkspaces = newest.get(items)
  if (!byWorkspaces) newest.set(items, (byWorkspaces = new WeakMap()))
  let map = byWorkspaces.get(workspaces)
  if (map) return map
  map = new Map()
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  for (const item of items) {
    if (item.kind !== 'user' || !item.update) continue
    const inCard = new Map<string, string>()
    for (const row of item.update.rows) {
      const ws = byId.get(row.workspaceId)
      if (!ws) continue
      const target = mergeTargetOf(ws)
      if (!inCard.has(target) || row.workspaceId === target) inCard.set(target, row.workspaceId)
    }
    for (const [target, workspaceId] of inCard) map.set(target, { itemId: item.id, workspaceId })
  }
  byWorkspaces.set(workspaces, map)
  return map
}
const EMPTY = new Map<string, NewestRow>()

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
export function eventTone(e: { kind: TeamEventKind; text: string; actionable: boolean; held?: boolean }): 'del' | 'add' | 'merged' | 'ink2' | 'muted' {
  switch (e.kind) {
    case 'error': case 'crash': case 'setup.failed': case 'pr.cifail': case 'pr.changes': case 'pr.conflict': return 'del'
    case 'pr.merged': return 'merged'
    // GitHub no longer blocking a ready PR reads like the PR being ready (KERNEL-401). A block takes the default below.
    // A ready PR its review holds back is grey, beside the review's red (KERNEL-608, KERNEL-635).
    case 'pr.ready': case 'pr.unblocked': return e.held ? 'muted' : 'add'
    // "Approved PR #7", or with the kind of review in front since KERNEL-549: "Code review approved PR #7". Blockers are red.
    case 'review': return /^(?:\S+ review )?approved\b/i.test(e.text) ? 'add' : 'del'
    // A ready PR's review in the PRs tab's colors: an approval green, blockers red, the rest grey (KERNEL-411). Still blocked after the review rounds is red too (KERNEL-557).
    case 'pr.review': return / approved$/.test(e.text) ? 'add' : / found .*blockers?$/.test(e.text) || /^Still blocked after /.test(e.text) ? 'del' : 'muted'
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
