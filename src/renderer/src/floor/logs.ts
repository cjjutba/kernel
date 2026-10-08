import type { ActivityEvent } from '@shared/types'
import { dayLabel } from './layout'

/** One row in the Logs: an event, or an agent's run of tool calls shown as its newest call with the earlier ones folded under it. */
export interface LogRow {
  id: string
  ts: number
  event: ActivityEvent
  /** Earlier tool calls in the same run, or earlier events folded into this one, newest first. Empty for a plain event. */
  earlier: ActivityEvent[]
  /** Set when `earlier` holds events of the same kind folded under this one (`event` is the newest). */
  fold?: LogFold
}

/** How a folded row reads: "assigned 4 tasks". */
export interface LogFold { verb: string; one: string; many: string }

/** Kinds the Logs hide until Show everything is on: lifecycle noise, not what the team did. A failed tool call still shows. */
const QUIET: ActivityEvent['kind'][] = ['session.start', 'session.end', 'turn.done', 'tool.start', 'tool.end', 'workspace.archived', 'workspace.restored', 'agent.status']

/** Hidden by default: the kinds above, and the note Kernel logs when it updates the Lead (D-070). */
export const isQuiet = (e: ActivityEvent) => QUIET.includes(e.kind) || (e.kind === 'note' && e.data?.leadUpdate === true)

/** The plural noun that lets a kind fold with its neighbors. Kinds with no entry never fold. */
export function foldOf(e: ActivityEvent): LogFold | undefined {
  const task = (verb: string): LogFold => ({ verb, one: 'task', many: 'tasks' })
  const workspace = (verb: string): LogFold => ({ verb, one: 'workspace', many: 'workspaces' })
  switch (e.kind) {
    case 'workspace.archived': return workspace('archived')
    case 'workspace.restored': return workspace('restored')
    case 'workspace.created': return e.text.startsWith('assigned') ? task('assigned') : workspace('started')
    case 'task.assigned': return task('assigned')
    case 'task.created': return e.text === 'created' ? task('created') : undefined
    case 'task.completed': return e.text === 'finished' || e.text === 'completed' ? task(e.text) : undefined
    default: return undefined
  }
}

const STEPS: ActivityEvent['kind'][] = ['tool.start', 'tool.end', 'tool.failed']
/** A pause this long between two tool calls starts a new run. */
export const RUN_GAP_MS = 5 * 60_000

const useId = (e: ActivityEvent) => (typeof e.data?.toolUseId === 'string' ? e.data.toolUseId : undefined)

/**
 * The room's events (newest first) as log rows, newest first.
 * A tool call logs when it starts and when it ends: once it ends, only the end shows. A delegation already has its
 * "delegated to" line, so the end of that call is left out. Tool calls by one agent fold into one row until the agent
 * does something else (finishes its turn, messages someone) or pauses for `RUN_GAP_MS`.
 * Unless `everything` is set, quiet events (`isQuiet`) are left out. They still end a run, as any other event does.
 * A workspace's "started" line is left out too when the Lead logged "assigned" for it.
 * Then neighbors of one kind fold into a single row (`foldOf`), within one day.
 */
