import type { GithubIssue, GithubIssueDetail } from '@shared/types'
import { exec } from '../exec'
import { ghFailed, githubKey } from './github'

// The fields the Issues screen shows for a project on GitHub Issues, through gh, which already holds the user's auth (KERNEL-471).

const LIST_FIELDS = 'number,title,url,labels,assignees,milestone,author,updatedAt'
const VIEW_FIELDS = `${LIST_FIELDS},body,comments`

interface Raw {
  number: number
  title: string
  url?: string
  labels?: { name: string }[]
  assignees?: { login?: string }[]
  milestone?: { title?: string } | null
  author?: { login?: string } | null
  updatedAt?: string
  body?: string | null
  comments?: { id?: string; author?: { login?: string } | null; body: string; createdAt: string }[]
}

/** One issue as gh prints it. `me` is the login gh is signed in as, which decides `mine`. */
function issueOf(v: Raw, me: string | null): GithubIssue {
  const assignees = (v.assignees ?? []).map((a) => a.login).filter((l): l is string => !!l)
  return {
    number: v.number, id: `#${v.number}`, title: v.title, url: v.url ?? '',
    labels: (v.labels ?? []).map((l) => l.name),
    assignees,
    ...(v.milestone?.title ? { milestone: v.milestone.title } : {}),
    ...(v.author?.login ? { author: v.author.login } : {}),
    updatedAt: v.updatedAt ?? '',
    mine: !!me && assignees.includes(me)
  }
}

function parse<T>(json: string): T {
  try { return JSON.parse(json) as T } catch { throw new Error('Could not read the issues gh sent.') }
}

/** `gh issue list --json ...` as the Issues screen lists it. */
export const parseIssues = (json: string, me: string | null): GithubIssue[] => parse<Raw[]>(json).map((v) => issueOf(v, me))

/** `gh issue view --json ...`, with the comments oldest first. */
export function parseIssue(json: string, me: string | null): GithubIssueDetail {
  const v = parse<Raw>(json)
  return {
    ...issueOf(v, me),
    body: v.body ?? '',
    comments: (v.comments ?? [])
      .map((c, i) => ({ id: c.id ?? String(i), ...(c.author?.login ? { author: c.author.login } : {}), body: c.body, createdAt: c.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}

/** The open issues of the repo at `cwd`, up to 100. A failed gh rejects with the first line it printed. */
export async function listGithubIssues(cwd: string, query: string | undefined, me: string | null, cmd: typeof exec = exec): Promise<GithubIssue[]> {
  const q = query?.trim().replace(/^#/, '')
  const r = await cmd('gh', ['issue', 'list', '--state', 'open', '--limit', '100', '--json', LIST_FIELDS, ...(q ? ['--search', q] : [])], { cwd, timeoutMs: 20000 })
  if (r.code !== 0 || r.timedOut) throw ghFailed(r)
  return parseIssues(r.stdout, me)
}

/** One issue of the repo at `cwd`, by `#41` or `41`. */
export async function readGithubIssue(cwd: string, id: string, me: string | null, cmd: typeof exec = exec): Promise<GithubIssueDetail> {
  const key = githubKey(id)
  if (!key) throw new Error(`${id} is not a GitHub issue. GitHub issues go by number, like #41.`)
  const r = await cmd('gh', ['issue', 'view', key.slice(1), '--json', VIEW_FIELDS], { cwd, timeoutMs: 20000 })
  if (r.code !== 0 || r.timedOut) throw ghFailed(r)
  return parseIssue(r.stdout, me)
}
