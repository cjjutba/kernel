import { describe, expect, it } from 'vitest'
import type { AgentDef, PrInfo, Workspace } from '@shared/types'
import { leadPrs, reviewLine, summaryOf } from '../src/renderer/src/screens/workspace/pr/leadPrList'

// The Lead's PRs tab: which workspaces it lists, which come first, and what each row says (KERNEL-354).

const rules = { requireGreen: false, requireReviewer: true }
const agents = [{ id: 'rowan', name: 'Rowan', lead: true }, { id: 'kai', name: 'Kai' }, { id: 'theo', name: 'Theo' }] as AgentDef[]
const ws = (id: string, o: Partial<Workspace> = {}) => ({ id, roomId: 'room', agentId: 'kai', status: 'ready', prState: 'ready', prNumber: 1, prHead: 'h', ...o }) as Workspace
const verdict = (verdict: 'approved' | 'blockers', o: object = {}) => ({ workspaceId: 'rev', agentId: 'theo', verdict, summary: '', sha: 'h', prNumber: 1, ts: 1, ...o })
const list = (workspaces: Workspace[], prs: Record<string, PrInfo> = {}) => leadPrs(workspaces, { leadId: 'rowan', roomId: 'room', prs, rules, agents })
const ids = (workspaces: Workspace[]) => list(workspaces).map((r) => r.ws.id)

describe("which workspaces the Lead's tab lists", () => {
  it('lists open PRs in every state but none, merged and closed', () => {
    const states = ['creating', 'draft', 'open', 'checks', 'cifail', 'changes', 'conflict', 'resolving', 'ready', 'merging'] as const
    expect(ids(states.map((s) => ws(s, { prState: s })))).toHaveLength(states.length)
    expect(ids([ws('a', { prState: 'none' }), ws('b', { prState: 'merged' }), ws('c', { prState: 'closed' })])).toEqual([])
  })

  it('leaves out reviews, archived workspaces, other rooms, workspaces with no PR number and the Lead', () => {
    expect(ids([
      ws('review', { reviewOf: 'a' }), ws('archived', { status: 'archived' }), ws('other', { roomId: 'elsewhere' }),
      ws('no-pr', { prNumber: undefined }), ws('lead', { lead: true, agentId: 'rowan' }), ws('kept')
    ])).toEqual(['kept'])
  })
})

describe('the order', () => {
  it('puts ready PRs first and keeps each group in the order given', () => {
    const rows = list([ws('checks', { prState: 'checks' }), ws('r1'), ws('draft', { prState: 'draft' }), ws('r2')])
    expect(rows.map((r) => [r.ws.id, r.ready])).toEqual([['r1', true], ['r2', true], ['checks', false], ['draft', false]])
  })

  it('holds back a PR the reviewer rule blocks, as a Merge button would', () => {
    const read = (id: string) => ({ [id]: { workspaceId: id, number: 1, state: 'ready', checks: [], head: 'h' } as unknown as PrInfo })
    const [row] = list([ws('blocked', { reviews: [verdict('approved', { sha: 'old' })] })], read('blocked'))
    expect(row.ready).toBe(false)
    expect(row.state?.label).toBe('Waiting for approval')
    expect(list([ws('fine', { reviews: [verdict('approved')] })], read('fine'))[0].ready).toBe(true)
  })

  it('waits for the PR when green checks are required and GitHub has not been asked yet', () => {
    const strict = { requireGreen: true, requireReviewer: false }
    const [unread] = leadPrs([ws('a')], { leadId: 'rowan', roomId: 'room', prs: {}, rules: strict, agents })
    expect(unread.ready).toBe(false)
    const info = { workspaceId: 'a', number: 1, state: 'ready', checks: [{ name: 'lint', state: 'pass' }], head: 'h' } as PrInfo
    expect(leadPrs([ws('a')], { leadId: 'rowan', roomId: 'room', prs: { a: info }, rules: strict, agents })[0].ready).toBe(true)
  })
})

describe('what a not ready row says it waits on', () => {
  const label = (prState: Workspace['prState']) => list([ws('x', { prState })])[0].state
  it('uses the sidebar icon words, and Draft for a draft', () => {
    expect(label('checks')).toMatchObject({ label: 'Checks running', tone: 'muted' })
    expect(label('cifail')).toMatchObject({ label: 'Checks failed', tone: 'del' })
    expect(label('changes')).toMatchObject({ label: 'Changes requested', tone: 'del' })
    expect(label('conflict')).toMatchObject({ label: 'Merge conflicts', tone: 'del' })
    expect(label('draft')).toMatchObject({ label: 'Draft', tone: 'muted' })
  })
})

describe('the review line', () => {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id
  it('says Not reviewed with no verdict', () => expect(reviewLine(ws('a'), undefined, name)).toEqual({ text: 'Not reviewed', tone: 'faint' }))
  it('names who approved the head commit', () => expect(reviewLine(ws('a', { reviews: [verdict('approved')] }), undefined, name)).toEqual({ text: 'Theo approved', tone: 'good' }))
  it('counts the blockers on the head commit', () => {
    const blockers = [{ text: 'a' }, { text: 'b' }]
    expect(reviewLine(ws('a', { reviews: [verdict('blockers', { blockers })] }), undefined, name)).toEqual({ text: 'Theo found 2 blockers', tone: 'bad' })
    expect(reviewLine(ws('a', { reviews: [verdict('blockers')] }), undefined, name).text).toBe('Theo found 1 blocker')
  })
  it('does not count a verdict on an earlier commit, nor on another PR', () => {
    expect(reviewLine(ws('a', { reviews: [verdict('approved', { sha: 'old' })] }), undefined, name).text).toBe('Theo reviewed an earlier commit')
    expect(reviewLine(ws('a', { reviews: [verdict('approved', { prNumber: 9 })] }), undefined, name).text).toBe('Not reviewed')
  })
  it('reads the head commit from GitHub when it is newer than the last poll', () => {
    const pr = { head: 'new' } as PrInfo
    expect(reviewLine(ws('a', { reviews: [verdict('approved', { sha: 'new' })] }), pr, name).text).toBe('Theo approved')
  })
})

describe("the Lead's header", () => {
  const rows = (...ready: boolean[]) => ready.map((r) => ({ ready: r }))
  it('counts the ready PRs', () => expect(summaryOf(rows(true, false, true))).toEqual({ ready: 2, text: '2 ready to merge' }))
  it('says 0 ready to merge while PRs are open and none is ready', () => expect(summaryOf(rows(false, false, false))).toEqual({ ready: 0, text: '0 ready to merge' }))
  it('says No open PRs only when the room has none', () => expect(summaryOf([])).toEqual({ ready: 0, text: 'No open PRs' }))
})
