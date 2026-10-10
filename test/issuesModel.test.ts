import { describe, expect, it } from 'vitest'
import type { LinearIssue, LinearScope, Workspace } from '../src/shared/types'
import { describeFilter, stateShape, fitFilter, flatIssues, groupIssues, initials, issueAge, joinFits, linkedWorkspaces, parseFilter, rowStatus, workspaceSlug, workspaceState } from '../src/renderer/src/screens/issues/model'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const H = 3_600_000, D = 24 * H

const issue = (id: string, type: LinearIssue['state']['type'], name: string, position: number, priority: number, updatedAt: string): LinearIssue => ({
  id, uuid: id, title: id, url: `https://linear.app/cj-jutba/issue/${id}`, branchName: id.toLowerCase(), state: { id: name, name, type, position }, priority,
  labels: [], team: { id: 't1', key: 'KERNEL', name: 'Kernel' }, updatedAt
})

describe('groupIssues', () => {
  it('orders groups by state type, then by the state position', () => {
    const groups = groupIssues([
      issue('K-1', 'backlog', 'Backlog', 0, 0, ago(D)),
      issue('K-2', 'unstarted', 'Todo', 1, 0, ago(D)),
      issue('K-3', 'started', 'In review', 3, 0, ago(D)),
      issue('K-4', 'started', 'In progress', 2, 0, ago(D)),
      issue('K-5', 'triage', 'Triage', 0, 0, ago(D)),
      issue('K-6', 'unstarted', 'Ready', 0, 0, ago(D))
    ])
    expect(groups.map((g) => g.name)).toEqual(['Triage', 'In progress', 'In review', 'Ready', 'Todo', 'Backlog'])
  })

  it('puts urgent first and no priority last inside a group, then the most recently updated', () => {
    const [g] = groupIssues([
      issue('none-new', 'unstarted', 'Todo', 1, 0, ago(H)),
      issue('low', 'unstarted', 'Todo', 1, 4, ago(H)),
      issue('high-old', 'unstarted', 'Todo', 1, 2, ago(5 * D)),
      issue('urgent', 'unstarted', 'Todo', 1, 1, ago(9 * D)),
      issue('high-new', 'unstarted', 'Todo', 1, 2, ago(D)),
      issue('medium', 'unstarted', 'Todo', 1, 3, ago(D))
    ])
    expect(g.issues.map((i) => i.id)).toEqual(['urgent', 'high-new', 'high-old', 'medium', 'low', 'none-new'])
  })

  it('merges states of the same name and type, and leaves done and canceled issues in no special place', () => {
    const groups = groupIssues([issue('a', 'unstarted', 'Todo', 1, 0, ago(D)), issue('b', 'unstarted', 'Todo', 1, 0, ago(D)), issue('c', 'completed', 'Done', 9, 0, ago(D))])
    expect(groups.map((g) => [g.name, g.issues.length])).toEqual([['Todo', 2], ['Done', 1]])
  })

  it('flattens in list order, and an empty list has no groups', () => {
    expect(groupIssues([])).toEqual([])
    const flat = flatIssues(groupIssues([issue('b', 'backlog', 'Backlog', 0, 0, ago(D)), issue('s', 'started', 'In progress', 1, 0, ago(D))]))
    expect(flat.map((i) => i.id)).toEqual(['s', 'b'])
  })

  it('does not change the list it was given', () => {
    const list = [issue('b', 'backlog', 'Backlog', 0, 0, ago(D)), issue('s', 'started', 'In progress', 1, 0, ago(D))]
    groupIssues(list)
    expect(list.map((i) => i.id)).toEqual(['b', 's'])
  })
})

