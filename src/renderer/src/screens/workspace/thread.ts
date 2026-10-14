import type { ChangedFile, ChatItem } from '@shared/types'
import { isQuitNote, userView } from './sender'

/** What the transcript draws. A finished turn folds its work into one `group` row. */
export type ThreadBlock =
  | { kind: 'item'; item: ChatItem }
  | { kind: 'group'; id: string; tools: Extract<ChatItem, { kind: 'tool' }>[]; messages: number; items: ChatItem[] }
  | { kind: 'files'; id: string; files: ChangedFile[] }
  | { kind: 'meta'; id: string; text: string }
  /**
   * A finished turn's reply with the end of its turn under it: the changed files, then one line with how long the turn took
   * and when, and the reply's actions (KERNEL-346).
   */
  | { kind: 'reply'; id: string; item: Extract<ChatItem, { kind: 'text' }>; files?: ChangedFile[]; meta: string; checkpointId?: string }
  /** Kernel's message right after a quit or crash note, folded into that note's line: the line says what happened, opening it shows the message. */
  | { kind: 'relaunch'; id: string; note: Extract<ChatItem, { kind: 'note' }>; message: Extract<ChatItem, { kind: 'user' }> }
  /** A turn that ended badly. `output` is what the last failed tool printed. */
  | { kind: 'error'; id: string; message: string; output?: string }

export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

export const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

/** "14 tool calls, 3 messages". Messages are the thinking and text that came before the reply. */
export function groupLabel(tools: number, messages: number): string {
  const calls = `${tools} tool ${tools === 1 ? 'call' : 'calls'}`
  return messages ? `${calls}, ${messages} ${messages === 1 ? 'message' : 'messages'}` : calls
}

const work = (i: ChatItem) => i.kind === 'tool' || i.kind === 'thinking' || i.kind === 'text'

/** The tools whose call is a question to the user: Claude's, and the Lead's through Claude or Codex. Their card shows the question, so a row of raw JSON would say it twice. */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'mcp__kernel__ask_user'])

/**
 * Split items into turns at each user message. A turn that finished well (it has an ok `result`) shows
 * its reply, the files it changed and how long it took, and folds everything before the reply into one group.
 * When the reply is the turn's last row, those three are one `reply` block, so its actions share the time's line.
 * A turn still running, stopped or failed shows every item, so nothing is hidden while it matters.
 */
