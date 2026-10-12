import type { IssueSummary, JiraAccount, JiraFilter, JiraIssue, JiraStatusCategory, JiraTransition, Tracker, TrackerIssue } from '@shared/types'

// Jira Cloud as a room's tracker, through REST v3 (developer.atlassian.com/cloud/jira/platform/rest/v3). The account is the
// site, email and API token saved in Settings (KERNEL-474). Descriptions and comments come as Atlassian Document Format,
// which `adfToMarkdown` turns into the Markdown every tracker gives.

export interface JiraCredentials {
  /** The site's host: "acme.atlassian.net". */
  site: string
  email: string
  token: string
}

export const NO_JIRA = 'Connect Jira in Settings > Integrations to read its issues.'

/** A Jira call that failed, with the HTTP status when Jira answered. */
export class JiraError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

/** The host for what the user typed: "acme", "acme.atlassian.net" and a page's address on it all give "acme.atlassian.net". */
export function jiraSite(input: string): string | undefined {
  let host = input.trim().replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase()
  if (host && !host.includes('.')) host = `${host}.atlassian.net`
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/.test(host) ? host : undefined
}

/** "PROJ-7" for "proj-7", or for "7" in a room whose project is PROJ. Anything else isn't a Jira key. */
export function jiraKey(id: string, project?: string): string | undefined {
  const key = id.trim().toUpperCase()
  if (/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return key
  const p = project?.trim().toUpperCase()
  return p && /^[A-Z][A-Z0-9_]*$/.test(p) && /^\d+$/.test(key) ? `${p}-${key}` : undefined
}

/** The first thing Jira said was wrong: `errorMessages`, then the per-field `errors`. */
function said(body: unknown): string | undefined {
  const b = (body && typeof body === 'object' ? body : {}) as { errorMessages?: unknown; errors?: unknown }
  const messages = Array.isArray(b.errorMessages) ? b.errorMessages : []
  const fields = b.errors && typeof b.errors === 'object' ? Object.values(b.errors) : []
  return [...messages, ...fields].find((m): m is string => typeof m === 'string' && !!m.trim())
}

/** One call to Jira. Every call goes through here, so they all fail with the same words. A 204 resolves to undefined. */
export async function jiraRequest<T>(creds: JiraCredentials | undefined, path: string, o: { method?: 'GET' | 'POST'; body?: unknown } = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  if (!creds) throw new JiraError(NO_JIRA)
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64')
  const json = o.body !== undefined
  let res: Response
  try {
    res = await fetchImpl(`https://${creds.site}${path}`, {
      method: o.method ?? 'GET',
      headers: { accept: 'application/json', authorization: `Basic ${auth}`, ...(json ? { 'content-type': 'application/json' } : {}) },
      ...(json ? { body: JSON.stringify(o.body) } : {})
    })
  } catch { throw new JiraError(`Could not reach Jira at ${creds.site}. Check your connection.`) }
  if (res.status === 401) throw new JiraError('Jira rejected the email or API token. Reconnect Jira in Settings > Integrations.', 401)
  if (res.status === 429) {
    // Retry-After is in seconds. Jira may leave it out.
    const wait = Number(res.headers.get('retry-after'))
    throw new JiraError(`Jira is limiting requests. Try again ${wait > 0 ? `in ${Math.ceil(wait)} seconds` : 'in a minute'}.`, 429)
  }
  if (res.status === 204) return undefined as T
  const body = (await res.json().catch(() => null)) as unknown
  if (!res.ok) throw new JiraError(said(body) ?? `Jira answered ${res.status}.`, res.status)
  if (body === null) throw new JiraError(`${creds.site} didn't answer like Jira Cloud.`, res.status)
  return body as T
}

/** Who the account is. Connecting checks it before saving, and Settings checks it again with the saved account. */
export async function jiraMyself(creds: JiraCredentials, fetchImpl: typeof fetch = fetch): Promise<JiraAccount> {
  let me: { accountId?: string; displayName?: string }
  try {
    me = await jiraRequest(creds, '/rest/api/3/myself', {}, fetchImpl)
  } catch (e) {
    throw e instanceof JiraError && e.status === 404 ? new JiraError(`There is no Jira Cloud site at ${creds.site}.`, 404) : e
  }
  if (!me.accountId) throw new JiraError(`${creds.site} didn't answer like Jira Cloud.`)
  return { site: creds.site, email: creds.email, name: me.displayName || creds.email, accountId: me.accountId }
}

// ---- Atlassian Document Format ----

interface Adf { type?: string; text?: string; attrs?: Record<string, any>; marks?: { type: string; attrs?: Record<string, any> }[]; content?: Adf[] }

const kids = (n: Adf): Adf[] => (Array.isArray(n.content) ? n.content : [])

/**
 * Atlassian Document Format as Markdown, for a Jira description or comment. Formatting Markdown has no form for (underline,
 * colour) is dropped and its text kept. A node this doesn't know shows what it holds.
 */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === 'string') return doc.trim()
  if (!doc || typeof doc !== 'object') return ''
  const node = doc as Adf
  return (node.type === 'doc' ? blocks(kids(node)) : block(node)).trim()
}

