import { describe, expect, it } from 'vitest'
import type { Workspace } from '../src/shared/types'
import type { LeadPr } from '../src/renderer/src/screens/workspace/pr/leadPrList'
import { groupOpen, issueKey, matchesMerged, mergedRow, parseTitle } from '../src/renderer/src/screens/prs/model'

const ws = (id: string, o: Partial<Workspace> = {}) => ({ id, projectId: 'r', agentId: 'kai', prState: 'open', prNumber: 1, ...o }) as Workspace
const row = (id: string, o: { ready?: boolean; group?: LeadPr['group']; ws?: Partial<Workspace> } = {}): LeadPr =>
  ({ ws: ws(id, o.ws), name: 'Kai', ready: o.ready ?? false, review: { text: 'Not reviewed', tone: 'faint' }, group: o.group ?? 'progress' }) as LeadPr

describe('groupOpen', () => {
  it('lists what can merge, then what needs a person, then what is on its way, and leaves empty groups out', () => {
    const rows = [row('run', { ws: { prState: 'checks' } }), row('fail', { ws: { prState: 'cifail' }, group: 'attention' }), row('ok', { ready: true, group: 'ready' }), row('changes', { ws: { prState: 'changes' } })]
    const groups = groupOpen(rows, {})
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.ws.id)])).toEqual([['ready', ['ok']], ['needs', ['fail', 'changes']], ['progress', ['run']]])
    expect(groupOpen([rows[0]], {}).map((g) => g.id)).toEqual(['progress'])
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
  const w = ws('a', { prTitle: 'feat(team): editor (KERNEL-995)', branch: 'feat/kernel-995-chip', agentId: 'kai' })
  it('searches the title, the key and the branch, and narrows by agent', () => {
    expect(matchesMerged(w, 'EDITOR', undefined)).toBe(true)
    expect(matchesMerged(w, 'kernel-995', undefined)).toBe(true)
    expect(matchesMerged(w, 'feat/kernel-995-chip', undefined)).toBe(true)
    expect(matchesMerged(w, 'nothing', undefined)).toBe(false)
    expect(matchesMerged(w, '', 'noor')).toBe(false)
  })
})
