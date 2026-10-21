import type { ChangedFile, ChatItem } from '@shared/types'
import { parseMcp, SERVICE_NAME, toolView, type ToolService, type ToolView } from '@shared/toolView'
import { isQuitNote, userView } from './sender'

type Tool = Extract<ChatItem, { kind: 'tool' }>
export type NoteItem = Extract<ChatItem, { kind: 'note' }>

/** What a fold lists besides calls: the agent's thinking, and its in-between messages (KERNEL-840). */
type Step = Tool | Extract<ChatItem, { kind: 'thinking' }> | Extract<ChatItem, { kind: 'text' }>

/** Two or more calls in a row with the same service and verb. `items` is the calls and the thinking between them, in order. */
export interface Run { id: string; key: string; service?: ToolService; tools: Tool[]; items: ChatItem[]; done: number; failed: number; denied: number }

/** One row of a fold's list: a step, or a run of the same call. */
export type Entry = { kind: 'item'; item: ChatItem } | { kind: 'run'; run: Run }

/**
 * What the transcript draws. Every stretch of steps, in a finished turn or a running one, is one `group` row, the step in flight
 * included, so a collapsed fold shows nothing from inside it (KERNEL-784, amended).
 */
export type ThreadBlock =
  /** `actions` marks the last agent line of a stopped turn, or of one an app restart cut off: it carries the full actions where every other line only offers Copy (KERNEL-828). */
  | { kind: 'item'; item: ChatItem; actions?: true }
  /**
   * `current` is the one fold of a running turn that is doing the work now: it says Working or Waiting, and the folds before it say Worked.
   * `ends` is the fold a turn ended on, with no reply after it, so its last step stays in view under the closed header (KERNEL-1094).
   */
  | { kind: 'group'; id: string; items: ChatItem[]; entries: Entry[]; summary: Summary; turn: FoldTurn; current?: true; ends?: true }
  | { kind: 'files'; id: string; files: ChangedFile[] }
  /** A turn's time. `actions` is on a finished turn that doesn't end on text: the time line then carries Copy, Retry and the "..." menu, with `copy` the turn's last message when it has one (KERNEL-828). */
  | { kind: 'meta'; id: string; text: string; actions?: { copy?: string; files: boolean; checkpointId?: string } }
  /**
   * A finished turn's reply with the end of its turn under it: the changed files, then one line with how long the turn took
   * and when, and the reply's actions (KERNEL-346).
   */
  | { kind: 'reply'; id: string; item: Extract<ChatItem, { kind: 'text' }>; files?: ChangedFile[]; meta: string; checkpointId?: string }
  /** Two or more grey notes in a row, as one line: the latest and "and N more", which opens to all of them. A PR state note never joins one, and neither does an error. */
  | { kind: 'notes'; id: string; items: NoteItem[] }
  /** Kernel's message right after a quit or crash note, folded into that note's line: the line says what happened, opening it shows the message. */
  | { kind: 'relaunch'; id: string; note: Extract<ChatItem, { kind: 'note' }>; message: Extract<ChatItem, { kind: 'user' }> }
  /**
   * How a turn that didn't finish ended, as one quiet line (KERNEL-1094): you stopped it, it stopped on an error (the error itself is a toast) or at a usage limit, or the app quit under it, which offers Continue.
   * `ms` is how long it ran. A stopped or failed turn has its time line under this one.
   */
  | { kind: 'end'; id: string; why: 'stopped' | 'failed' | 'limit' | 'cut'; ms?: number }

/**
 * What a fold knows about its turn. `live` is a turn that hasn't ended: its folds show their steps. `timer` is on the turn's first fold. A header is
 * only the fold's summary, so the times don't reach it: `startedAt` (the turn's message) feeds the line at the end of a running turn, and `durationMs`
 * (the turn's result, or the stop's) the time under the reply. `short` is a turn that took under `SHORT_MS` or made one step, which folds without being seen to.
 */
export interface FoldTurn { live: boolean; timer: boolean; startedAt?: number; durationMs?: number; short: boolean }

