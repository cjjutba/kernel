import type { AgentDef, ChatPart, GithubIssue, GithubIssueDetail, LinearFilter, LinearIssue, LinearScope, LinearStateType, PrInfo, ProjectTracker, Workspace } from '@shared/types'
import type { IssueStateShape } from '../../icons'
import type { IssueTracker } from './parts'

/**
 * The groups, top to bottom. Triage comes first as Linear shows it: those issues wait on a decision (IssuesWorking.png). The list holds
 * open issues only (KERNEL-160), so there are no Done or Canceled groups.
 */
export const GROUP_ORDER: LinearStateType[] = ['triage', 'started', 'unstarted', 'backlog']
const rank = (t: LinearStateType) => { const i = GROUP_ORDER.indexOf(t); return i < 0 ? GROUP_ORDER.length : i }

/**
 * The shape for a state type. Linear calls the unstarted type "Todo" in most teams, and the canvas draws it that way. Any type this
 * doesn't know, such as Linear's `duplicate` (an issue opened by key can be one), is drawn as canceled. The status word is the state's own name.
 */
export function stateShape(type: string): IssueStateShape {
  switch (type) {
    case 'triage': case 'backlog': case 'started': return type
    case 'unstarted': return 'todo'
    case 'completed': return 'done'
    default: return 'canceled'
  }
}

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

/** What an age like "4d" measures, for the tooltip on a row. */
export const ageTip = (iso: string) => `Updated ${issueAge(iso)} ago`