export function logRows(events: ActivityEvent[], everything = false): LogRow[] {
  const starts = new Map<string, ActivityEvent>()
  const ended = new Set<string>()
  const talks = new Set<string>()
  // The Lead's hand-off logs "started" for the agent's workspace and then "assigned" for the Lead. The second says it all.
  const assigned = new Set<string>()
  for (const e of events) {
    if (e.kind === 'workspace.created' && e.text.startsWith('assigned') && e.workspaceId) assigned.add(e.workspaceId)
    const id = useId(e)
    if (!id) continue
    if (e.kind === 'tool.start') starts.set(id, e)
    else if (e.kind === 'tool.end' || e.kind === 'tool.failed') ended.add(id)
    else if (e.kind === 'agent.talk') talks.add(id)
  }

  const rows: LogRow[] = []
  const runs = new Map<string, LogRow>()
  for (let i = events.length - 1; i >= 0; i--) {
    let e = events[i]
    const id = useId(e)
    if (id && e.kind === 'tool.start' && ended.has(id)) continue
    if (id && e.kind === 'tool.end' && talks.has(id)) continue
    // Ends logged before the end carried its own object borrow the start's.
    if (id && !e.object && e.kind !== 'tool.start' && starts.get(id)?.object) e = { ...e, object: starts.get(id)!.object }
    const who = e.agentId ?? e.workspaceId ?? e.sessionId ?? ''
    if (!everything && e.kind === 'workspace.created' && e.workspaceId && assigned.has(e.workspaceId) && !e.text.startsWith('assigned')) continue
    if (!everything && isQuiet(e)) {
      if (!STEPS.includes(e.kind)) runs.delete(who)
      continue
    }
    if (!STEPS.includes(e.kind)) {
      runs.delete(who)
      rows.push({ id: e.id, ts: e.ts, event: e, earlier: [] })
      continue
    }
    const run = runs.get(who)
    if (run && e.ts - run.ts <= RUN_GAP_MS) {
      run.earlier.unshift(run.event)
      run.event = e
      run.ts = e.ts
    } else {
      const row: LogRow = { id: e.id, ts: e.ts, event: e, earlier: [] }
      rows.push(row)
      runs.set(who, row)
    }
  }
  // A run moves up as it grows. Reversed first so rows logged in the same millisecond keep newest first.
  return fold(rows.reverse().sort((a, b) => b.ts - a.ts))
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

/** Neighbors of one kind and verb on one day become one row: the newest on top, the rest under `earlier`. */
function fold(rows: LogRow[]): LogRow[] {
  const out: LogRow[] = []
  let group: LogRow | undefined
  let key = ''
  for (const r of rows) {
    const f = r.earlier.length === 0 ? foldOf(r.event) : undefined
    const k = f ? `${r.event.kind}:${f.verb}` : ''
    if (f && group && k === key && sameDay(group.ts, r.ts)) {
      group.earlier.push(r.event)
      // The row keeps the oldest id, so it stays open as newer events join it.
      group.id = r.id
      continue
    }
    out.push(r)
    group = f ? r : undefined
    key = k
    if (f) r.fold = f
  }
  // A row nothing folded under is a plain event.
  for (const r of out) if (r.fold && r.earlier.length === 0) delete r.fold
  return out
}

/** The names in a folded row's line: "Rowan", "Theo and Noor", "Theo, Noor and Kai". */
export function foldWho(names: string[]): string {
  const list = [...new Set(names)]
  return list.length < 2 ? list[0] ?? '' : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** "assigned 4 tasks" */
export const foldWhat = (f: LogFold, count: number) => `${f.verb} ${count} ${count === 1 ? f.one : f.many}`

/** "Theo, Noor and Kai archived 8 workspaces" */
export const foldText = (names: string[], f: LogFold, count: number) => `${foldWho(names)} ${foldWhat(f, count)}`

/** Rows under their day heading, newest day first. */
export function byDay(rows: LogRow[], now = Date.now()): { label: string; rows: LogRow[] }[] {
  const days: { label: string; rows: LogRow[] }[] = []
  for (const r of rows) {
    const label = dayLabel(r.ts, now)
    const last = days[days.length - 1]
    if (last?.label === label) last.rows.push(r)
    else days.push({ label, rows: [r] })
  }
  return days
}

/**
 * The days of the log, newest first. A day whose events are all hidden keeps its heading with no rows.
 * Events with no day to show (none at all) give no days.
 */
export function logDays(events: ActivityEvent[], everything = false, now = Date.now()): { label: string; rows: LogRow[] }[] {
  const days = byDay(logRows(events, everything), now)
  const labels = [...events].sort((a, b) => b.ts - a.ts).map((e) => dayLabel(e.ts, now))
  return [...new Set(labels)].map((label) => days.find((d) => d.label === label) ?? { label, rows: [] })
}

/** "3 earlier tool calls", or "3 earlier failed tool calls" when the run is all failures */
export const earlierLabel = (n: number, failed = false) => `${n} earlier ${failed ? 'failed ' : ''}tool ${n === 1 ? 'call' : 'calls'}`