export function buildThread(items: ChatItem[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = []
  let turn: ChatItem[] = []
  const finish = () => {
    const result = turn.find((i): i is Extract<ChatItem, { kind: 'result' }> => i.kind === 'result')
    if (!result?.ok) {
      const stopped = turn.some((i) => i.kind === 'interrupted')
      const failedTool = [...turn].reverse().find((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool' && i.status === 'failed')
      for (const item of turn) {
        if (item.kind !== 'result') blocks.push({ kind: 'item', item })
        else if (stopped || item.ok) blocks.push({ kind: 'meta', id: item.id, text: `${fmtDuration(item.durationMs)} · ${fmtClock(item.ts)}` })
        else blocks.push({ kind: 'error', id: item.id, message: item.error ?? 'The turn failed', output: failedTool?.output })
      }
      turn = []
      return
    }
    // Notes written after the turn ended (a PR merged or failed its checks) come after the turn's meta line.
    const end = turn.map((i) => i.kind).lastIndexOf('result')
    const after = turn.slice(end + 1)
    const body = turn.slice(0, end).filter((i) => i.kind !== 'result')
    let lastText = -1
    body.forEach((i, n) => { if (i.kind === 'text') lastText = n })
    const before = body.slice(0, lastText < 0 ? body.length : lastText)
    const folded = before.filter(work)
    // A note the turn began with ("Now on Personal", KERNEL-568) stays above the work it announces, not below its folded row.
    const first = before.findIndex(work)
    const opening: ChatItem[] = first < 0 ? [] : before.slice(0, first).filter((i) => i.kind === 'note')
    const rest = [...before.filter((i) => !work(i) && !opening.includes(i)), ...body.slice(lastText < 0 ? body.length : lastText)]
    for (const item of opening) blocks.push({ kind: 'item', item })
    const tools = folded.filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool')
    if (tools.length) blocks.push({ kind: 'group', id: `group-${tools[0].id}`, tools, messages: folded.length - tools.length, items: folded })
    else for (const item of folded) blocks.push({ kind: 'item', item })
    const meta = `${fmtDuration(result.durationMs)} · ${fmtClock(result.ts)}`
    const reply = rest[rest.length - 1]
    if (reply?.kind === 'text') {
      for (const item of rest.slice(0, -1)) blocks.push({ kind: 'item', item })
      blocks.push({ kind: 'reply', id: reply.id, item: reply, ...(result.files?.length ? { files: result.files } : {}), meta, ...(result.checkpointId ? { checkpointId: result.checkpointId } : {}) })
    } else {
      for (const item of rest) blocks.push({ kind: 'item', item })
      if (result.files?.length) blocks.push({ kind: 'files', id: `files-${result.id}`, files: result.files })
      blocks.push({ kind: 'meta', id: result.id, text: meta })
    }
    for (const item of after) blocks.push({ kind: 'item', item })
    turn = []
  }
  for (const item of items) {
    if (item.kind === 'tool' && QUESTION_TOOLS.has(item.name)) continue
    if (item.kind === 'user') {
      finish()
      const view = userView(item)
      const last = blocks[blocks.length - 1]
      if (view === 'hidden') continue
      if (view === 'note' && last?.kind === 'item' && last.item.kind === 'note' && isQuitNote(last.item)) blocks[blocks.length - 1] = { kind: 'relaunch', id: last.item.id, note: last.item, message: item }
      else blocks.push({ kind: 'item', item })
    } else turn.push(item)
  }
  finish()
  return blocks
}

/** One row of the turn files card: the file's name, its folder, what happened to it and what a screen reader says (KERNEL-586). */
export interface TurnFileRow { path: string; name: string; dir: string; marker?: 'New' | 'Deleted' | 'Renamed'; deleted: boolean; added: number; removed: number; label: string }

const WHAT: Record<ChangedFile['status'], string> = { A: 'new', '?': 'new', D: 'deleted', R: 'renamed', M: 'edited' }
const MARKER: Partial<Record<ChangedFile['status'], TurnFileRow['marker']>> = { A: 'New', '?': 'New', D: 'Deleted', R: 'Renamed' }

/** "31 added, 12 removed". A side that is 0 is left out. */
export const countsLabel = (added: number, removed: number) => [added ? `${added} added` : '', removed ? `${removed} removed` : ''].filter(Boolean).join(', ')

const sum = (rows: { added: number; removed: number }[]) => ({ added: rows.reduce((n, r) => n + r.added, 0), removed: rows.reduce((n, r) => n + r.removed, 0) })

function turnFileRow(f: ChangedFile): TurnFileRow {
  const cut = f.path.lastIndexOf('/')
  return {
    path: f.path, name: f.path.slice(cut + 1), dir: cut < 0 ? '' : f.path.slice(0, cut), marker: MARKER[f.status], deleted: f.status === 'D', added: f.added, removed: f.removed,
    label: [f.path, WHAT[f.status], countsLabel(f.added, f.removed)].filter(Boolean).join(', ')
  }
}

/** Up to this many files show in full. One more and the card shows `FOLD_SHOWN` and folds the rest, so the fold never hides a single file. */
const FOLD_AT = 6
const FOLD_SHOWN = 5

/** The reply's files card: its title and totals, the files in the order given, and the rows a fold hides with their totals. */
export function turnFiles(files: ChangedFile[]): { title: string; added: number; removed: number; shown: TurnFileRow[]; hidden: TurnFileRow[]; hiddenAdded: number; hiddenRemoved: number } {
  const rows = files.map(turnFileRow)
  const fold = rows.length > FOLD_AT
  const hidden = fold ? rows.slice(FOLD_SHOWN) : []
  const { added, removed } = sum(rows)
  const more = sum(hidden)
  return { title: `${rows.length} ${rows.length === 1 ? 'file' : 'files'} changed in this reply`, added, removed, shown: fold ? rows.slice(0, FOLD_SHOWN) : rows, hidden, hiddenAdded: more.added, hiddenRemoved: more.removed }
}
