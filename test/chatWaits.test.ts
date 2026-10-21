import { describe, expect, it } from 'vitest'
import { chatWaits } from '../src/renderer/src/components/sidebar/chatWaits'
import type { Approval, Chat, Workspace } from '../src/shared/types'

const tab = (id: string, title: string): Chat => ({ id, workspaceId: 'lead', title, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1 })
const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, projectId: 'r1', name: id, branch: id, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'christian', port: 0, status: 'ready', prState: 'none', createdAt: 1, ...over }) as Workspace
const ask = (id: string, over: Partial<Approval>): Approval => ({ id, kind: 'question', source: 'sdk', title: '', status: 'pending', createdAt: 100, ...over })
const tabs = [tab('c1', 'Client portal login'), tab('c2', 'Fix the login redirect')]
const owned = [ws('invoice-table', { title: 'Invoice table', agentId: 'sean' })]

describe('chat waits (KERNEL-339)', () => {
  it('does not count another chat\'s workspaces, and a folded row counts the ones it started', () => {
    const approvals = [ask('a', { kind: 'tool', toolName: 'Bash', workspaceId: 'invoice-table' })]
    expect(chatWaits({ tabs, owned: [], approvals })).toEqual([])
    expect(chatWaits({ tabs, owned, approvals })).toHaveLength(1)
  })
})