export const SHORT_MS = 3000

/** A fold of only messages or thinking, which has no call to count. */
export const WORKING = 'Working'

export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

/** How long a fold's own steps took: from its first step to the end of its last, for a fold that isn't the turn's first, which has no time of its own. */
export function foldSpan(items: ChatItem[]): number | undefined {
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return undefined
  const ms = last.ts + (last.kind === 'tool' ? last.durationMs ?? 0 : 0) - first.ts
  // A fold of one quick step has no time worth saying.
  return ms >= 1000 ? ms : undefined
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
interface Tally { key: string; service?: ToolService; total: number; done: number; failed: number; denied: number; running?: number; verb?: string }

const noun = (p: Phrase, n: number) => (n === 1 ? p.one : p.many)

const article = (n: string) => `${/^[aeiou]/i.test(n) ? 'an' : 'a'} ${n}`

/**
 * "Filed 7 issues", "Filed 6 of 7 issues" when some didn't work, "Couldn't file 7 issues" when none did. Calls still running follow
 * in the present tense: "Ran 4 commands, running 1 more", or "Running a command" when none has finished. `alone` is the only phrase of
 * a summary, where one call reads "Ran a command".
 */
function count(t: Tally, alone = false): string {
  const running = t.running ?? 0
  // A call with no phrase of its own reads as its row does when it is alone ("Listed issue labels"), and as "Made 3 calls" when it isn't.
  if (!PHRASES[t.key] && t.total === 1 && t.verb) return t.verb
  const p = PHRASES[t.key] ?? OTHER
  if (running) {
    if (running === t.total) return `${p.ing} ${running === 1 ? article(p.one) : `${running} ${p.many}`}`
    return `${count({ ...t, total: t.total - running, running: 0 })}, ${p.ing.toLowerCase()} ${running} more`
  }
  const bad = t.failed + t.denied
  if (!bad) return alone && t.total === 1 ? `${p.ed} ${article(p.one)}` : `${p.ed} ${t.total} ${noun(p, t.total)}`
  if (!t.done) return t.denied === t.total ? `You denied ${t.total} ${noun(p, t.total)}` : `Couldn't ${p.base} ${t.total} ${noun(p, t.total)}`
  return `${p.ed} ${t.done} of ${t.total} ${noun(p, t.total)}`
}

/** What went wrong in a tally, as the red tail of a row: "1 failed", "2 denied", "1 failed, 2 denied". Empty when nothing did. */
const trouble = (failed: number, denied: number) => [failed && `${failed} failed`, denied && `${denied} denied`].filter(Boolean).join(', ')

const tally = (tools: Tool[], key: string, service?: ToolService): Tally => {
  const t: Tally = { key, service, total: tools.length, done: 0, failed: 0, denied: 0, running: 0, verb: tools[0] && viewOf(tools[0]).verb }
  for (const tool of tools) {
    const state = viewOf(tool).state
    if (state === 'running') t.running!++
    else if (state === 'failed' || state === 'stopped') t.failed++
    else if (state === 'denied') t.denied++
    else t.done++
  }
  return t
}

/** Whether the label already says it all: every call was denied, or every call failed, so a red "2 denied" after "You denied 2 commands" would say it twice. */
const told = (t: { total: number; done: number; failed: number; denied: number; running?: number }) => !t.running && !t.done && (t.denied === t.total || t.failed === t.total)

/** A run row's words: the sentence with its service, and what went wrong, which draws in red after it. */
export function runLabel(run: Run): { text: string; bad: string } {
  const at = run.service && run.service !== 'kernel' && run.service !== 'mcp' ? ` in ${SERVICE_NAME[run.service]}` : ''
  const t = { key: run.key, service: run.service, total: run.tools.length, done: run.done, failed: run.failed, denied: run.denied }
  return { text: `${count(t)}${at}`, bad: told(t) ? '' : trouble(run.failed, run.denied) }
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
    t.total += 1; t.done += one.done; t.failed += one.failed; t.denied += one.denied; t.running! += one.running!
  }
  const all = [...tallies.values()]
  const phrases = all.slice(0, SHOWN).map((t) => count(t, all.length === 1)).map((p, i) => (i ? lower(p) : p))
  const more = all.length - SHOWN
  const text = more > 0 ? `${phrases.join(', ')} and ${more} more` : phrases.join(', ')
  // A category past the shown phrases is only "and N more", which doesn't name its failure, so it keeps its tail.
  const untold = all.filter((t, i) => i >= SHOWN || !told(t))
  return { text, bad: trouble(untold.reduce((n, t) => n + t.failed, 0), untold.reduce((n, t) => n + t.denied, 0)) }
}

