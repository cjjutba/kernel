import type { Tracker, TrackerIssue } from '@shared/types'
import { exec, type ExecResult } from '../exec'
import { ghUser, parseIssueList } from '../github'

// GitHub Issues as a room's tracker, through the GitHub CLI, which already holds the user's auth (D-006, KERNEL-462).

/** `#41` for "#41" or "41". A GitHub issue goes by its number, so any other key isn't one. */
export function githubKey(key: string): string | undefined {
  const n = /^#?(\d+)$/.exec(key.trim())?.[1]
  return n ? `#${n}` : undefined
}

/** What gh said when it failed, in a sentence the From popover can show. */
export function ghFailed(r: ExecResult): Error {
  if (r.code === 127) return new Error('Install the GitHub CLI (gh) to read GitHub issues.')
  if (r.timedOut) return new Error('GitHub took too long to answer. Try again.')
  const said = r.stderr.trim().split('\n')[0] || r.stdout.trim().split('\n')[0]
  return new Error(said ? `Could not read GitHub issues: ${said}` : 'Could not read GitHub issues.')
}

interface IssueView {
  number: number
  title: string
  url?: string
  body?: string | null
  labels?: { name: string }[]
  comments?: { author?: { login?: string } | null; body: string; createdAt: string }[]
  assignees?: { login: string }[]
}

/**
 * `gh issue view --json number,title,url,body,labels,comments,assignees` as every tracker gives an issue. Comments oldest
 * first. Assignees go by login, and whether one is the user is left out: gh doesn't say.
 */
export function parseIssueView(json: string): TrackerIssue {
  let v: IssueView
  try { v = JSON.parse(json) as IssueView } catch { throw new Error('Could not read the issue gh sent.') }
  return {
    id: `#${v.number}`, title: v.title, ...(v.url ? { url: v.url } : {}),
    description: v.body ?? '',
    comments: (v.comments ?? [])
      .map((c) => ({ ...(c.author?.login ? { author: c.author.login } : {}), body: c.body, createdAt: c.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    labels: (v.labels ?? []).map((l) => l.name),
    ...(v.assignees?.length ? { assignees: v.assignees.map((a) => ({ name: a.login })) } : {})
  }
}

/** Reading an issue with gh signed out, which an agent's get_issue passes on (KERNEL-473). */
export const GH_SIGNED_OUT = "The GitHub CLI isn't signed in. The user can run gh auth login in a terminal."

/** Why `gh issue view` failed: signed out and no such issue in plain words, anything else as ghFailed says it. */
function viewFailed(r: ExecResult, key: string): Error {
  const said = `${r.stderr}\n${r.stdout}`
  if (!r.timedOut && /gh auth login/.test(said)) return new Error(GH_SIGNED_OUT)
  if (!r.timedOut && /could not resolve to an issue/i.test(said)) return new Error(`GitHub has no issue ${key} in this repo.`)
  return ghFailed(r)
}

/**
 * The GitHub issues of the repo at `cwd`, as gh resolves it there. GitHub records no blockers Kernel reads, and an issue has
 * no started state, so `start` moves nothing (KERNEL-462).
 */
export function githubTracker(cwd: string, cmd: typeof exec = exec): Tracker {
  return {
    kind: 'github',
    search: async (query) => {
      const q = query?.trim().replace(/^#/, '')
      const r = await cmd('gh', ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url', ...(q ? ['--search', q] : [])], { cwd, timeoutMs: 20000 })
      if (r.code !== 0 || r.timedOut) throw ghFailed(r)
      return parseIssueList(r.stdout)
    },
    issue: async (id) => {
      const key = githubKey(id)
      if (!key) throw new Error(`${id} is not a GitHub issue. GitHub issues go by number, like #41.`)
      const r = await cmd('gh', ['issue', 'view', key.slice(1), '--json', 'number,title,url,body,labels,comments,assignees'], { cwd, timeoutMs: 20000 })
      if (r.code !== 0 || r.timedOut) throw viewFailed(r, key)
      const issue = parseIssueView(r.stdout)
      // Who the user is matters only when someone is assigned (KERNEL-479), so an issue with nobody costs no second call. With
      // gh signed out or offline, nobody's `me` is known.
      if (!issue.assignees?.length) return issue
      const login = (await ghUser(cmd).catch(() => null))?.toLowerCase()
      return login ? { ...issue, assignees: issue.assignees.map((a) => ({ ...a, me: a.name.toLowerCase() === login })) } : issue
    },
    start: async () => undefined
  }
}