function blocks(nodes: Adf[], gap = '\n\n'): string {
  return nodes.map(block).filter((b) => b.trim()).join(gap)
}

function block(n: Adf): string {
  switch (n.type) {
    case 'paragraph': return inline(kids(n))
    case 'heading': return `${'#'.repeat(Math.min(Math.max(Number(n.attrs?.level) || 1, 1), 6))} ${inline(kids(n))}`
    case 'bulletList': return kids(n).map((item) => hang('- ', blocks(kids(item), '\n'))).join('\n')
    case 'orderedList': {
      const first = Number(n.attrs?.order) || 1
      return kids(n).map((item, i) => hang(`${first + i}. `, blocks(kids(item), '\n'))).join('\n')
    }
    // A task holds its text directly. A nested list of tasks sits between them.
    case 'taskList': return kids(n).map((t) => t.type === 'taskItem' ? hang(`- [${t.attrs?.state === 'DONE' ? 'x' : ' '}] `, inline(kids(t))) : hang('  ', block(t))).join('\n')
    case 'decisionList': return kids(n).map((d) => hang('- ', inline(kids(d)))).join('\n')
    case 'codeBlock': {
      const code = kids(n).map((t) => t.text ?? '').join('')
      const fence = code.includes('```') ? '~~~' : '```'
      return `${fence}${n.attrs?.language ?? ''}\n${code}\n${fence}`
    }
    case 'blockquote':
    case 'panel': return blocks(kids(n)).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')
    case 'rule': return '---'
    case 'table': return table(n)
    case 'media':
    case 'mediaInline': return media(n)
    case 'expand':
    case 'nestedExpand': return [n.attrs?.title ? `**${n.attrs.title}**` : '', blocks(kids(n))].filter(Boolean).join('\n\n')
    case 'blockCard':
    case 'embedCard': return n.attrs?.url ? `<${n.attrs.url}>` : ''
    default: {
      const inside = kids(n)
      if (!inside.length) return n.text ?? ''
      return inside.some((k) => k.type === 'text') ? inline(inside) : blocks(inside)
    }
  }
}

/** `body` after `marker`, its later lines lined up under the first, as a list item's are. */
function hang(marker: string, body: string): string {
  const pad = ' '.repeat(marker.length)
  return body.split('\n').map((line, i) => (i === 0 ? `${marker}${line}` : line ? `${pad}${line}` : line)).join('\n').trimEnd()
}

/** A Markdown table, the first row as its header. A cell keeps its text on one line. */
function table(n: Adf): string {
  const rows = kids(n).map((row) => kids(row).map((cell) => blocks(kids(cell), ' ').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()))
  const width = Math.max(0, ...rows.map((r) => r.length))
  if (!width) return ''
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
  return [line(rows[0]), line(Array<string>(width).fill('---')), ...rows.slice(1).map(line)].join('\n')
}

