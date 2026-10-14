import type { ChangedFile, ChatItem } from '@shared/types'
import { parseMcp, SERVICE_NAME, toolView, type ToolService, type ToolView } from '@shared/toolView'
import { isQuitNote, userView } from './sender'

type Tool = Extract<ChatItem, { kind: 'tool' }>

/** Two or more calls in a row with the same service and verb. `items` is the calls and the thinking between them, in order. */
export interface Run { id: string; key: string; service?: ToolService; tools: Tool[]; items: ChatItem[]; done: number; failed: number; denied: number }

/** One row of a fold's list: a step, or a run of the same call. */
export type Entry = { kind: 'item'; item: ChatItem } | { kind: 'run'; run: Run }

/**
 * What the transcript draws. A finished turn folds its work into one `group` row, and a turn still running folds each stretch of
 * finished steps the same way, with the step in flight as a `live` line under them (KERNEL-784).
 */
export type ThreadBlock =
  | { kind: 'item'; item: ChatItem }
  | { kind: 'group'; id: string; items: ChatItem[]; entries: Entry[]; summary: Summary }
  | { kind: 'run'; id: string; run: Run }
  | { kind: 'live'; id: string; item: Tool | Extract<ChatItem, { kind: 'thinking' }> }
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

/** A call's view without a workspace, kept per item. Items keep their identity until they change, so a 500-step turn computes each view once. */
const views = new WeakMap<Tool, ToolView>()
const viewOf = (item: Tool): ToolView => {
  let v = views.get(item)
  if (!v) views.set(item, (v = toolView(item)))
  return v
}

/** What a call is, apart from how it went: one name for every call that reads as the same verb on the same service. */
function keyOf(item: Tool, view: ToolView): string {
  const mcp = parseMcp(item.name)
  if (mcp) {
    const i = item.input ?? {}
    if (view.service === 'linear' && mcp.tool === 'save_issue') return i.id || i.issueId || i.issue ? 'linear:update' : 'linear:file'
    if (view.service === 'linear' && mcp.tool === 'save_comment') return 'linear:comment'
    if (view.service === 'kernel') return mcp.tool === 'create_workspace' ? 'kernel:hand' : mcp.tool === 'message_agent' ? 'kernel:message' : `kernel:${mcp.tool}`
    return `${view.service ?? 'mcp'}:${mcp.tool}`
  }
  if (view.unknown) return 'unknown'
  switch (item.name) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit'
    case 'Grep': case 'Glob': return 'search'
    case 'Task': return 'agent'
    default: return item.name.toLowerCase()
  }
}

/** A verb in its three forms and what its calls touch, for the run row and the summary. */
interface Phrase { ed: string; ing: string; base: string; one: string; many: string }

const phrase = (ed: string, ing: string, base: string, one: string, many = `${one}s`): Phrase => ({ ed, ing, base, one, many })

const PHRASES: Record<string, Phrase> = {
  read: phrase('Read', 'Reading', 'read', 'file'), edit: phrase('Edited', 'Editing', 'edit', 'file'), write: phrase('Wrote', 'Writing', 'write', 'file'),
  bash: phrase('Ran', 'Running', 'run', 'command'), search: phrase('Ran', 'Running', 'run', 'search', 'searches'), webfetch: phrase('Fetched', 'Fetching', 'fetch', 'page'),
  websearch: phrase('Ran', 'Running', 'run', 'web search', 'web searches'), agent: phrase('Ran', 'Running', 'run', 'agent'), skill: phrase('Used', 'Using', 'use', 'skill'),
  'linear:file': phrase('Filed', 'Filing', 'file', 'issue'), 'linear:update': phrase('Updated', 'Updating', 'update', 'issue'), 'linear:comment': phrase('Commented on', 'Commenting on', 'comment on', 'issue'),
  'kernel:hand': phrase('Handed off', 'Handing off', 'hand off', 'task'), 'kernel:message': phrase('Sent', 'Sending', 'send', 'message'), 'kernel:share_file': phrase('Shared', 'Sharing', 'share', 'file')
}

PHRASES.unknown = phrase('Used', 'Using', 'use', 'tool')

