import { describe, expect, it } from 'vitest'
import type { exec, ExecResult } from '../src/main/services/exec'
import type { TrackerKind } from '../src/shared/types'
import { issueTracker, trackerKind, trackerName } from '../src/main/services/trackers'
import { GH_SIGNED_OUT, githubKey, githubTracker, parseIssueView } from '../src/main/services/trackers/github'
import { LINEAR_SIGNED_OUT, linearTracker, NO_LINEAR_TEAM } from '../src/main/services/trackers/linear'
import { NO_TRACKER, noneTracker } from '../src/main/services/trackers/none'

/** A gh that answers every call with `answer`, and keeps each call's arguments and folder. */
function gh(answer: (args: string[]) => Partial<ExecResult> = () => ({})) {
  const calls: { args: string[]; cwd?: string }[] = []
  const cmd = (async (_cmd: string, args: string[], o?: { cwd?: string }) => {
    calls.push({ args, cwd: o?.cwd })
    return { code: 0, stdout: '', stderr: '', ...answer(args) }
  }) as typeof exec
  return { calls, cmd }
}

describe('the tracker a project uses (KERNEL-462)', () => {
  const none = { linearToken: false, linearTeam: false, githubRemote: false }

  it('takes the project\'s [tracker] kind over the token, the team and the remote', () => {
    const all = { linearToken: true, linearTeam: true, githubRemote: true }
    expect(trackerKind({ ...all, kind: 'none' })).toBe('none')
    expect(trackerKind({ ...all, kind: 'github' })).toBe('github')
    expect(trackerKind({ ...none, kind: 'linear' })).toBe('linear')
  })

  it('uses Linear with a token and a team, then GitHub Issues with a github.com remote, and otherwise none', () => {
    expect(trackerKind({ linearToken: true, linearTeam: true, githubRemote: true })).toBe('linear')
    expect(trackerKind({ ...none, linearToken: true, githubRemote: true })).toBe('github')
    expect(trackerKind({ ...none, linearTeam: true, githubRemote: true })).toBe('github')
    expect(trackerKind({ ...none, linearToken: true })).toBe('none')
    expect(trackerKind(none)).toBe('none')
  })
})

describe('the tracker an issue came from (KERNEL-470)', () => {
  // A source saved while Jira was a tracker keeps its tag in the database.
  const jira = { id: 'PROJ-7', tracker: 'jira' as string as TrackerKind }

  it('reads an issue saved on Jira, before Jira was removed, as from no tracker Kernel has', () => {
    expect(issueTracker(jira)).toBeUndefined()
    expect(trackerName(issueTracker(jira))).toBe('the issue tracker')
    expect(trackerName(jira.tracker)).toBe('the issue tracker')
  })

  it('reads the tag, else the key: # is GitHub, anything else Linear', () => {
    expect(issueTracker({ id: 'KERNEL-7', tracker: 'github' })).toBe('github')
    expect(issueTracker({ id: '#41' })).toBe('github')
    expect(issueTracker({ id: 'KERNEL-7' })).toBe('linear')
    expect(trackerName('linear')).toBe('Linear')
    expect(trackerName(undefined)).toBe('the issue tracker')
  })
})

