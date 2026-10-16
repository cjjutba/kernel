export type DayGroup = 'today' | 'yesterday' | 'week' | 'older'

export const DAY_GROUPS: { id: DayGroup; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'Earlier this week' },
  { id: 'older', label: 'Older' }
]

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }

/** Which day group a time falls in, by the local calendar: today, yesterday, the 5 days before that, then older. */
export function dayGroup(ts: number, now = Date.now()): DayGroup {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days <= 6 ? 'week' : 'older'
}

/** `rows` in the order given, split into the day groups that have any. Each group keeps its rows' order. */
export function groupByDay<T>(rows: T[], time: (row: T) => number, now = Date.now()): { id: DayGroup; label: string; rows: T[] }[] {
  return DAY_GROUPS.flatMap((g) => {
    const mine = rows.filter((r) => dayGroup(time(r), now) === g.id)
    return mine.length ? [{ ...g, rows: mine }] : []
  })
}

/** "feat(workspace): Add a thing" as { scope: "feat(workspace)", rest: "Add a thing" }. A title without a conventional prefix has no scope. */
export function splitScope(title: string): { scope?: string; rest: string } {
  const m = /^([a-z]+\([^)\s]+\)!?):\s+(.+)$/.exec(title)
  return m ? { scope: m[1], rest: m[2] } : { rest: title }
}
