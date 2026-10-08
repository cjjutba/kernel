import type { ActivityEvent } from '@shared/types'
import { dayLabel } from './layout'

/** One row in the Logs: an event, or an agent's run of tool calls shown as its newest call with the earlier ones folded under it. */
export interface LogRow {
  id: string
  ts: number
  event: ActivityEvent
  /** Earlier tool calls in the same run, newest first. Empty for a plain event. */
  earlier: ActivityEvent[]
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
 */
export function logRows(events: ActivityEvent[]): LogRow[] {
  const starts = new Map<string, ActivityEvent>()
  const ended = new Set<string>()
  const talks = new Set<string>()
  for (const e of events) {
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
  return rows.reverse().sort((a, b) => b.ts - a.ts)
}

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

/** "3 earlier tool calls" */
export const earlierLabel = (n: number) => `${n} earlier tool ${n === 1 ? 'call' : 'calls'}`