describe('GitHub Issues as a tracker (KERNEL-462)', () => {
  const view = {
    number: 41, title: 'Crash on save', url: 'https://github.com/acme/app/issues/41', body: 'Steps to reproduce',
    labels: [{ name: 'bug' }, { name: 'ui' }],
    comments: [
      { author: { login: 'sam' }, body: 'Still happens', createdAt: '2026-10-11T09:00:00Z' },
      { author: null, body: 'Seen it too', createdAt: '2026-10-10T09:00:00Z' }
    ]
  }

  it('searches open issues in the project folder, and takes a number without its #', async () => {
    const g = gh(() => ({ stdout: JSON.stringify([{ number: 41, title: 'Crash on save', url: view.url }]) }))
    const t = githubTracker('/repo', g.cmd)
    expect(t.kind).toBe('github')
    expect(await t.search('#41')).toEqual([{ id: '#41', title: 'Crash on save', url: view.url, source: 'github' }])
    await t.search()
    expect(g.calls).toEqual([
      { args: ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url', '--search', '41'], cwd: '/repo' },
      { args: ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url'], cwd: '/repo' }
    ])
  })

  it('reads an issue with its description, labels and comments, oldest first', async () => {
    const g = gh(() => ({ stdout: JSON.stringify(view) }))
    expect(await githubTracker('/repo', g.cmd).issue('#41')).toEqual({
      id: '#41', title: 'Crash on save', url: view.url, description: 'Steps to reproduce', labels: ['bug', 'ui'],
      comments: [{ body: 'Seen it too', createdAt: '2026-10-10T09:00:00Z' }, { author: 'sam', body: 'Still happens', createdAt: '2026-10-11T09:00:00Z' }]
    })
    expect(g.calls).toEqual([{ args: ['issue', 'view', '41', '--json', 'number,title,url,body,labels,comments,assignees'], cwd: '/repo' }])
    expect(parseIssueView(JSON.stringify({ number: 7, title: 'Empty', body: null }))).toEqual({ id: '#7', title: 'Empty', description: '', comments: [], labels: [] })
  })

  it("reads the assignees by login and asks gh who the user is only when someone is assigned (KERNEL-479)", async () => {
    const auth = (login: string) => JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, login }] } })
    const g = gh((args) => ({ stdout: args[0] === 'auth' ? auth('Sam') : JSON.stringify({ ...view, assignees: [{ login: 'sam' }, { login: 'mchen' }] }) }))
    expect((await githubTracker('/repo', g.cmd).issue('#41')).assignees).toEqual([{ name: 'sam', me: true }, { name: 'mchen', me: false }])
    expect(g.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['issue view', 'auth status'])
    // Signed out, nobody is known to be the user.
    const out = gh((args) => (args[0] === 'auth' ? { code: 1, stdout: '', stderr: 'not logged in' } : { stdout: JSON.stringify({ ...view, assignees: [{ login: 'sam' }] }) }))
    expect((await githubTracker('/repo', out.cmd).issue('#41')).assignees).toEqual([{ name: 'sam' }])
  })

  it('takes a number with or without #, and refuses any other key without asking gh', async () => {
    expect([githubKey('#41'), githubKey(' 41 '), githubKey('KERNEL-41'), githubKey('#4a')]).toEqual(['#41', '#41', undefined, undefined])
    const g = gh(() => ({ stdout: JSON.stringify(view) }))
    await expect(githubTracker('/repo', g.cmd).issue('KERNEL-41')).rejects.toThrow('KERNEL-41 is not a GitHub issue. GitHub issues go by number, like #41.')
    expect(g.calls).toEqual([])
  })

  it('says when gh is missing, signed out or too slow', async () => {
    const fails = (r: Partial<ExecResult>) => githubTracker('/repo', gh(() => r).cmd)
    const signedOut = { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.' }
    await expect(fails({ code: 127 }).search()).rejects.toThrow('Install the GitHub CLI (gh) to read GitHub issues.')
    await expect(fails(signedOut).search()).rejects.toThrow('Could not read GitHub issues: To get started with GitHub CLI, please run:  gh auth login')
    await expect(fails({ code: 1, timedOut: true }).search()).rejects.toThrow('GitHub took too long to answer. Try again.')
    await expect(fails({ stdout: 'not json' }).issue('#41')).rejects.toThrow('Could not read the issue gh sent.')
  })

  it('reads an issue with plain words for signed out and no such issue, which get_issue passes on (KERNEL-473)', async () => {
    const fails = (r: Partial<ExecResult>) => githubTracker('/repo', gh(() => r).cmd)
    await expect(fails({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }).issue('#41')).rejects.toThrow(GH_SIGNED_OUT)
    await expect(fails({ code: 1, stderr: 'GraphQL: Could not resolve to an issue or pull request with the number of 999. (repository.issue)\n' }).issue('999'))
      .rejects.toThrow('GitHub has no issue #999 in this repo.')
    await expect(fails({ code: 127 }).issue('#41')).rejects.toThrow('Install the GitHub CLI (gh) to read GitHub issues.')
  })

  it('files and edits an issue with gh, reading the issue from the URL gh prints', async () => {
    const g = gh(() => ({ stdout: 'Creating issue in acme/app\n\nhttps://github.com/acme/app/issues/42\n' }))
    const t = githubTracker('/repo', g.cmd)
    expect(await t.create({ title: 'Crash on save', description: 'Steps' })).toEqual({ id: '#42', title: 'Crash on save', url: 'https://github.com/acme/app/issues/42', source: 'github' })
    expect(await t.edit('42', { title: 'Crash on save in Safari' })).toMatchObject({ id: '#42', title: 'Crash on save in Safari' })
    await t.edit('#42', { description: 'More steps' })
    expect(g.calls).toEqual([
      { args: ['issue', 'create', '--title', 'Crash on save', '--body', 'Steps'], cwd: '/repo' },
      { args: ['issue', 'edit', '42', '--title', 'Crash on save in Safari'], cwd: '/repo' },
      { args: ['issue', 'edit', '42', '--body', 'More steps'], cwd: '/repo' }
    ])
  })

  it('says why a write failed, as it does for reads', async () => {
    const fails = (r: Partial<ExecResult>) => githubTracker('/repo', gh(() => r).cmd)
    await expect(fails({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }).create({ title: 'x' })).rejects.toThrow(GH_SIGNED_OUT)
    await expect(fails({ code: 127 }).create({ title: 'x' })).rejects.toThrow('Install the GitHub CLI (gh) to file the GitHub issue.')
    await expect(fails({ code: 1, stderr: 'GraphQL: Could not resolve to an issue or pull request with the number of 999.' }).edit('999', { title: 'x' })).rejects.toThrow('GitHub has no issue #999 in this repo.')
    await expect(fails({ code: 1, stderr: 'HTTP 403: Resource not accessible' }).edit('#41', { title: 'x' })).rejects.toThrow('Could not edit the GitHub issue: HTTP 403: Resource not accessible')
    await expect(fails({ stdout: 'done' }).create({ title: 'x' })).rejects.toThrow('Could not read the issue gh filed.')
    const g = gh()
    await expect(githubTracker('/repo', g.cmd).edit('KERNEL-41', { title: 'x' })).rejects.toThrow('KERNEL-41 is not a GitHub issue.')
    await expect(githubTracker('/repo', g.cmd).edit('#41', {})).rejects.toThrow('Nothing to change: pass a title or a description.')
    expect(g.calls).toEqual([])
  })

  it('moves nothing when a workspace starts on an issue', async () => {
    const g = gh()
    expect(await githubTracker('/repo', g.cmd).start('#41')).toBeUndefined()
    expect(g.calls).toEqual([])
  })
})