/** Thinking or a message with no text has nothing to show, so it never takes a row. */
const hasContent = (i: ChatItem) => (i.kind !== 'thinking' && i.kind !== 'text') || i.text.trim() !== ''

/** A message's row label: its first line with the Markdown taken off. The row cuts it to one line. */
export function messageLabel(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !/^(```|~~~|---+|\*\*\*+)$/.test(l)) ?? ''
  return line
    .replace(/^(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|[*_`])/g, '')
    .trim()
}

/**
 * The rows of a fold: the steps in order, with calls that read as the same verb on the same service folded into one run.
 * Thinking between two such calls doesn't break the run and stays inside it. A message does, and is its own row after the run. Hidden calls aren't listed.
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

/** The Lead's question tool, through Claude or Codex. Its card shows the question, and a row of raw JSON would say it twice. Claude's own AskUserQuestion is a step like any other: "Asked a question" and what it asked. */
const QUESTION_TOOLS = new Set(['mcp__kernel__ask_user'])

const isStep = (i: ChatItem): i is Step => i.kind === 'tool' || i.kind === 'thinking' || i.kind === 'text'

/**
 * A stretch of steps as blocks: one `group`, even for a single step, so a collapsed fold shows nothing from inside it. Its id is the
 * stretch's first item before anything is filtered out, so a fold the user opened never closes when a step appears or fills in.
 * `inFold` is a running turn that has made a call, where a stretch of only messages and thinking is a fold too ("Working"); otherwise
 * such a stretch is the agent talking and stays as it is.
 */
function foldBlocks(all: ChatItem[], blocks: ThreadBlock[], inFold: boolean, turn: FoldTurn) {
  const steps = all.filter(hasContent)
  const worked = steps.some((i) => i.kind === 'tool' && !viewOf(i).hidden)
  if (worked || (inFold && steps.length)) {
    const rows = steps.filter((i) => i.kind !== 'tool' || !viewOf(i).hidden)
    const summary = summarize(steps)
    blocks.push({ kind: 'group', id: `group-${all[0].id}`, items: steps, entries: rows.map((item): Entry => ({ kind: 'item', item })), summary: summary.text ? summary : { text: WORKING, bad: '' }, turn: { ...turn } })
    turn.timer = false
    return
  }
  for (const item of steps) blocks.push({ kind: 'item', item })
}

/**
 * Each stretch of steps between notes, approvals and questions folds into one row, the step in flight included (KERNEL-784). The agent's
 * messages are steps too (KERNEL-840), so once a running turn has made a call everything it writes goes in the fold, the reply included,
 * and appears in one piece when the turn ends. Notes, approvals and questions are never folded (KERNEL-800).
 */
function foldTurn(turn: ChatItem[], blocks: ThreadBlock[], info: FoldTurn) {
  let steps: ChatItem[] = []
  const inFold = info.live && turn.some((i) => i.kind === 'tool')
  const flush = () => {
    if (!steps.length) return
    // A running turn's newest message reads under its fold as it is written, and so does the one just before a card, so the reader sees what the agent says without opening the fold (KERNEL-1094).
    // A step that follows takes it into the fold.
    const tail = info.live && steps.length > 1 && steps[steps.length - 1].kind === 'text' ? steps.pop() : undefined
    foldBlocks(steps, blocks, inFold, info)
    if (tail) blocks.push({ kind: 'item', item: tail })
    steps = []
  }
  for (const item of turn) {
    if (isStep(item)) steps.push(item)
    else { flush(); blocks.push({ kind: 'item', item }) }
  }
  flush()
}

