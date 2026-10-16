import type { IssueSummary, Tracker, TrackerIssue } from '@shared/types'
import { exec, type ExecResult } from '../exec'
import { ghErrorKind, GitHubError, ghUser, parseIssueList } from '../github'

// GitHub Issues as a project's tracker, through the GitHub CLI, which already holds the user's auth (D-006, KERNEL-462).

/** `#41` for "#41" or "41". A GitHub issue goes by its number, so any other key isn't one. */
export function githubKey(key: string): string | undefined {
  const n = /^#?(\d+)$/.exec(key.trim())?.[1]
  return n ? `#${n}` : undefined
}

/**
 * What gh said when it failed, in a sentence the From popover can show, with the kind of failure it was (KERNEL-861). `doing`
 * is what Kernel asked gh for, "file the GitHub issue" for a write.
 */
export function ghFailed(r: ExecResult, doing = 'read GitHub issues'): GitHubError {
  const kind = ghErrorKind(r)
  if (r.code === 127) return new GitHubError(`Install the GitHub CLI (gh) to ${doing}.`, kind)
  if (r.timedOut) return new GitHubError('GitHub took too long to answer. Try again.', kind)
  const said = r.stderr.trim().split('\n')[0] || r.stdout.trim().split('\n')[0]
  return new GitHubError(said ? `Could not ${doing}: ${said}` : `Could not ${doing}.`, kind)
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

/** Why `gh issue view` or a write failed: signed out and no such issue in plain words, anything else as ghFailed says it. */
function viewFailed(r: ExecResult, key: string | undefined, doing?: string): Error {
  const said = `${r.stderr}\n${r.stdout}`
  if (!r.timedOut && /gh auth login/.test(said)) return new GitHubError(GH_SIGNED_OUT, 'signed-out')
  if (key && !r.timedOut && /could not resolve to an issue/i.test(said)) return new GitHubError(`GitHub has no issue ${key} in this repo.`, 'not-found')
  return ghFailed(r, doing)
}

/** The issue whose URL `gh issue create` or `gh issue edit` printed, on its last line. */
function writtenIssue(stdout: string, title: string): IssueSummary {
  const url = stdout.trim().split('\n').reverse().map((l) => l.trim()).find((l) => /\/issues\/\d+$/.test(l))
  const n = url && /\/issues\/(\d+)$/.exec(url)?.[1]
  if (!n) throw new Error('Could not read the issue gh filed.')
  return { id: `#${n}`, title, url, source: 'github' }
}

/**
 * The GitHub issues of the repo at `cwd`, as gh resolves it there. GitHub records no blockers Kernel reads, and an issue has
 * no started state, so `start` moves nothing (KERNEL-462). `create` and `edit` write through gh as well, for file_issue.
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
    start: async () => undefined,
    create: async ({ title, description }) => {
      const r = await cmd('gh', ['issue', 'create', '--title', title, '--body', description ?? ''], { cwd, timeoutMs: 30000 })
      if (r.code !== 0 || r.timedOut) throw viewFailed(r, undefined, 'file the GitHub issue')
      return writtenIssue(r.stdout, title)
    },
    edit: async (id, change) => {
      const key = githubKey(id)
      if (!key) throw new Error(`${id} is not a GitHub issue. GitHub issues go by number, like #41.`)
      const state = change.state?.trim().toLowerCase()
      if (state !== undefined && state !== 'open' && state !== 'closed') throw new Error(`A GitHub issue is open or closed, not "${change.state}".`)
      const args = [...(change.title !== undefined ? ['--title', change.title] : []), ...(change.description !== undefined ? ['--body', change.description] : [])]
      if (!args.length && !state) throw new Error('Nothing to change: pass a title, a description or a state.')
      let out: IssueSummary = { id: key, title: change.title ?? '', source: 'github' }
      if (args.length) {
        const r = await cmd('gh', ['issue', 'edit', key.slice(1), ...args], { cwd, timeoutMs: 30000 })
        if (r.code !== 0 || r.timedOut) throw viewFailed(r, key, 'edit the GitHub issue')
        // gh prints only the URL, so an edit that leaves the title gives none.
        out = writtenIssue(r.stdout, change.title ?? '')
      }
      if (state) {
        const r = await cmd('gh', ['issue', state === 'closed' ? 'close' : 'reopen', key.slice(1)], { cwd, timeoutMs: 30000 })
        if (r.code !== 0 || r.timedOut) throw viewFailed(r, key, 'edit the GitHub issue')
      }
      return out
    },
    comment: async (id, body) => {
      const key = githubKey(id)
      if (!key) throw new Error(`${id} is not a GitHub issue. GitHub issues go by number, like #41.`)
      const r = await cmd('gh', ['issue', 'comment', key.slice(1), '--body', body], { cwd, timeoutMs: 30000 })
      if (r.code !== 0 || r.timedOut) throw viewFailed(r, key, 'comment on the GitHub issue')
      // gh prints the comment's link, ending in #issuecomment-<id>.
      const url = r.stdout.trim().split('\n').reverse().map((l) => l.trim()).find((l) => /^https?:\/\//.test(l))
      return url ? { url } : {}
    }
  }
}
