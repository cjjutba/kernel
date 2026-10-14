import { describe, expect, it } from 'vitest'
import type { AgentDef, PrInfo, Workspace } from '@shared/types'
import { leadPrs, reviewLine } from '../src/renderer/src/screens/workspace/pr/leadPrList'

// The Lead's PRs tab: which workspaces it lists, which come first, and what each row says (KERNEL-354).

const rules = { requireGreen: false, requireReviewer: true }
const agents = [{ id: 'kernel', name: 'Kernel', lead: true }, { id: 'kai', name: 'Kai' }, { id: 'theo', name: 'Theo' }] as AgentDef[]
const ws = (id: string, o: Partial<Workspace> = {}) => ({ id, roomId: 'room', agentId: 'kai', status: 'ready', prState: 'ready', prNumber: 1, prHead: 'h', ...o }) as Workspace
const verdict = (verdict: 'approved' | 'blockers', o: object = {}) => ({ workspaceId: 'rev', agentId: 'theo', verdict, summary: '', sha: 'h', prNumber: 1, ts: 1, ...o })
// A PR as GitHub reads it, typed in full so a field the merge rule needs can't go missing (KERNEL-394).
const info = (workspaceId: string, o: Partial<PrInfo> = {}): PrInfo => ({ workspaceId, number: 1, url: '', title: '', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [], head: 'h', ...o })
const list = (workspaces: Workspace[], prs: Record<string, PrInfo> = {}) => leadPrs(workspaces, { leadId: 'kernel', roomId: 'room', prs, rules, agents })
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
      ws('no-pr', { prNumber: undefined }), ws('lead', { lead: true, agentId: 'kernel' }), ws('kept')
    ])).toEqual(['kept'])
  })
})

describe('the order', () => {
  it('puts ready PRs first and keeps each group in the order given', () => {
    const rows = list([ws('checks', { prState: 'checks' }), ws('r1'), ws('draft', { prState: 'draft' }), ws('r2')])
    expect(rows.map((r) => [r.ws.id, r.ready])).toEqual([['r1', true], ['r2', true], ['checks', false], ['draft', false]])
  })

  it('holds back a PR the reviewer rule blocks, as a Merge button would', () => {
    const read = (id: string) => ({ [id]: info(id) })
    const [row] = list([ws('blocked', { reviews: [verdict('approved', { sha: 'old' })] })], read('blocked'))
    expect(row.ready).toBe(false)
    expect(row.state).toMatchObject({ label: 'Waiting for approval', tone: 'idle', spin: false, why: expect.stringContaining("The code review hasn't approved") })
    expect(list([ws('fine', { reviews: [verdict('approved')] })], read('fine'))[0].ready).toBe(true)
  })

  it('waits for the PR when green checks are required and GitHub has not been asked yet', () => {
    const strict = { requireGreen: true, requireReviewer: false }
    const [unread] = leadPrs([ws('a')], { leadId: 'kernel', roomId: 'room', prs: {}, rules: strict, agents })
    expect(unread.ready).toBe(false)
    const green = info('a', { checks: [{ name: 'lint', state: 'pass' }] })
    expect(leadPrs([ws('a')], { leadId: 'kernel', roomId: 'room', prs: { a: green }, rules: strict, agents })[0].ready).toBe(true)
  })
})

describe('what a not ready row says it waits on', () => {
  const label = (prState: Workspace['prState']) => list([ws('x', { prState })])[0].state
  it("uses every place's words and the PR band's tone, and spins for what runs (KERNEL-417)", () => {
    expect(label('checks')).toEqual({ label: 'Checks running', tone: 'idle', spin: true })
    expect(label('resolving')).toEqual({ label: 'Resolving', tone: 'fail', spin: true })
    expect(label('cifail')).toEqual({ label: 'Checks failed', tone: 'fail', spin: false })
    expect(label('changes')).toEqual({ label: 'Changes requested', tone: 'fail', spin: false })
    expect(label('conflict')).toEqual({ label: 'Merge conflicts', tone: 'fail', spin: false })
    expect(label('draft')).toEqual({ label: 'Draft', tone: 'idle', spin: false })
  })
})

