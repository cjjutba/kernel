import { describe, expect, it } from 'vitest'
import type { Workspace } from '../src/shared/types'
import type { LeadPr } from '../src/renderer/src/screens/workspace/pr/leadPrList'
import { groupMerged, groupOpen, issueKey, matchesMerged, mergedReview, mergedRow, mergedWhen, parseTitle } from '../src/renderer/src/screens/prs/model'

const ws = (id: string, o: Partial<Workspace> = {}) => ({ id, projectId: 'r', agentId: 'christian', prState: 'open', prNumber: 1, ...o }) as Workspace
const row = (id: string, o: { ready?: boolean; group?: LeadPr['group']; ws?: Partial<Workspace> } = {}): LeadPr =>
  ({ ws: ws(id, o.ws), name: 'Christian', ready: o.ready ?? false, review: { text: 'Not reviewed', tone: 'faint' }, group: o.group ?? 'progress' }) as LeadPr

describe('groupOpen', () => {
  it('groups by project, with what can merge first, then what needs a person, then what is on its way, and leaves empty projects out', () => {
    const rows = [row('run', { ws: { prState: 'checks' } }), row('fail', { ws: { prState: 'cifail' }, group: 'attention' }), row('ok', { ready: true, group: 'ready' }), row('changes', { ws: { prState: 'changes' } }), row('other', { ws: { projectId: 's' } })]
    const projects = [{ id: 'r', name: 'Kernel' }, { id: 'q', name: 'Empty' }, { id: 's', name: 'fiscplus' }]
    const groups = groupOpen(rows, {}, projects)
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.ws.id)])).toEqual([['Kernel', ['ok', 'fail', 'changes', 'run']], ['fiscplus', ['other']]])
  })

  it('groups merged PRs by project, newest first as given', () => {
    const list = [ws('a', { projectId: 's' }), ws('b'), ws('c')]
    expect(groupMerged(list, [{ id: 'r', name: 'Kernel' }, { id: 's', name: 'fiscplus' }]).map((g) => [g.label, g.rows.map((w) => w.id)])).toEqual([['Kernel', ['b', 'c']], ['fiscplus', ['a']]])
  })

  it('says when a PR merged', () => {
    const now = new Date(2026, 9, 20, 18, 0).getTime()
    expect(mergedWhen(new Date(2026, 9, 20, 14, 21).getTime(), now)).toBe('Today, 14:21')
    expect(mergedWhen(new Date(2026, 9, 19, 23, 0).getTime(), now)).toBe('Yesterday')
    expect(mergedWhen(new Date(2026, 9, 16, 9, 0).getTime(), now)).toBe('Oct 16')
    expect(mergedWhen(new Date(2025, 8, 2, 9, 0).getTime(), now)).toBe('Sep 2, 2025')
  })

  it("reads a merged PR's review from the verdicts kept", () => {
    expect(mergedReview(ws('a'))).toMatchObject({ text: 'Merged without review', tone: 'faint' })
    expect(mergedReview(ws('b', { reviews: [{ verdict: 'approved' }] as Workspace['reviews'] }))).toMatchObject({ text: 'Approved', tone: 'good' })
    expect(mergedReview(ws('c', { reviews: [{ verdict: 'blockers' }] as Workspace['reviews'] }))).toMatchObject({ text: 'Merged with blockers', tone: 'bad' })
  })

  it('names the issue a workspace came from', () => {
    expect(issueKey(ws('a', { source: { kind: 'issue', id: 'KERNEL-859', title: 'T' } }))).toBe('KERNEL-859')
    expect(issueKey(ws('b'))).toBeUndefined()
  })
})

describe('parseTitle', () => {
  it('splits the convention into text, scope and key', () => {
    expect(parseTitle('feat(workspace): one model chip per role (KERNEL-995)')).toEqual({ text: 'one model chip per role', scope: 'feat(workspace)', key: 'KERNEL-995' })
  })

  it('shows a title outside the convention as written, with no scope', () => {
    expect(parseTitle('Landing page: new case study layout')).toEqual({ text: 'Landing page: new case study layout' })
    expect(parseTitle('docs: onboarding questions')).toEqual({ text: 'docs: onboarding questions' })
    expect(parseTitle('Release notes (KERNEL-200)')).toEqual({ text: 'Release notes (KERNEL-200)', key: 'KERNEL-200' })
  })

  it('takes the first of two keys and keeps the other in the text', () => {
    expect(parseTitle('fix(auth): expire invites (KERNEL-77) (KERNEL-78)')).toEqual({ text: 'expire invites (KERNEL-78)', scope: 'fix(auth)', key: 'KERNEL-77' })
  })

  it('fills the key from the branch when the title has none', () => {
    const w = ws('a', { prTitle: 'feat(team): editor', branch: 'feat/kernel-995-one-chip' })
    expect(mergedRow(w)).toMatchObject({ text: 'editor', scope: 'feat(team)', key: 'KERNEL-995' })
    expect(mergedRow(ws('b', { prTitle: 'Update dependencies', branch: 'chore/deps' })).key).toBeUndefined()
  })
})

describe('matchesMerged', () => {
  const w = ws('a', { prTitle: 'feat(team): editor (KERNEL-995)', branch: 'feat/kernel-995-chip', agentId: 'christian' })
  it('searches the title, the key and the branch, and narrows by agent', () => {
    expect(matchesMerged(w, 'EDITOR', undefined)).toBe(true)
    expect(matchesMerged(w, 'kernel-995', undefined)).toBe(true)
    expect(matchesMerged(w, 'feat/kernel-995-chip', undefined)).toBe(true)
    expect(matchesMerged(w, 'nothing', undefined)).toBe(false)
    expect(matchesMerged(w, '', 'sean')).toBe(false)
  })
})
