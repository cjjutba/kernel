import { describe, expect, it } from 'vitest'
import type { Workspace } from '../src/shared/types'
import type { LeadPr } from '../src/renderer/src/screens/workspace/pr/leadPrList'
import { groupOpen, issueKey } from '../src/renderer/src/screens/prs/model'

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