describe('stateShape', () => {
  it('draws Linear\'s state types, and anything unknown as canceled', () => {
    expect(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'].map(stateShape)).toEqual(['triage', 'backlog', 'todo', 'started', 'done', 'canceled'])
    expect(stateShape('duplicate')).toBe('canceled')
  })
})

describe('issueAge and initials', () => {
  it('reads hours, days and weeks', () => {
    expect(issueAge(ago(3 * H), NOW)).toBe('3h')
    expect(issueAge(ago(2 * D), NOW)).toBe('2d')
    expect(issueAge(ago(6 * D), NOW)).toBe('6d')
    expect(issueAge(ago(7 * D), NOW)).toBe('1w')
    expect(issueAge(ago(15 * D), NOW)).toBe('2w')
    expect(issueAge(ago(10_000), NOW)).toBe('1m')
  })
  it('takes the first and last initial', () => {
    expect(initials('Maya Chen')).toBe('MC')
    expect(initials('CJ Jutba')).toBe('CJ')
    expect(initials('Cher')).toBe('CH')
    expect(initials('  ')).toBe('')
  })
})

const ws = (id: string, extra: Partial<Workspace> = {}): Workspace => ({
  id, roomId: 'r', name: id, branch: id, baseRef: 'origin/main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'none', createdAt: 1,
  source: { kind: 'issue', id: 'K-1', title: 'T' }, ...extra
})

describe('linked workspaces', () => {
  it('finds workspaces started from the issue, a PR first and then the newest, and leaves archived ones out', () => {
    const list = [ws('old', { createdAt: 1 }), ws('pr', { createdAt: 0, prState: 'open' }), ws('new', { createdAt: 2 }), ws('gone', { status: 'archived' }), ws('other', { source: { kind: 'issue', id: 'K-2', title: 'T' } }), ws('from-pr', { source: { kind: 'pr', number: 1, title: 'T' } }), ws('none', { source: undefined })]
    expect(linkedWorkspaces('K-1', list).map((w) => w.id)).toEqual(['pr', 'new', 'old'])
  })

  it('says what a workspace is doing from its PR and running state', () => {
    expect(workspaceState(ws('a', { prState: 'open', prNumber: 41 }), false)).toBe('PR open')
    expect(workspaceState(ws('a', { prState: 'open', prNumber: 41 }), false, true)).toBe('PR #41 open')
    expect(workspaceState(ws('a'), true)).toBe('Working')
    expect(workspaceState(ws('a'), false)).toBe('Idle')
    expect(workspaceState(ws('a', { prState: 'merged' }), false)).toBe('PR merged')
    expect(workspaceState(ws('a', { status: 'setup' }), false)).toBe('Setting up')
  })

  it('shows the workspace furthest along on the row', () => {
    const agents = { r: [{ id: 'kai', name: 'Kai' }, { id: 'ivy', name: 'Ivy' }] } as never
    const list = [ws('tests', { agentId: 'ivy', createdAt: 9 }), ws('table', { prState: 'open', createdAt: 1 })]
    expect(rowStatus(list, agents, (w) => w.id === 'tests')).toBe('Kai · PR open')
    expect(rowStatus([], agents, () => false)).toBeNull()
  })
})

const scope: LinearScope = {
  teams: [{ id: 't1', key: 'KERNEL', name: 'Kernel' }, { id: 't2', key: 'WEB', name: 'Web' }],
  projects: [{ id: 'p1', name: 'Billing', teamIds: ['t1'] }, { id: 'p2', name: 'Site', teamIds: ['t2'] }],
  cycles: [{ id: 'c1', number: 12, teamId: 't1', active: true }, { id: 'c2', number: 4, teamId: 't2', active: true }]
}

describe('filters', () => {
  it('reads a saved filter and falls back to Mine when it is junk', () => {
    expect(parseFilter('{"mine":false,"teamId":"t1"}')).toEqual({ mine: false, teamId: 't1', projectId: undefined, cycleId: undefined })
    for (const raw of [null, '', 'nope', '[]', '7']) expect(parseFilter(raw).mine).toBe(true)
  })

  it('drops what Linear no longer offers and what belongs to another team', () => {
    expect(fitFilter({ mine: true, teamId: 'gone', projectId: 'p1', cycleId: 'c1' }, scope)).toEqual({ mine: true, teamId: undefined, projectId: 'p1', cycleId: 'c1' })
    expect(fitFilter({ mine: true, teamId: 't2', projectId: 'p1', cycleId: 'c1' }, scope)).toEqual({ mine: true, teamId: 't2', projectId: undefined, cycleId: undefined })
  })

  it('chooses the only team', () => {
    expect(fitFilter({ mine: true }, { ...scope, teams: [scope.teams[0]] }).teamId).toBe('t1')
    expect(fitFilter({ mine: true }, scope).teamId).toBeUndefined()
  })

  it('says what nothing matched', () => {
    const d = describeFilter({ mine: true, teamId: 't1', projectId: 'p1', query: ' webhook ' }, scope)
    expect(d.where).toBe('KERNEL')
    expect(joinFits(d.fits)).toBe('Mine, Billing and "webhook"')
    expect(joinFits(describeFilter({ mine: false, cycleId: 'c1' }, scope).fits)).toBe('the current cycle')
  })

  it('reads the workspace name from an issue link', () => {
    expect(workspaceSlug('https://linear.app/cj-jutba/issue/KERNEL-31/export')).toBe('cj-jutba')
    expect(workspaceSlug(undefined)).toBeUndefined()
    expect(workspaceSlug('not a url')).toBeUndefined()
  })
})