const OTHER = phrase('Made', 'Making', 'make', 'call')

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** What a call count touched and how it went. `total` counts every call, `done` the ones that worked. */
interface Tally { key: string; service?: ToolService; total: number; done: number; failed: number; denied: number; verb?: string }

const noun = (p: Phrase, n: number) => (n === 1 ? p.one : p.many)

/** "Filed 7 issues", "Filed 6 of 7 issues" when some didn't work, "Couldn't file 7 issues" when none did. */
function count(t: Tally): string {
  // A call with no phrase of its own reads as its row does when it is alone ("Listed issue labels"), and as "Made 3 calls" when it isn't.
  if (!PHRASES[t.key] && t.total === 1 && t.verb) return t.verb
  const p = PHRASES[t.key] ?? OTHER
  const bad = t.failed + t.denied
  if (!bad) return `${p.ed} ${t.total} ${noun(p, t.total)}`
  if (!t.done) return t.denied === t.total ? `You denied ${t.total} ${noun(p, t.total)}` : `Couldn't ${p.base} ${t.total} ${noun(p, t.total)}`
  return `${p.ed} ${t.done} of ${t.total} ${noun(p, t.total)}`
}

/** What went wrong in a tally, as the red tail of a row: "1 failed", "2 denied", "1 failed, 2 denied". Empty when nothing did. */
const trouble = (failed: number, denied: number) => [failed && `${failed} failed`, denied && `${denied} denied`].filter(Boolean).join(', ')

const tally = (tools: Tool[], key: string, service?: ToolService): Tally => {
  const t: Tally = { key, service, total: tools.length, done: 0, failed: 0, denied: 0, verb: tools[0] && viewOf(tools[0]).verb }
  for (const tool of tools) {
    const state = viewOf(tool).state
    if (state === 'failed' || state === 'stopped') t.failed++
    else if (state === 'denied') t.denied++
    else t.done++
  }
  return t
}

/** A run row's words: the sentence with its service, and what went wrong, which draws in red after it. */
export function runLabel(run: Run): { text: string; bad: string } {
  const at = run.service && run.service !== 'kernel' && run.service !== 'mcp' ? ` in ${SERVICE_NAME[run.service]}` : ''
  return { text: `${count({ key: run.key, service: run.service, total: run.tools.length, done: run.done, failed: run.failed, denied: run.denied })}${at}`, bad: trouble(run.failed, run.denied) }
}

export interface Summary { text: string; bad: string }

const SHOWN = 3

/** A turn's work as a sentence: "Read 6 files, ran 3 commands, filed 7 issues". Three phrases at most, then "and N more". What went wrong follows as `bad`. */
export function summarize(items: ChatItem[]): Summary {
  const tallies = new Map<string, Tally>()
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const view = viewOf(item)
    if (view.hidden) continue
    const key = keyOf(item, view)
    const t = tallies.get(key)
    if (!t) { tallies.set(key, tally([item], key, view.service)); continue }
    const one = tally([item], key)
    t.total += 1; t.done += one.done; t.failed += one.failed; t.denied += one.denied
  }
  const all = [...tallies.values()]
  const phrases = all.slice(0, SHOWN).map(count).map((p, i) => (i ? lower(p) : p))
  const more = all.length - SHOWN
  const text = more > 0 ? `${phrases.join(', ')} and ${more} more` : phrases.join(', ')
  return { text, bad: trouble(all.reduce((n, t) => n + t.failed, 0), all.reduce((n, t) => n + t.denied, 0)) }
}

/** Thinking with no text has nothing to show, so it never takes a row. */
const hasContent = (i: ChatItem) => i.kind !== 'thinking' || i.text.trim() !== ''

/**
 * The rows of a fold: the steps in order, with calls that read as the same verb on the same service folded into one run.
 * Thinking between two such calls doesn't break the run and stays inside it. A message does. Hidden calls aren't listed.
 */