describe('Linear as a tracker reading one issue (KERNEL-473)', () => {
  /** A Linear that answers every call with `status` and `body`. */
  const linear = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('says plainly when Kernel is not connected or Linear has no such issue, and passes other errors on', async () => {
    await expect(linearTracker(async () => undefined, linear(200, {})).issue('KERNEL-83')).rejects.toThrow(LINEAR_SIGNED_OUT)
    await expect(linearTracker(async () => 'k', linear(400, { errors: [{ message: 'Entity not found: Issue' }] })).issue('KERNEL-999'))
      .rejects.toThrow("Linear has no issue KERNEL-999, or this token can't see it.")
    await expect(linearTracker(async () => 'k', linear(401, {})).issue('KERNEL-83')).rejects.toThrow('Linear rejected the token. Reconnect it in Settings > Integrations.')
  })

  it("gives the assignee with whether it is the token's user, and none for an issue nobody has (KERNEL-479)", async () => {
    const node = (assignee: { name: string; isMe: boolean } | null) => ({ data: { issue: {
      id: 'u1', identifier: 'KERNEL-83', title: 'Issues screen', url: 'https://linear.app/x/KERNEL-83', branchName: 'b', priority: 0, updatedAt: '2026-10-11T00:00:00Z',
      state: { id: 's', name: 'Todo', type: 'unstarted', position: 1 }, assignee, labels: { nodes: [] }, team: { id: 't', key: 'KERNEL', name: 'Kernel' },
      project: null, cycle: null, description: '', comments: { nodes: [] }, inverseRelations: { nodes: [] }
    } } })
    expect((await linearTracker(async () => 'k', linear(200, node({ name: 'Maya Chen', isMe: false }))).issue('KERNEL-83')).assignees).toEqual([{ name: 'Maya Chen', me: false }])
    expect((await linearTracker(async () => 'k', linear(200, node(null))).issue('KERNEL-83')).assignees).toBeUndefined()
  })
})