/** An image from the web shows as one. A file uploaded to Jira can't be read from the brief, so it shows as a note. */
function media(n: Adf): string {
  if (n.attrs?.type === 'external' && n.attrs.url) return `![${n.attrs.alt ?? ''}](${n.attrs.url})`
  return `[attachment${n.attrs?.alt ? `: ${n.attrs.alt}` : ''}]`
}

function inline(nodes: Adf[]): string {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return marked(n.text ?? '', n.marks ?? [])
      case 'hardBreak': return '\n'
      case 'mention': return n.attrs?.text || '@someone'
      case 'emoji': return n.attrs?.text || n.attrs?.shortName || ''
      case 'inlineCard': return n.attrs?.url ? `<${n.attrs.url}>` : ''
      case 'date': {
        const at = Number(n.attrs?.timestamp)
        return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : ''
      }
      case 'status': return n.attrs?.text ? `[${n.attrs.text}]` : ''
      case 'placeholder': return ''
      case 'mediaInline': return media(n)
      default: return kids(n).length ? inline(kids(n)) : n.text ?? ''
    }
  }).join('')
}

/** A text node with its marks. Spaces at either end stay outside them, since `** bold**` isn't bold in Markdown. */
function marked(text: string, marks: NonNullable<Adf['marks']>): string {
  const core = text.trim()
  if (!core) return text
  const has = (type: string) => marks.some((m) => m.type === type)
  let out = core
  if (has('code')) out = core.includes('`') ? `\`\` ${core} \`\`` : `\`${core}\``
  if (has('strike')) out = `~~${out}~~`
  if (has('em')) out = `*${out}*`
  if (has('strong')) out = `**${out}**`
  const href = marks.find((m) => m.type === 'link')?.attrs?.href
  if (typeof href === 'string' && href) out = `[${out}](${href})`
  return `${text.slice(0, text.length - text.trimStart().length)}${out}${text.slice(text.trimEnd().length)}`
}

// ---- Issues ----

interface RawStatus { name?: string; statusCategory?: { key?: string } }

interface RawIssue {
  key: string
  fields?: {
    summary?: string
    status?: RawStatus
    assignee?: { displayName?: string; accountId?: string } | null
    issuetype?: { name?: string } | null
    priority?: { name?: string } | null
    labels?: string[]
    updated?: string
    description?: unknown
    comment?: { comments?: { author?: { displayName?: string } | null; body?: unknown; created: string }[] }
    issuelinks?: { type?: { name?: string; inward?: string }; inwardIssue?: { key: string; fields?: { status?: RawStatus } } }[]
  }
}

const category = (s?: RawStatus): JiraStatusCategory => {
  const key = s?.statusCategory?.key
  return key === 'indeterminate' || key === 'done' ? key : 'new'
}

const browse = (site: string, key: string) => `https://${site}/browse/${key}`

function toJiraIssue(site: string, r: RawIssue): JiraIssue {
  const f = r.fields ?? {}
  return {
    id: r.key, title: f.summary ?? '', url: browse(site, r.key),
    status: { name: f.status?.name ?? '', category: category(f.status) },
    ...(f.assignee?.accountId ? { assignee: { name: f.assignee.displayName ?? '', accountId: f.assignee.accountId } } : {}),
    ...(f.issuetype?.name ? { type: f.issuetype.name } : {}),
    ...(f.priority?.name ? { priority: f.priority.name } : {}),
    labels: f.labels ?? [],
    updatedAt: f.updated ?? ''
  }
}

