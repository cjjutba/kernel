import type { ChatPart, IssueSummary, LinearComment, LinearFilter, LinearIssue, LinearIssueDetail, LinearScope, LinearStateType } from '@shared/types'

// Linear issues: the new workspace modal's search, the Issues screen, Plan with Rowan and the move to In Progress (D-140).
// The token comes from Settings > Integrations (KERNEL-26), else LINEAR_API_KEY in the environment.
// Field names follow Linear's GraphQL schema (github.com/linear/linear, packages/sdk/src/schema.graphql).

export const LINEAR_URL = 'https://api.linear.app/graphql'

export const NO_LINEAR_TOKEN = 'Connect Linear in Settings > Integrations to search issues.'

export function linearToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LINEAR_API_KEY?.trim() || undefined
}

/** One GraphQL call to Linear. Every query goes through here, so they all fail with the same words. */
export async function linearRequest<T>(token: string | undefined, query: string, variables: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  if (!token) throw new Error(NO_LINEAR_TOKEN)
  let res: Response
  try {
    res = await fetchImpl(LINEAR_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: token }, body: JSON.stringify({ query, variables }) })
  } catch { throw new Error('Could not reach Linear. Check your connection.') }
  if (res.status === 401 || res.status === 403) throw new Error('Linear rejected the token. Reconnect it in Settings > Integrations.')
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null
  if (!res.ok || body?.errors?.length || !body?.data) throw new Error(body?.errors?.[0]?.message ?? `Linear answered ${res.status}.`)
  return body.data
}

/** Open is a positive list, so duplicates and any state type Linear adds later stay out. KERNEL-172. */
const OPEN_TYPES: LinearStateType[] = ['triage', 'backlog', 'unstarted', 'started']
const OPEN = { state: { type: { in: OPEN_TYPES } } }

/** Matches the title, or the number when the query ends in one ("KERNEL-16" or "16"). */
function matchQuery(q: string) {
  const number = /(\d+)$/.exec(q)?.[1]
  return { or: [{ title: { containsIgnoreCase: q } }, ...(number ? [{ number: { eq: Number(number) } }] : [])] }
}

const SEARCH = `query Issues($filter: IssueFilter) {
  issues(first: 30, filter: $filter, orderBy: updatedAt) { nodes { identifier title url } }
}`

/** Open issues, newest first. `query` matches the title or the identifier ("KERNEL-16" or "16"). */
export async function searchIssues(token: string | undefined, query = '', fetchImpl: typeof fetch = fetch): Promise<IssueSummary[]> {
  const q = query.trim()
  const filter = q ? { and: [OPEN, matchQuery(q)] } : OPEN
  const data = await linearRequest<{ issues?: { nodes?: { identifier: string; title: string; url?: string }[] } }>(token, SEARCH, { filter }, fetchImpl)
  return (data.issues?.nodes ?? []).map((n) => ({ id: n.identifier, title: n.title, url: n.url, source: 'linear' as const }))
}

const ISSUE_FIELDS = `
  id identifier title url branchName priority updatedAt
  state { id name type position }
  assignee { name isMe }
  labels { nodes { name } }
  team { id key name }
  project { id name }
  cycle { id number name }`

interface IssueNode {
  id: string; identifier: string; title: string; url: string; branchName: string; priority: number; updatedAt: string
  state: { id: string; name: string; type: string; position: number }
  assignee: { name: string; isMe: boolean } | null
  labels: { nodes: { name: string }[] }
  team: { id: string; key: string; name: string }
  project: { id: string; name: string } | null
  cycle: { id: string; number: number; name: string | null } | null
}

function toIssue(n: IssueNode): LinearIssue {
  return {
    id: n.identifier, uuid: n.id, title: n.title, url: n.url, branchName: n.branchName,
    state: { id: n.state.id, name: n.state.name, type: n.state.type as LinearStateType, position: n.state.position },
    priority: n.priority,
    ...(n.assignee ? { assignee: { name: n.assignee.name, me: n.assignee.isMe } } : {}),
    labels: n.labels.nodes.map((l) => l.name),
    team: { id: n.team.id, key: n.team.key, name: n.team.name },
    ...(n.project ? { project: { id: n.project.id, name: n.project.name } } : {}),
    ...(n.cycle ? { cycle: { id: n.cycle.id, number: n.cycle.number, ...(n.cycle.name ? { name: n.cycle.name } : {}) } } : {}),
    updatedAt: n.updatedAt
  }
}

/** The IssueFilter for the Issues screen: open issues, narrowed by every field that is set. */
export function issueFilter(f: LinearFilter) {
  const q = f.query?.trim()
  return {
    and: [
      OPEN,
      ...(f.mine ? [{ assignee: { isMe: { eq: true } } }] : []),
      ...(f.teamId ? [{ team: { id: { eq: f.teamId } } }] : []),
      ...(f.projectId ? [{ project: { id: { eq: f.projectId } } }] : []),
      ...(f.cycleId ? [{ cycle: { id: { eq: f.cycleId } } }] : []),
      ...(q ? [matchQuery(q)] : [])
    ]
  }
}

