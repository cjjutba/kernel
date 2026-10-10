import type { AgentDef, LinearFilter, LinearIssue, LinearScope, LinearStateType, Workspace } from '@shared/types'
import type { IssueStateShape } from '../../icons'

/**
 * The groups, top to bottom. Triage comes first as Linear shows it: those issues wait on a decision (IssuesWorking.png). The list holds
 * open issues only (D-141), so there are no Done or Canceled groups.
 */
export const GROUP_ORDER: LinearStateType[] = ['triage', 'started', 'unstarted', 'backlog']
const rank = (t: LinearStateType) => { const i = GROUP_ORDER.indexOf(t); return i < 0 ? GROUP_ORDER.length : i }

/** The shape and word for a state. Linear calls the unstarted type "Todo" in most teams, and the canvas draws it that way. */
export const stateShape = (t: LinearStateType): IssueStateShape => (t === 'unstarted' ? 'todo' : t === 'completed' ? 'done' : t === 'canceled' ? 'canceled' : t)

export interface IssueGroup {
  /** The state's name as the team spells it, "In progress". */
  name: string
  type: LinearStateType
  issues: LinearIssue[]
}

/** Urgent first and no priority last, which is not the numeric order. */
const byPriority = (p: number) => (p === 0 ? 5 : p)

/**
 * One group per state name, in workflow order: state type, then the state's position in the team's workflow. Inside a group, priority
 * (urgent first, none last), then the most recently updated. States of different teams that share a name share a group.
 */
export function groupIssues(issues: LinearIssue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup & { position: number }>()
  for (const i of issues) {
    const key = `${i.state.type}\u0000${i.state.name}`
    const g = groups.get(key)
    if (g) { g.issues.push(i); g.position = Math.min(g.position, i.state.position) }
    else groups.set(key, { name: i.state.name, type: i.state.type, position: i.state.position, issues: [i] })
  }
  const time = (i: LinearIssue) => Date.parse(i.updatedAt) || 0
  return [...groups.values()]
    .sort((a, b) => rank(a.type) - rank(b.type) || a.position - b.position || a.name.localeCompare(b.name))
    .map(({ position: _p, ...g }) => ({ ...g, issues: g.issues.sort((a, b) => byPriority(a.priority) - byPriority(b.priority) || time(b) - time(a)) }))
}

/** The rows in the order the list shows them, for the arrow keys. */
export const flatIssues = (groups: IssueGroup[]): LinearIssue[] => groups.flatMap((g) => g.issues)

/** "3h", "2d", "1w" since an ISO time. Weeks past 14 days stay in weeks, like the canvas. */
export function issueAge(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s)) return ''
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (7 * 86400))}w`
}

/** "Maya Chen" becomes "MC", "CJ Jutba" becomes "CJ" and a single name takes its first two letters. */
export function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean)
  if (!w.length) return ''
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase()
}

/** Workspaces started from this issue. Archived ones are left out. One with a PR comes first, then the newest. */
export const linkedWorkspaces = (issueId: string, workspaces: Workspace[]): Workspace[] =>
  workspaces.filter((w) => w.status !== 'archived' && w.source?.kind === 'issue' && w.source.id === issueId)
    .sort((a, b) => Number(b.prState !== 'none') - Number(a.prState !== 'none') || b.createdAt - a.createdAt)

/** What a linked workspace is doing, from its PR and whether a chat is running. Real events only, never a timer. */
export function workspaceState(w: Workspace, running: boolean, long = false): string {
  const pr = (word: string) => (long && w.prNumber ? `PR #${w.prNumber} ${word}` : `PR ${word}`)
  if (w.status === 'setup') return 'Setting up'
  if (w.status === 'failed') return 'Setup failed'
  switch (w.prState) {
    case 'merged': return pr('merged')
    case 'closed': return pr('closed')
    case 'draft': return pr('draft')
    case 'creating': return 'Opening PR'
    case 'merging': return 'Merging'
    case 'ready': return pr('ready')
    case 'none': return running ? 'Working' : 'Idle'
    default: return pr('open')
  }
}

