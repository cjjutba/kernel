import type { ReactNode } from 'react'

/** The muted `feat(workspace)` before a title. Pair it with `splitScope`. */
export function ScopeLabel({ children }: { children: ReactNode }) {
  return <span className="scope-label mono">{children}</span>
}

/** A day group's header in a list (Today, Yesterday, Earlier this week, Older). Pair it with `groupByDay`. */
export function DayGroupHeader({ label, count }: { label: string; count?: number }) {
  return <h3 className="day-group">{label}{count !== undefined && <span className="day-group-n">{count}</span>}</h3>
}