const LIST = `query IssueList($filter: IssueFilter) {
  issues(first: 100, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }
}`

/** Open issues, last updated first, up to 100. */
export async function listIssues(token: string | undefined, filter: LinearFilter, fetchImpl: typeof fetch = fetch): Promise<LinearIssue[]> {
  const data = await linearRequest<{ issues: { nodes: IssueNode[] } }>(token, LIST, { filter: issueFilter(filter) }, fetchImpl)
  return data.issues.nodes.map(toIssue)
}

const DETAIL = `query IssueDetail($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS}
    description
    comments(first: 50) { nodes { id body createdAt user { name } } }
    inverseRelations { nodes { type issue { identifier } } }
  }
}`

/**
 * One issue by identifier ("KERNEL-83"), which Linear's `issue(id:)` takes as well as the uuid. Comments oldest first.
 * `blockedBy` holds the identifiers of the issues that block it: Linear saves "A blocks B" once, as a relation of A's,
 * so B reads it among its inverse relations (KERNEL-263).
 */
export async function getIssue(token: string | undefined, id: string, fetchImpl: typeof fetch = fetch): Promise<LinearIssueDetail & { blockedBy: string[] }> {
  type Node = IssueNode & {
    description: string | null
    comments: { nodes: { id: string; body: string; createdAt: string; user: { name: string } | null }[] }
    inverseRelations?: { nodes: { type: string; issue: { identifier: string } | null }[] }
  }
  const { issue } = await linearRequest<{ issue: Node }>(token, DETAIL, { id }, fetchImpl)
  const comments: LinearComment[] = issue.comments.nodes
    .map((c) => ({ id: c.id, body: c.body, ...(c.user ? { author: c.user.name } : {}), createdAt: c.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const blockedBy = [...new Set((issue.inverseRelations?.nodes ?? []).flatMap((r) => (r.type === 'blocks' && r.issue ? [r.issue.identifier] : [])))]
  return { ...toIssue(issue), description: issue.description ?? '', comments, blockedBy }
}

const SCOPE = `query Scope {
  teams(first: 100) { nodes { id key name } }
  projects(first: 100, filter: { status: { type: { nin: ["completed", "canceled"] } } }) { nodes { id name teams { nodes { id } } } }
  cycles(first: 100, filter: { or: [{ isActive: { eq: true } }, { isFuture: { eq: true } }] }) { nodes { id number name isActive team { id } } }
}`

/** Teams, open projects, and active and upcoming cycles. */
export async function getScope(token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<LinearScope> {
  const data = await linearRequest<{
    teams: { nodes: { id: string; key: string; name: string }[] }
    projects: { nodes: { id: string; name: string; teams: { nodes: { id: string }[] } }[] }
    cycles: { nodes: { id: string; number: number; name: string | null; isActive: boolean; team: { id: string } }[] }
  }>(token, SCOPE, {}, fetchImpl)
  return {
    teams: data.teams.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name })),
    projects: data.projects.nodes.map((p) => ({ id: p.id, name: p.name, teamIds: p.teams.nodes.map((t) => t.id) })),
    cycles: data.cycles.nodes.map((c) => ({ id: c.id, number: c.number, ...(c.name ? { name: c.name } : {}), teamId: c.team.id, active: c.isActive }))
  }
}

/** States an issue moves to In Progress from. An issue already started, done or canceled stays where it is. */
const NOT_STARTED: LinearStateType[] = ['triage', 'backlog', 'unstarted']

const STARTED = `query Started($id: String!) {
  issue(id: $id) { id state { type } team { states(filter: { type: { eq: "started" } }) { nodes { id name position } } } }
}`

const MOVE = `mutation Move($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`

/**
 * A workspace started on the issue: move it to its team's first started state (lowest position), when it hasn't started.
 * Returns the state's name when it moved.
 */
export async function moveToStarted(token: string | undefined, id: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const { issue } = await linearRequest<{ issue: { id: string; state: { type: string }; team: { states: { nodes: { id: string; name: string; position: number }[] } } } }>(token, STARTED, { id }, fetchImpl)
  if (!NOT_STARTED.includes(issue.state.type as LinearStateType)) return undefined
  const target = [...issue.team.states.nodes].sort((a, b) => a.position - b.position)[0]
  if (!target) return undefined
  const { issueUpdate } = await linearRequest<{ issueUpdate: { success: boolean } }>(token, MOVE, { id: issue.id, stateId: target.id }, fetchImpl)
  if (!issueUpdate.success) throw new Error('Linear did not move the issue.')
  return target.name
}

/** Plan with Rowan's first message: the issue chip, its description, and how to hand it off. */
export function planParts(issue: LinearIssueDetail): ChatPart[] {
  const description = issue.description.trim() || 'The issue has no description.'
  return [
    { type: 'issue', name: issue.id, title: issue.title, url: issue.url, source: 'linear' },
    { type: 'text', text: `${description}\n\nWhen you hand it off, pass ${issue.id} as issue to create_workspace.` }
  ]
}