/** A JQL string, quoted. */
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** The words of a search, without the characters Jira's text search reads as operators. */
const words = (q: string) => q.replace(/[+\-&|!(){}[\]^~*?\\:"'/]/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * The JQL for open issues, last updated first: not Done, from `project` when set, assigned to the account for `mine`, and
 * with a summary that starts with the query's words. `todo` keeps only the issues still in To Do.
 */
export function jiraJql(f: JiraFilter & { project?: string; todo?: boolean }): string {
  const text = words(f.query ?? '')
  const project = f.project?.trim()
  return [
    f.todo ? 'statusCategory = "To Do"' : 'statusCategory != Done',
    ...(project ? [`project = ${quote(project)}`] : []),
    ...(f.mine ? ['assignee = currentUser()'] : []),
    ...(text ? [`summary ~ ${quote(`${text}*`)}`] : [])
  ].join(' AND ') + ' ORDER BY updated DESC'
}

const LIST_FIELDS = ['summary', 'status', 'assignee', 'issuetype', 'priority', 'labels', 'updated']

/** One page of a JQL search, through the enhanced search that replaced `/search` in Jira Cloud. */
async function searchJql(creds: JiraCredentials | undefined, jql: string, maxResults: number, fields: string[], fetchImpl: typeof fetch): Promise<RawIssue[]> {
  const r = await jiraRequest<{ issues?: RawIssue[] }>(creds, '/rest/api/3/search/jql', { method: 'POST', body: { jql, maxResults, fields } }, fetchImpl)
  return r.issues ?? []
}

/** The issue `key` names, or undefined when Jira has none the account can see. JQL refuses a key that doesn't exist, so this asks for it directly. */
async function byKey(creds: JiraCredentials, key: string, fetchImpl: typeof fetch): Promise<RawIssue | undefined> {
  try {
    return await jiraRequest<RawIssue>(creds, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${LIST_FIELDS.join(',')}`, {}, fetchImpl)
  } catch (e) {
    if (e instanceof JiraError && e.status === 404) return undefined
    throw e
  }
}

/** Open issues by `jiraJql`, up to `max`. A query that is an issue's key ("PROJ-7", or "7" with a project) lists that issue first when it is open. */
export async function listJiraIssues(creds: JiraCredentials | undefined, f: JiraFilter & { project?: string }, max = 100, fetchImpl: typeof fetch = fetch): Promise<JiraIssue[]> {
  if (!creds) throw new JiraError(NO_JIRA)
  const key = f.query ? jiraKey(f.query, f.project) : undefined
  const [named, hits] = await Promise.all([key ? byKey(creds, key, fetchImpl) : undefined, searchJql(creds, jiraJql(f), max, LIST_FIELDS, fetchImpl)])
  const issues = hits.map((r) => toJiraIssue(creds.site, r))
  const exact = named ? toJiraIssue(creds.site, named) : undefined
  if (!exact || exact.status.category === 'done') return issues
  return [exact, ...issues.filter((i) => i.id !== exact.id)].slice(0, max)
}

const DETAIL_FIELDS = 'summary,description,labels,status,assignee,comment,issuelinks'

/**
 * One issue in full: its description and its last 50 comments, oldest first, as Markdown. `blockedBy` holds the open issues
 * linked to it as "is blocked by". On the blocked issue Jira gives each of them as the link's `inwardIssue`. `assignees`
 * holds its assignee, with `me` left out when Jira won't say who the account is.
 */
export async function getJiraIssue(creds: JiraCredentials | undefined, key: string, fetchImpl: typeof fetch = fetch): Promise<TrackerIssue> {
  if (!creds) throw new JiraError(NO_JIRA)
  const r = await jiraRequest<RawIssue>(creds, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${DETAIL_FIELDS}`, {}, fetchImpl)
  const f = r.fields ?? {}
  const comments = (f.comment?.comments ?? [])
    .map((c) => ({ ...(c.author?.displayName ? { author: c.author.displayName } : {}), body: adfToMarkdown(c.body), createdAt: c.created }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-50)
  const blocking = (l: NonNullable<NonNullable<RawIssue['fields']>['issuelinks']>[number]) => l.type?.name === 'Blocks' || /blocked by/i.test(l.type?.inward ?? '')
  const blockedBy = [...new Set((f.issuelinks ?? []).flatMap((l) => (blocking(l) &&l.inwardIssue && category(l.inwardIssue.fields?.status) !== 'done' ? [l.inwardIssue.key] : [])))]
  // Jira has one assignee. Whether it's the user takes the account's id, so Kernel asks only when there is one (KERNEL-479).
  const assignee = f.assignee?.accountId ? f.assignee : undefined
  const me = assignee ? await jiraRequest<{ accountId?: string }>(creds, '/rest/api/3/myself', {}, fetchImpl).then((m) => m.accountId, () => undefined) : undefined
  return {
    id: r.key, title: f.summary ?? '', url: browse(creds.site, r.key), description: adfToMarkdown(f.description), comments, labels: f.labels ?? [], blockedBy,
    ...(assignee ? { assignees: [{ name: assignee.displayName || assignee.accountId!, ...(me ? { me: me === assignee.accountId } : {}) }] } : {})
  }
}

// ---- Transitions ----

interface RawTransition { id: string; name?: string; to?: RawStatus }

const toTransition = (t: RawTransition): JiraTransition => ({ id: t.id, name: t.name ?? '', to: { name: t.to?.name ?? '', category: category(t.to) } })

/** The transitions Jira offers the issue from its status now. */
export async function jiraTransitions(creds: JiraCredentials | undefined, key: string, fetchImpl: typeof fetch = fetch): Promise<JiraTransition[]> {
  const r = await jiraRequest<{ transitions?: RawTransition[] }>(creds, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {}, fetchImpl)
  return (r.transitions ?? []).map(toTransition)
}

/** The key of the project's last updated To Do issue, whose transitions are the ones a room picks from. */
export async function latestToDo(creds: JiraCredentials | undefined, project: string | undefined, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  return (await searchJql(creds, jiraJql({ project, todo: true }), 1, ['summary'], fetchImpl))[0]?.key
}

/**
 * A workspace started on the issue: run the room's transition when the issue is still in To Do, and return the status it
 * moved to. An issue in progress or done stays where it is (D-140). Jira offers a transition only from some statuses, so
 * one the issue's status doesn't offer is an error the caller notes.
 */
export async function startJiraIssue(creds: JiraCredentials, key: string, transition: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const path = `/rest/api/3/issue/${encodeURIComponent(key)}`
  const issue = await jiraRequest<RawIssue & { transitions?: RawTransition[] }>(creds, `${path}?fields=status&expand=transitions`, {}, fetchImpl)
  const status = issue.fields?.status
  if (status?.statusCategory?.key !== 'new') return undefined
  const t = (issue.transitions ?? []).find((x) => x.id === transition)
  if (!t) throw new JiraError(`Jira doesn't offer the room's transition from ${status.name ?? 'its status'}. Pick another in the room's settings.`)
  await jiraRequest(creds, `${path}/transitions`, { method: 'POST', body: { transition: { id: transition } } }, fetchImpl)
  return t.to?.name || t.name
}

/**
 * Jira as a room's tracker (KERNEL-474). `creds` is read on every call, so an account saved in Settings applies at once.
 * The room's `[jira] project` narrows the issues, and `start` runs its `[jira] transition`. Without a transition or an
 * account, `start` moves nothing.
 */
export function jiraTracker(o: { creds: () => Promise<JiraCredentials | undefined>; project?: string; transition?: string; fetch?: typeof fetch }): Tracker {
  const fetchImpl = o.fetch ?? fetch
  return {
    kind: 'jira',
    search: async (query) => (await listJiraIssues(await o.creds(), { query, project: o.project }, 50, fetchImpl))
      .map((i): IssueSummary => ({ id: i.id, title: i.title, url: i.url, source: 'jira' })),
    issue: async (id) => {
      const key = jiraKey(id, o.project)
      if (!key) throw new JiraError(`${id} is not a Jira issue. Jira issues go by key, like PROJ-7.`)
      return getJiraIssue(await o.creds(), key, fetchImpl)
    },
    start: async (id) => {
      const key = jiraKey(id, o.project)
      if (!o.transition || !key) return undefined
      const creds = await o.creds()
      return creds ? startJiraIssue(creds, key, o.transition, fetchImpl) : undefined
    }
  }
}