/**
 * Split items into turns at each user message. A turn that finished well (it has an ok `result`) shows
 * its reply, the files it changed and how long it took, and folds each stretch of steps before the reply into one group, with the
 * notes and approvals between them left as they are (KERNEL-800).
 * When the reply is the turn's last row, those three are one `reply` block, so its actions share the time's line. A turn that ends on a
 * step instead puts the actions on the time's line (KERNEL-828). Every other agent line offers Copy alone.
 * Every agent message before the reply is a step in that fold (KERNEL-840), so the turn reads as the user's message, one fold and the reply.
 * A turn still running folds all its steps, the one in flight too (`running` says whether the chat's turn is). A stopped one, a failed one and one an app
 * restart cut off fold the same way, with one quiet line under the fold that says how it ended (KERNEL-1094).
 */
export function buildThread(items: ChatItem[], running = false): ThreadBlock[] {
  const blocks: ThreadBlock[] = []
  let turn: ChatItem[] = []
  let startedAt: number | undefined
  const foot = (block: Extract<ThreadBlock, { kind: 'meta' | 'reply' }>) => { blocks.push(block) }
  const finish = (open = false) => {
    const result = turn.find((i): i is Extract<ChatItem, { kind: 'result' }> => i.kind === 'result')
    const stop = turn.find((i) => i.kind === 'interrupted')
    const live = open && !result && !stop
    // A turn the app quit under has no result and no stop. Its time is from the message to the end of its last step.
    const last = turn[turn.length - 1]
    const cutMs = !result && !stop && last && startedAt !== undefined ? Math.max(0, last.ts + (last.kind === 'tool' ? last.durationMs ?? 0 : 0) - startedAt) : undefined
    const durationMs = result ? result.durationMs : stop && startedAt !== undefined ? Math.max(0, stop.ts - startedAt) : cutMs
    const seen = turn.filter((i) => isStep(i) && hasContent(i) && !(i.kind === 'tool' && viewOf(i).hidden)).length
    // Every fold of the turn shares this, so the first one to be drawn takes the duration.
    const info: FoldTurn = { live, timer: true, startedAt, durationMs, short: seen <= 1 || (durationMs !== undefined && durationMs < SHORT_MS) }
    if (live) {
      const from = blocks.length
      foldTurn(turn, blocks, info)
      // Only the last fold is working now. The ones before it, which a card or a note split off, are done.
      const folds = blocks.slice(from).filter((b): b is Extract<ThreadBlock, { kind: 'group' }> => b.kind === 'group')
      folds.forEach((g, n) => { if (n < folds.length - 1) g.turn = { ...g.turn, live: false }; else g.current = true })
      turn = []
      return
    }
    if (!result?.ok) {
      // A turn that ended badly folds like a finished one: you stopped it, it failed, or the app quit under it. Its last message stays out of the fold, then comes one quiet line
      // that says how it ended, then the time and the actions. A turn a quit note already speaks for gets no line of its own.
      const over = turn.map((i) => i.kind).lastIndexOf('result')
      const after = over < 0 ? [] : turn.slice(over + 1)
      const body = (over < 0 ? turn : turn.slice(0, over)).filter((i) => i.kind !== 'result' && i.kind !== 'interrupted')
      const tail = body.map((i) => i.kind).lastIndexOf('text')
      foldTurn(tail < 0 ? body : body.slice(0, tail), blocks, info)
      if (tail >= 0) {
        blocks.push({ kind: 'item', item: body[tail] })
        foldTurn(body.slice(tail + 1), blocks, info)
      }
      const folded = blocks[blocks.length - 1]
      if (folded?.kind === 'group') folded.ends = true
      const why = stop ? 'stopped' : result ? (result.limit ? 'limit' : 'failed') : 'cut'
      if (result || stop || (body.some((i) => i.kind === 'tool') && !body.some(isQuitNote))) blocks.push({ kind: 'end', id: `end-${(result ?? stop ?? last).id}`, why, ...(durationMs !== undefined ? { ms: durationMs } : {}) })
      if (result) {
        const copy = tail >= 0 ? (body[tail] as Extract<ChatItem, { kind: 'text' }>).text : undefined
        foot({ kind: 'meta', id: result.id, text: `${fmtDuration(result.durationMs)} · ${fmtClock(result.ts)}`, actions: { ...(copy ? { copy } : {}), files: false, ...(result.checkpointId ? { checkpointId: result.checkpointId } : {}) } })
      }
      // Notes written after the turn ended come after its end, as they do after a turn that finished.
      for (const item of after) blocks.push({ kind: 'item', item })
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
    foldTurn(before, blocks, info)
    const meta = `${fmtDuration(result.durationMs)} · ${fmtClock(result.ts)}`
    const reply = rest[rest.length - 1]
    // A turn that ends on a step, with no message after it, keeps that step in view under its fold.
    const folded = blocks[blocks.length - 1]
    if (reply?.kind !== 'text' && !rest.length && folded?.kind === 'group') folded.ends = true
    if (reply?.kind === 'text') {
      for (const item of rest.slice(0, -1)) blocks.push({ kind: 'item', item })
      foot({ kind: 'reply', id: reply.id, item: reply, ...(result.files?.length ? { files: result.files } : {}), meta, ...(result.checkpointId ? { checkpointId: result.checkpointId } : {}) })
    } else {
      for (const item of rest) blocks.push({ kind: 'item', item })
      if (result.files?.length) blocks.push({ kind: 'files', id: `files-${result.id}`, files: result.files })
      const copy = [...body].reverse().find((i): i is Extract<ChatItem, { kind: 'text' }> => i.kind === 'text')?.text
      foot({ kind: 'meta', id: result.id, text: meta, actions: { ...(copy ? { copy } : {}), files: !!result.files?.length, ...(result.checkpointId ? { checkpointId: result.checkpointId } : {}) } })
    }
    for (const item of after) blocks.push({ kind: 'item', item })
    turn = []
  }
  for (const item of items) {
    if (item.kind === 'tool' && QUESTION_TOOLS.has(item.name)) continue
    if (item.kind === 'user') {
      finish()
      startedAt = item.ts
      const view = userView(item)
      const last = blocks[blocks.length - 1]
      if (view === 'hidden') continue
      if (view === 'note' && last?.kind === 'item' && last.item.kind === 'note' && isQuitNote(last.item)) blocks[blocks.length - 1] = { kind: 'relaunch', id: last.item.id, note: last.item, message: item }
      else blocks.push({ kind: 'item', item })
    } else turn.push(item)
  }
  finish(running)
  return foldNotes(blocks)
}

const isGrey = (b: ThreadBlock): b is { kind: 'item'; item: NoteItem } => b.kind === 'item' && b.item.kind === 'note' && !b.item.pr

/** Two or more grey notes in a row become one `notes` block. A PR state note, an error or any other block ends the run. */
function foldNotes(blocks: ThreadBlock[]): ThreadBlock[] {
  const out: ThreadBlock[] = []
  for (let i = 0; i < blocks.length; i++) {
    if (!isGrey(blocks[i])) { out.push(blocks[i]); continue }
    let end = i
    while (end + 1 < blocks.length && isGrey(blocks[end + 1])) end++
    if (end === i) { out.push(blocks[i]); continue }
    const items = blocks.slice(i, end + 1).map((b) => (b as { item: NoteItem }).item)
    out.push({ kind: 'notes', id: `notes-${items[0].id}`, items })
    i = end
  }
  return out
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
  return { title: `${rows.length} ${rows.length === 1 ? 'file' : 'files'} changed`, added, removed, shown: fold ? rows.slice(0, FOLD_SHOWN) : rows, hidden, hiddenAdded: more.added, hiddenRemoved: more.removed }
}
