import { describe, expect, it } from 'vitest'
import type { exec, ExecResult } from '../src/main/services/exec'
import type { GitHubError } from '../src/main/services/github'
import { listGithubIssues, parseIssue, parseIssues, readGithubIssue } from '../src/main/services/trackers/githubIssues'

/** A gh that answers every call with `answer`, and keeps each call's arguments and folder. */
function gh(answer: Partial<ExecResult> = {}) {
  const calls: { args: string[]; cwd?: string }[] = []
  const cmd = (async (_cmd: string, args: string[], o?: { cwd?: string }) => {
    calls.push({ args, cwd: o?.cwd })
    return { code: 0, stdout: '', stderr: '', ...answer }
  }) as typeof exec
  return { calls, cmd }
}

const raw = {
  number: 31, title: 'Export invoices as PDF', url: 'https://github.com/acme/app/issues/31',
  labels: [{ name: 'feature' }, { name: 'billing' }], assignees: [{ login: 'cjjutba' }],
  milestone: { title: 'Invoices v1' }, author: { login: 'maya-chen' }, updatedAt: '2026-10-10T09:00:00Z'
}

describe('GitHub issues for the Issues screen (KERNEL-471)', () => {
  it('reads a list row: the key, labels, assignees, milestone, author and whether it is yours', () => {
    const [mine, other, bare] = parseIssues(JSON.stringify([raw, { ...raw, number: 33, assignees: [{ login: 'maya-chen' }] }, { number: 40, title: 'Dark mode' }]), 'cjjutba')
    expect(mine).toEqual({
      number: 31, id: '#31', title: 'Export invoices as PDF', url: raw.url, labels: ['feature', 'billing'], assignees: ['cjjutba'],
      milestone: 'Invoices v1', author: 'maya-chen', updatedAt: raw.updatedAt, mine: true
    })
    expect(other.mine).toBe(false)
    expect(bare).toEqual({ number: 40, id: '#40', title: 'Dark mode', url: '', labels: [], assignees: [], updatedAt: '', mine: false })
  })

  it('counts nothing as yours when gh has no signed-in login', () => {
    expect(parseIssues(JSON.stringify([raw]), null)[0].mine).toBe(false)
  })

  it('reads an issue with its description and comments, oldest first, and keeps a comment without an author', () => {
    const issue = parseIssue(JSON.stringify({
      ...raw, body: 'Clients want a PDF.',
      comments: [
        { id: 'IC_2', author: { login: 'cjjutba' }, body: 'Use the on-screen design.', createdAt: '2026-10-11T09:00:00Z' },
        { id: 'IC_1', author: null, body: 'Billing asked twice.', createdAt: '2026-10-09T09:00:00Z' }
      ]
    }), 'cjjutba')
    expect(issue.body).toBe('Clients want a PDF.')
    expect(issue.comments).toEqual([
      { id: 'IC_1', body: 'Billing asked twice.', createdAt: '2026-10-09T09:00:00Z' },
      { id: 'IC_2', author: 'cjjutba', body: 'Use the on-screen design.', createdAt: '2026-10-11T09:00:00Z' }
    ])
    expect(parseIssue(JSON.stringify({ number: 1, title: 'x' }), null).body).toBe('')
  })

  it('says so when gh sends something that is not JSON', () => {
    expect(() => parseIssues('not json', null)).toThrow('Could not read the issues gh sent.')
  })

  it('lists up to 100 open issues in the room folder, and takes a number without its #', async () => {
    const g = gh({ stdout: JSON.stringify([raw]) })
    expect(await listGithubIssues('/repo', '#31', 'cjjutba', g.cmd)).toHaveLength(1)
    await listGithubIssues('/repo', undefined, null, g.cmd)
    const fields = 'number,title,url,labels,assignees,milestone,author,updatedAt'
    expect(g.calls).toEqual([
      { args: ['issue', 'list', '--state', 'open', '--limit', '100', '--json', fields, '--search', '31'], cwd: '/repo' },
      { args: ['issue', 'list', '--state', 'open', '--limit', '100', '--json', fields], cwd: '/repo' }
    ])
  })

  it('reads one issue by #41 or 41, and refuses a key that is not a number', async () => {
    const g = gh({ stdout: JSON.stringify(raw) })
    await readGithubIssue('/repo', '31', null, g.cmd)
    await readGithubIssue('/repo', '#31', null, g.cmd)
    expect(g.calls.map((c) => c.args.slice(0, 3))).toEqual([['issue', 'view', '31'], ['issue', 'view', '31']])
    await expect(readGithubIssue('/repo', 'KERNEL-31', null, g.cmd)).rejects.toThrow('KERNEL-31 is not a GitHub issue')
  })

  it('rejects with what gh said when it fails, and when it is not installed', async () => {
    await expect(listGithubIssues('/repo', undefined, null, gh({ code: 1, stderr: 'HTTP 404: Not Found\nmore' }).cmd)).rejects.toThrow('Could not read GitHub issues: HTTP 404: Not Found')
    await expect(listGithubIssues('/repo', undefined, null, gh({ code: 127 }).cmd)).rejects.toThrow('Install the GitHub CLI')
  })

  it("fails with the kind gh's failure was, for the list and for one issue (KERNEL-861)", async () => {
    const kindOf = (p: Promise<unknown>) => p.then(() => 'read', (e: GitHubError) => e.kind)
    const said = {
      'signed-out': { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n' },
      'not-found': { code: 1, stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/gone'. (repository)\n" },
      'rate-limited': { code: 1, stderr: 'GraphQL: API rate limit already exceeded for user ID 1234567.\n' },
      offline: { code: 1, stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n' },
      other: { code: 1, stderr: 'HTTP 502: Server Error (https://api.github.com/graphql)\n' }
    }
    for (const [kind, r] of Object.entries(said)) {
      expect(await kindOf(listGithubIssues('/repo', undefined, null, gh(r).cmd))).toBe(kind)
      expect(await kindOf(readGithubIssue('/repo', '#31', null, gh(r).cmd))).toBe(kind)
    }
  })
})