/** "3h", "2d", "1w" since an ISO time. Weeks past 14 days stay in weeks, like the canvas. */
export function issueAge(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s)) return ''
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (7 * 86400))}w`
}

/** "Maya Chen" becomes "MC", "Sam Rivera" becomes "SR" and a single name takes its first two letters. */
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

/** The state's words and the tone they are drawn in: `bad` is red for what needs a person, `ready` is the green of a PR that can merge. */
export interface WorkState { word: string; tone: 'plain' | 'bad' | 'ready' }

/** The workspace furthest along: an open PR before a workspace still working, then the newest. */
const furthest = (linked: Workspace[]): Workspace | undefined =>
  [...linked].sort((a, b) => Number(b.prState !== 'none') - Number(a.prState !== 'none') || b.createdAt - a.createdAt)[0]

/**
 * `workspaceState` with the PR's own reads laid over it: how many checks fail, changes requested and conflicts read red, and a PR that can
 * merge reads green. `pr` is GitHub's read of the PR, when there is one. Real events only, never a timer.
 */
export function workState(w: Workspace, running: boolean, pr?: PrInfo | null, long = false): WorkState {
  switch (w.prState) {
    case 'ready': return { word: 'Ready to merge', tone: 'ready' }
    case 'cifail': {
      const n = pr?.checks.filter((c) => c.state === 'fail' && !c.optional).length ?? 0
      return { word: n > 1 ? `${n} checks failing` : n === 1 ? '1 check failing' : 'Checks failing', tone: 'bad' }
    }
    case 'changes': return { word: 'Changes requested', tone: 'bad' }
    case 'conflict': return { word: 'Merge conflicts', tone: 'bad' }
    case 'checks': return { word: 'Checks running', tone: 'plain' }
    default: return { word: workspaceState(w, running, long), tone: w.status === 'failed' ? 'bad' : 'plain' }
  }
}

/** The row's right end for a linked workspace: the agent and what its work is doing. The one furthest along wins. */
export function rowState(linked: Workspace[], agents: Record<string, AgentDef[]>, runningOf: (w: Workspace) => boolean, prs: Record<string, PrInfo> = {}): (WorkState & { who?: string }) | null {
  const w = furthest(linked)
  if (!w) return null
  const who = agents[w.projectId]?.find((a) => a.id === w.agentId)?.name
  return { ...workState(w, runningOf(w), prs[w.id]), who }
}

/** `rowState` as one line, "Kai · PR open", for a screen reader and for tests. */
export function rowStatus(linked: Workspace[], agents: Record<string, AgentDef[]>, runningOf: (w: Workspace) => boolean, prs: Record<string, PrInfo> = {}): string | null {
  const s = rowState(linked, agents, runningOf, prs)
  return s ? (s.who ? `${s.who} · ${s.word}` : s.word) : null
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

/** Clear filters: every narrowing off. Mine becomes All, and search, team, project and cycle are dropped. With one team in the workspace that team stays, as it narrows nothing. */
export const clearedFilter = (scope: LinearScope): SavedFilter => fitFilter({ mine: false }, scope)

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

// ---------- GitHub Issues (KERNEL-471)

/**
 * What narrows a GitHub list. It is kept per project, since a project's labels and milestones are its own and a leftover one would hide
 * issues in the next project with nothing saying why. A repo that never assigns issues has nothing under Mine, so the list opens on All.
 */
export interface GithubFilter { mine: boolean; label?: string; milestone?: string }

export const DEFAULT_GITHUB_FILTER: GithubFilter = { mine: false }

/** Where a project's GitHub filter is kept. */
export const githubFilterKey = (projectId: string) => `kernel.githubFilter:${projectId}`

/** A stored GitHub filter, field by field: anything that isn't one reads as the default. */
export function parseGithubFilter(v: unknown): GithubFilter {
  if (!v || typeof v !== 'object') return { ...DEFAULT_GITHUB_FILTER }
  const { mine, label, milestone } = v as Record<string, unknown>
  return { mine: mine === true, ...(typeof label === 'string' && label ? { label } : {}), ...(typeof milestone === 'string' && milestone ? { milestone } : {}) }
}

/** "maya-chen" becomes "MC" and "samrivera" "SA": a login splits at its dashes, dots and underscores the way a name splits at spaces. */
export const loginInitials = (login: string) => initials(login.replace(/[-_.]+/g, ' '))

/** Most recently updated first. A GitHub list has one group, Open, so this is its whole order. */
export const byUpdated = (issues: GithubIssue[]): GithubIssue[] => {
  const time = (i: GithubIssue) => Date.parse(i.updatedAt) || 0
  return [...issues].sort((a, b) => time(b) - time(a) || b.number - a.number)
}

/** The issues the label and the milestone leave, before Mine or All splits them. The counts on the pills come from this. */
export const narrowGithub = (issues: GithubIssue[], f: GithubFilter): GithubIssue[] =>
  issues.filter((i) => (!f.label || i.labels.includes(f.label)) && (!f.milestone || i.milestone === f.milestone))

/** The label and milestone names the list offers, in order, with the chosen one kept even when the search left it out. */
export const labelsOf = (issues: GithubIssue[], keep?: string): string[] =>
  [...new Set([...issues.flatMap((i) => i.labels), ...(keep ? [keep] : [])])].sort((a, b) => a.localeCompare(b))
export const milestonesOf = (issues: GithubIssue[], keep?: string): string[] =>
  [...new Set([...issues.flatMap((i) => (i.milestone ? [i.milestone] : [])), ...(keep ? [keep] : [])])].sort((a, b) => a.localeCompare(b))

/** The row's label pills: two, and "+1" for the rest. */
export const rowLabels = (labels: string[]): { shown: string[]; more: string } =>
  ({ shown: labels.slice(0, 2), more: labels.length > 2 ? `+${labels.length - 2}` : '' })

/** The empty state's sentence for a GitHub list: "Nothing in acme/app fits Mine, bug and "webhook"." */
export function describeGithub(f: GithubFilter, query: string, where: string): { where: string; fits: string[] } {
  const q = query.trim()
  return { where, fits: [f.mine ? 'Mine' : '', f.label ?? '', f.milestone ?? '', q ? `"${q}"` : ''].filter(Boolean) }
}

/** Plan with Kernel's first message for a GitHub issue, the same as Linear's: the issue chip, its description and how to hand it off. */
export function githubPlanParts(issue: GithubIssueDetail): ChatPart[] {
  const description = issue.body.trim() || 'The issue has no description.'
  return [
    { type: 'issue', name: issue.id, title: issue.title, url: issue.url, source: 'github' },
    { type: 'text', text: `${description}\n\nWhen you hand it off, pass ${issue.id} as issue to create_workspace.` }
  ]
}

const isAvailable = (a: ProjectTracker['available'], t: IssueTracker) => (t === 'linear' ? a.linear : !!a.github)

/**
 * The tracker the page lists (KERNEL-938). An open issue names its own: `#41` is GitHub's, any other key is Linear's, so a link never lands
 * in the wrong list. Without one, the route's `tracker`, then the project's saved choice. Whatever is unavailable falls back to the project's
 * own (`kind`) for this load. A saved choice that fell back stays saved, so it applies again once it is available.
 */
export function activeTracker(t: ProjectTracker, pick: { issueId?: string; route?: IssueTracker; saved: IssueTracker | '' }): IssueTracker {
  const own: IssueTracker = t.kind === 'github' ? 'github' : 'linear'
  const named: IssueTracker | undefined = pick.issueId ? (pick.issueId.startsWith('#') ? 'github' : 'linear') : pick.route
  for (const c of pick.issueId ? [named] : [named, pick.saved]) if (c && isAvailable(t.available, c)) return c
  return own
}