describe('Linear as a tracker filing and editing an issue', () => {
  /** A Linear that answers each call in turn, and keeps the variables each one sent. */
  function linearCalls(...answers: unknown[]) {
    const sent: { query: string; variables: Record<string, unknown> }[] = []
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body))
      return new Response(JSON.stringify(answers.shift()), { status: 200 })
    }) as unknown as typeof fetch
    return { sent, fetchImpl }
  }
  const written = () => ({ success: true, issue: { identifier: 'KERNEL-90', title: 'Symlink node_modules', url: 'https://linear.app/x/KERNEL-90' } })

  it("files in the project's team, looked up by its key", async () => {
    const l = linearCalls({ data: { teams: { nodes: [{ id: 'team-uuid' }] } } }, { data: { issueCreate: written() } })
    expect(await linearTracker(async () => 'k', l.fetchImpl, 'KERNEL').create({ title: 'Symlink node_modules', description: 'Steps' }))
      .toEqual({ id: 'KERNEL-90', title: 'Symlink node_modules', url: 'https://linear.app/x/KERNEL-90', source: 'linear' })
    expect(l.sent.map((c) => c.variables)).toEqual([{ key: 'KERNEL' }, { input: { teamId: 'team-uuid', title: 'Symlink node_modules', description: 'Steps' } }])
    expect(l.sent[1].query).toContain('issueCreate')
  })

  it('edits only what it is given, by the issue key', async () => {
    const l = linearCalls({ data: { issueUpdate: written() } })
    expect((await linearTracker(async () => 'k', l.fetchImpl).edit('KERNEL-90', { description: 'More' })).id).toBe('KERNEL-90')
    expect(l.sent.map((c) => c.variables)).toEqual([{ id: 'KERNEL-90', input: { description: 'More' } }])
    expect(l.sent[0].query).toContain('issueUpdate')
  })

  it('says when it is not connected, has no team, or Linear refuses', async () => {
    await expect(linearTracker(async () => undefined, linearCalls().fetchImpl, 'KERNEL').create({ title: 'x' })).rejects.toThrow(LINEAR_SIGNED_OUT)
    await expect(linearTracker(async () => undefined, linearCalls().fetchImpl).edit('KERNEL-9', { title: 'x' })).rejects.toThrow(LINEAR_SIGNED_OUT)
    await expect(linearTracker(async () => 'k', linearCalls().fetchImpl).create({ title: 'x' })).rejects.toThrow(NO_LINEAR_TEAM)
    await expect(linearTracker(async () => 'k', linearCalls({ data: { teams: { nodes: [] } } }).fetchImpl, 'NOPE').create({ title: 'x' })).rejects.toThrow("Linear has no team NOPE, or this token can't see it.")
    await expect(linearTracker(async () => 'k', linearCalls({ errors: [{ message: 'Entity not found: Issue' }] }).fetchImpl).edit('KERNEL-999', { title: 'x' }))
      .rejects.toThrow("Linear has no issue KERNEL-999, or this token can't see it.")
    await expect(linearTracker(async () => 'k', linearCalls({ data: { issueUpdate: { success: false, issue: null } } }).fetchImpl).edit('KERNEL-9', { title: 'x' })).rejects.toThrow('Linear did not change the issue.')
  })
})

describe('no tracker (KERNEL-462)', () => {
  it('lists nothing, reads nothing and moves nothing', async () => {
    const t = noneTracker()
    expect(t.kind).toBe('none')
    expect(await t.search('crash')).toEqual([])
    await expect(t.issue('#41')).rejects.toThrow(NO_TRACKER)
    expect(await t.start('KERNEL-41')).toBeUndefined()
    await expect(t.create({ title: 'Crash' })).rejects.toThrow(NO_TRACKER)
    await expect(t.edit('#41', { title: 'Crash' })).rejects.toThrow(NO_TRACKER)
    expect(NO_TRACKER).toBe('This project has no issue tracker.')
  })
})