export function entriesOf(all: ChatItem[]): Entry[] {
  const items = all.filter(hasContent)
  const entries: Entry[] = []
  let run: Run | undefined
  let thoughts: ChatItem[] = []
  const flush = () => {
    if (run) entries.push(run.tools.length > 1 ? { kind: 'run', run } : { kind: 'item', item: run.tools[0] })
    for (const t of thoughts) entries.push({ kind: 'item', item: t })
    run = undefined
    thoughts = []
  }
  for (const item of items) {
    if (item.kind === 'tool') {
      const view = viewOf(item)
      if (view.hidden) continue
      const key = keyOf(item, view)
      if (run && run.key === key) {
        run.items.push(...thoughts, item)
        run.tools.push(item)
        thoughts = []
      } else {
        flush()
        run = { id: `run-${item.id}`, key, service: view.service, tools: [item], items: [item], done: 0, failed: 0, denied: 0 }
      }
    } else if (item.kind === 'thinking' && run) thoughts.push(item)
    else { flush(); entries.push({ kind: 'item', item }) }
  }
  flush()
  for (const e of entries) if (e.kind === 'run') Object.assign(e.run, countOf(e.run))
  return entries
}

function countOf(run: Run) {
  const { done, failed, denied } = tally(run.tools, run.key)
  return { done, failed, denied }
}

/**
 * A fold's steps as blocks. A fold of one row isn't a fold, so a lone run or step is drawn as it is. Inside a fold every call is a
 * plain row in one flat list, and the summary line is the only tally.
 */
function foldBlocks(all: ChatItem[], blocks: ThreadBlock[]) {
  const steps = all.filter(hasContent)
  const entries = entriesOf(steps)
  if (entries.length > 1 && steps.some((i) => i.kind === 'tool' && !viewOf(i).hidden)) {
    const rows = steps.filter((i) => i.kind !== 'tool' || !viewOf(i).hidden)
    blocks.push({ kind: 'group', id: `group-${steps[0].id}`, items: steps, entries: rows.map((item): Entry => ({ kind: 'item', item })), summary: summarize(steps) })
    return
  }
  for (const e of entries) blocks.push(e.kind === 'run' ? { kind: 'run', id: e.run.id, run: e.run } : { kind: 'item', item: e.item })
}

/** The tools whose call is a question to the user: Claude's, and the Lead's through Claude or Codex. Their card shows the question, so a row of raw JSON would say it twice. */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'mcp__kernel__ask_user'])

const isStep = (i: ChatItem): i is Tool | Extract<ChatItem, { kind: 'thinking' }> => i.kind === 'tool' || i.kind === 'thinking'

/**
 * Each stretch of steps between messages, approvals and notes folds into one row, and with `open` the step in flight stays out of
 * the fold as the `live` line (KERNEL-784). Messages, notes, approvals and questions are never folded, in a running turn or a finished one (KERNEL-800).
 */
function foldTurn(turn: ChatItem[], blocks: ThreadBlock[], open: boolean) {
  let steps: ChatItem[] = []
  const flush = (last: boolean) => {
    const tail = steps[steps.length - 1]
    const live = open && last && tail && ((tail.kind === 'tool' && tail.status === 'running') || tail.kind === 'thinking') ? tail : undefined
    foldBlocks(live ? steps.slice(0, -1) : steps, blocks)
    if (live && isStep(live)) blocks.push({ kind: 'live', id: live.id, item: live })
    steps = []
  }
  for (const item of turn) {
    if (isStep(item)) steps.push(item)
    else { flush(false); blocks.push({ kind: 'item', item }) }
  }
  flush(true)
}

/**
 * Split items into turns at each user message. A turn that finished well (it has an ok `result`) shows
 * its reply, the files it changed and how long it took, and folds each stretch of steps before the reply into one group, with the
 * agent's messages, notes and approvals between them left as they are (KERNEL-800).
 * When the reply is the turn's last row, those three are one `reply` block, so its actions share the time's line.
 * A turn still running folds its finished steps (`running` says whether the chat's turn is). A stopped or failed one shows every item,
 * so nothing is hidden while it matters.
 */
export function buildThread(items: ChatItem[], running = false): ThreadBlock[] {
  const blocks: ThreadBlock[] = []
  let turn: ChatItem[] = []
  const finish = (open = false) => {
    const result = turn.find((i): i is Extract<ChatItem, { kind: 'result' }> => i.kind === 'result')
    if (open && !result && !turn.some((i) => i.kind === 'interrupted')) {
      foldTurn(turn, blocks, true)
      turn = []
      return
    }
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
    const rest = body.slice(lastText < 0 ? body.length : lastText)
    foldTurn(before, blocks, false)
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
  finish(running)
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
