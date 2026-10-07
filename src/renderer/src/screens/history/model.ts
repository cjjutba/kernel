import type { Workspace } from '@shared/types'

export type HistoryTab = 'all' | 'merged' | 'notMerged'

/** When it left the sidebar: archived, else merged, else started. */
export const endedAt = (w: Workspace) => w.archivedAt ?? w.mergedAt ?? w.createdAt

export const archivedList = (workspaces: Workspace[]) => workspaces.filter((w) => w.status === 'archived' && w.name !== 'lead').sort((a, b) => endedAt(b) - endedAt(a))

export const inTab = (w: Workspace, tab: HistoryTab) => tab === 'all' || (tab === 'merged') === (w.prState === 'merged')

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }

export type HistoryGroup = 'Today' | 'This week' | 'Earlier'

export function groupOf(ts: number, now = Date.now()): HistoryGroup {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  return days <= 0 ? 'Today' : days < 7 ? 'This week' : 'Earlier'
}

/** 14:02 today, Mon this week, Sep 12 before that. */
export function whenLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const g = groupOf(ts, now)
  if (g === 'Today') return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (g === 'This week') return d.toLocaleDateString('en-US', { weekday: 'short' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** "#41 merged", "#7 closed", "No PR". An open PR on an archived workspace reads "#9 open". */
export const prLabel = (w: Workspace) => (w.prNumber ? `#${w.prNumber} ${w.prState === 'none' ? 'open' : w.prState}` : 'No PR')

/** Matches the name, branch, room or agent, every word, any case. */
export function matches(w: Workspace, query: string, room?: string, agent?: string): boolean {
  const hay = [w.name, w.title, w.branch, room, agent].filter(Boolean).join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word))
}
