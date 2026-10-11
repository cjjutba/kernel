import { describe, expect, it } from 'vitest'
import type { exec, ExecResult } from '../src/main/services/exec'
import { trackerKind } from '../src/main/services/trackers'
import { githubKey, githubTracker, parseIssueView } from '../src/main/services/trackers/github'
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

describe('the tracker a room uses (KERNEL-462)', () => {
  const none = { linearToken: false, linearTeam: false, githubRemote: false }

  it('takes the room\'s [tracker] kind over the token, the team and the remote', () => {
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

describe('GitHub Issues as a tracker (KERNEL-462)', () => {
  const view = {
    number: 41, title: 'Crash on save', url: 'https://github.com/acme/app/issues/41', body: 'Steps to reproduce',
    labels: [{ name: 'bug' }, { name: 'ui' }],
    comments: [
      { author: { login: 'sam' }, body: 'Still happens', createdAt: '2026-10-11T09:00:00Z' },
      { author: null, body: 'Seen it too', createdAt: '2026-10-10T09:00:00Z' }
    ]
  }

  it('searches open issues in the room folder, and takes a number without its #', async () => {
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
    expect(g.calls).toEqual([{ args: ['issue', 'view', '41', '--json', 'number,title,url,body,labels,comments'], cwd: '/repo' }])
    expect(parseIssueView(JSON.stringify({ number: 7, title: 'Empty', body: null }))).toEqual({ id: '#7', title: 'Empty', description: '', comments: [], labels: [] })
  })

  it('takes a number with or without #, and refuses any other key without asking gh', async () => {
    expect([githubKey('#41'), githubKey(' 41 '), githubKey('KERNEL-41'), githubKey('#4a')]).toEqual(['#41', '#41', undefined, undefined])
    const g = gh(() => ({ stdout: JSON.stringify(view) }))
    await expect(githubTracker('/repo', g.cmd).issue('KERNEL-41')).rejects.toThrow('KERNEL-41 is not a GitHub issue. GitHub issues go by number, like #41.')
    expect(g.calls).toEqual([])
  })

  it('says when gh is missing, signed out or too slow', async () => {
    const fails = (r: Partial<ExecResult>) => githubTracker('/repo', gh(() => r).cmd)
    await expect(fails({ code: 127 }).search()).rejects.toThrow('Install the GitHub CLI (gh) to read GitHub issues.')
    await expect(fails({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.' }).issue('#41'))
      .rejects.toThrow('Could not read GitHub issues: To get started with GitHub CLI, please run:  gh auth login')
    await expect(fails({ code: 1, timedOut: true }).search()).rejects.toThrow('GitHub took too long to answer. Try again.')
    await expect(fails({ stdout: 'not json' }).issue('#41')).rejects.toThrow('Could not read the issue gh sent.')
  })

  it('moves nothing when a workspace starts on an issue', async () => {
    const g = gh()
    expect(await githubTracker('/repo', g.cmd).start('#41')).toBeUndefined()
    expect(g.calls).toEqual([])
  })
})

describe('no tracker (KERNEL-462)', () => {
  it('lists nothing, reads nothing and moves nothing', async () => {
    const t = noneTracker()
    expect(t.kind).toBe('none')
    expect(await t.search('crash')).toEqual([])
    await expect(t.issue('#41')).rejects.toThrow(NO_TRACKER)
    expect(await t.start('KERNEL-41')).toBeUndefined()
  })
})