/** The row's right end for a linked workspace: "Kai · PR open". The one furthest along wins: an open PR before a workspace still working. */
export function rowStatus(linked: Workspace[], agents: Record<string, AgentDef[]>, runningOf: (w: Workspace) => boolean): string | null {
  const w = [...linked].sort((a, b) => Number(b.prState !== 'none') - Number(a.prState !== 'none') || b.createdAt - a.createdAt)[0]
  if (!w) return null
  const who = agents[w.roomId]?.find((a) => a.id === w.agentId)?.name
  const state = workspaceState(w, runningOf(w))
  return who ? `${who} · ${state}` : state
}

// ---------- filters

export const FILTER_KEY = 'kernel.issuesFilter'

/** What persists between launches. The search text does not: a leftover word would hide issues on the next launch with nothing saying why. */
export type SavedFilter = Pick<LinearFilter, 'mine' | 'teamId' | 'projectId' | 'cycleId'>

export const DEFAULT_FILTER: SavedFilter = { mine: true }

/** A saved filter read back, with anything malformed dropped. `raw` is the stored string. */
export function parseFilter(raw: string | null): SavedFilter {
  try {
    const v = JSON.parse(raw ?? 'null') as Record<string, unknown> | null
    if (!v || typeof v !== 'object') return { ...DEFAULT_FILTER }
    const id = (k: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : undefined)
    return { mine: v.mine !== false, teamId: id('teamId'), projectId: id('projectId'), cycleId: id('cycleId') }
  } catch { return { ...DEFAULT_FILTER } }
}

export const serializeFilter = (f: SavedFilter) => JSON.stringify({ mine: f.mine, teamId: f.teamId, projectId: f.projectId, cycleId: f.cycleId })

/**
 * The filter made valid for what Linear offers now. A team, project or cycle that is gone is dropped, and a project or cycle that
 * belongs to another team than the chosen one goes with it. With one team in the workspace, that team is always chosen.
 */
export function fitFilter(f: SavedFilter, scope: LinearScope): SavedFilter {
  const teamId = scope.teams.some((t) => t.id === f.teamId) ? f.teamId : scope.teams.length === 1 ? scope.teams[0].id : undefined
  const project = scope.projects.find((p) => p.id === f.projectId)
  const cycle = scope.cycles.find((c) => c.id === f.cycleId)
  return {
    mine: f.mine,
    teamId,
    projectId: project && (!teamId || project.teamIds.includes(teamId)) ? project.id : undefined,
    cycleId: cycle && (!teamId || cycle.teamId === teamId) ? cycle.id : undefined
  }
}

/** The projects and cycles offered for the chosen team, or for every team when none is chosen. */
export const projectsFor = (scope: LinearScope, teamId?: string) => scope.projects.filter((p) => !teamId || p.teamIds.includes(teamId))
export const cyclesFor = (scope: LinearScope, teamId?: string) => scope.cycles.filter((c) => !teamId || c.teamId === teamId)

/** "Current" for the active cycle, "Cycle 13" for an upcoming one. With every team shown, the team's key says whose it is. */
export function cycleLabel(c: LinearScope['cycles'][number], scope: LinearScope, teamId?: string): string {
  const key = !teamId && scope.teams.length > 1 ? scope.teams.find((t) => t.id === c.teamId)?.key : undefined
  return `${c.active ? 'Current' : c.name || `Cycle ${c.number}`}${key ? ` · ${key}` : ''}`
}

/** The empty state's sentence: "Nothing in KERNEL fits Mine, Billing and "webhook"." */
export function describeFilter(f: LinearFilter, scope: LinearScope): { where: string; fits: string[] } {
  const team = scope.teams.find((t) => t.id === f.teamId)
  const cycle = scope.cycles.find((c) => c.id === f.cycleId)
  const q = f.query?.trim()
  const fits = [
    f.mine ? 'Mine' : '',
    scope.projects.find((p) => p.id === f.projectId)?.name ?? '',
    cycle ? (cycle.active ? 'the current cycle' : cycle.name || `Cycle ${cycle.number}`) : '',
    q ? `"${q}"` : ''
  ].filter(Boolean)
  return { where: team?.key ?? 'Linear', fits }
}

/** "Mine, Billing and "webhook"". */
export const joinFits = (fits: string[]) => (fits.length < 2 ? fits.join('') : `${fits.slice(0, -1).join(', ')} and ${fits[fits.length - 1]}`)

/** The Linear workspace's name from an issue's URL, for the header ("Linear · cj-jutba"). */
export function workspaceSlug(url: string | undefined): string | undefined {
  try { return url ? new URL(url).pathname.split('/')[1] || undefined : undefined } catch { return undefined }
}