describe('the review line', () => {
  it('says Not reviewed with no verdict', () => expect(reviewLine(ws('a'), undefined)).toEqual({ text: 'Not reviewed', tone: 'faint' }))
  it('names the kind of review that approved the head commit (KERNEL-549)', () => {
    // A verdict from before review kinds is the code review's.
    expect(reviewLine(ws('a', { reviews: [verdict('approved')] }), undefined)).toEqual({ text: 'Code approved', tone: 'good' })
    expect(reviewLine(ws('a', { reviews: [verdict('approved'), verdict('approved', { lens: 'security' })] }), undefined).text).toBe('Code and security approved')
  })
  it('counts the blockers on the head commit', () => {
    const blockers = [{ text: 'a' }, { text: 'b' }]
    expect(reviewLine(ws('a', { reviews: [verdict('blockers', { blockers, lens: 'security' })] }), undefined)).toEqual({ text: 'Security found 2 blockers', tone: 'bad' })
    expect(reviewLine(ws('a', { reviews: [verdict('blockers')] }), undefined).text).toBe('Code found 1 blocker')
    // Blockers from one kind win over another kind's approval.
    expect(reviewLine(ws('a', { reviews: [verdict('approved'), verdict('blockers', { lens: 'ux' })] }), undefined).text).toBe('UX found 1 blocker')
  })
  it('does not count a verdict on an earlier commit, nor on another PR', () => {
    expect(reviewLine(ws('a', { reviews: [verdict('approved', { sha: 'old' })] }), undefined).text).toBe('Reviewed an earlier commit')
    expect(reviewLine(ws('a', { reviews: [verdict('approved', { prNumber: 9 })] }), undefined).text).toBe('Not reviewed')
  })
  it('reads the head commit from GitHub when it is newer than the last poll', () => {
    const pr = { head: 'new' } as PrInfo
    expect(reviewLine(ws('a', { reviews: [verdict('approved', { sha: 'new' })] }), pr).text).toBe('Code approved')
  })
})

describe('what the tab and the Team update share (KERNEL-411)', () => {
  it('keeps a merging PR with the ready ones, so its row stays where Merge was pressed', () => {
    const rows = list([ws('checks', { prState: 'checks' }), ws('merging', { prState: 'merging' }), ws('r1')])
    expect(rows.map((r) => [r.ws.id, r.ready])).toEqual([['merging', true], ['r1', true], ['checks', false]])
  })

  it('shows a plain title: the workspace title, else the PR title without its commit prefix and issue key', async () => {
    const { prDisplayTitle } = await import('../src/renderer/src/screens/workspace/pr/model')
    expect(prDisplayTitle({ name: 'n', title: 'Home and Inbox count a workspace waiting for script trust', prTitle: 'feat(workspace): x (KERNEL-395)' })).toBe('Home and Inbox count a workspace waiting for script trust')
    expect(prDisplayTitle({ name: 'n', prTitle: 'fix(engine): a new workspace starts from the default branch (KERNEL-400)' })).toBe('A new workspace starts from the default branch')
    expect(prDisplayTitle({ name: 'n', prTitle: 'Add the Try section' })).toBe('Add the Try section')
    expect(prDisplayTitle({ name: 'kernel-182' })).toBe('kernel-182')
  })

  it('words a review the same way in both places', async () => {
    const { reviewPhrase } = await import('@shared/merge')
    // By kind of review, never by agent (KERNEL-549).
    expect(reviewPhrase({ reviewing: ['code'] })).toEqual({ text: 'Code review is running', tone: 'faint' })
    expect(reviewPhrase({ reviewing: ['code', 'ux'] })).toEqual({ text: 'Code and UX reviews are running', tone: 'faint' })
    expect(reviewPhrase({ blockers: { lenses: ['security'], count: 2 } })).toEqual({ text: 'Security found 2 blockers', tone: 'bad' })
    expect(reviewPhrase({ blockers: { lenses: ['code', 'security'] } })).toEqual({ text: 'Code and security found blockers', tone: 'bad' })
    expect(reviewPhrase({ approved: ['code', 'security', 'ux'] })).toEqual({ text: 'Code, security and UX approved', tone: 'good' })
    expect(reviewPhrase({ stale: true })).toEqual({ text: 'Reviewed an earlier commit', tone: 'faint' })
    expect(reviewPhrase({})).toEqual({ text: 'Not reviewed', tone: 'faint' })
    // Blockers win over a review still running.
    expect(reviewPhrase({ reviewing: ['ux'], blockers: { lenses: ['code'], count: 1 } }).text).toBe('Code found 1 blocker')
  })

  it("counts open PRs that can't merge yet in the band, never as no open PRs", async () => {
    const { summaryText } = await import('../src/renderer/src/screens/workspace/pr/LeadPrSummary')
    expect(summaryText(2, 3)).toBe('2 ready to merge')
    expect(summaryText(0, 2)).toBe('2 open, none ready')
    expect(summaryText(0, 0)).toBe('No open PRs')
  })

  it('says where Merge all stopped and why, and nothing when it merged everything', async () => {
    const { stoppedText } = await import('../src/renderer/src/screens/workspace/pr/LeadPrs')
    expect(stoppedText({ merged: [331, 330] })).toBeNull()
    expect(stoppedText({ merged: [331], stopped: { workspaceId: 'w', prNumber: 330, reason: 'It has merge conflicts.' } }))
      .toBe('Merged #331. Stopped at #330. It has merge conflicts.')
    expect(stoppedText({ merged: [], stopped: { workspaceId: 'w', reason: 'It is not an open workspace in this room.' } }))
      .toBe('Stopped at the next pull request. It is not an open workspace in this room.')
  })
})
