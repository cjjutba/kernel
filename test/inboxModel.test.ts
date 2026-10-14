import { describe, expect, it } from 'vitest'
import { inboxItems, inTab, needsYou } from '../src/renderer/src/screens/inbox/model'
import { roomState } from '../src/renderer/src/screens/rooms/roomInfo'
import type { Approval, Room, Workspace } from '../src/shared/types'

const room: Room = { id: 'a', name: 'Client A', path: '/p/a', defaultBranch: 'main', paused: false, createdAt: 0 }
const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId: 'a', name: id, branch: `feat/${id}`, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'none', createdAt: 1, ...over }) as Workspace
const ask = (id: string, over: Partial<Approval> = {}): Approval => ({ id, kind: 'tool', source: 'sdk', title: 'Run a command', status: 'pending', createdAt: 100, roomId: 'a', ...over })
const count = (workspaces: Workspace[], approvals: Approval[] = []) => inboxItems([], approvals, [room], [], workspaces).filter(needsYou).length

describe('a workspace held for script trust counts as needing you (KERNEL-395)', () => {
  it('is one row per held workspace, in the Needs you tab, and the others add nothing', () => {
    const items = inboxItems([], [], [room], [], [ws('a', { status: 'trust', title: 'Invoice table' }), ws('b', { status: 'trust' }), ws('c'), ws('d', { status: 'setup' })])
    expect(items.map((i) => i.n.id).sort()).toEqual(['n-trust-a', 'n-trust-b'])
    expect(items.every((i) => needsYou(i) && inTab(i, 'needs') && !inTab(i, 'updates'))).toBe(true)
    const row = items.find((i) => i.n.workspaceId === 'a')!.n
    expect(row).toMatchObject({ kind: 'trust', roomId: 'a', title: 'Trust scripts to start Invoice table', sub: 'Trust scripts · Client A' })
  })

  it('counts once when the workspace also has a pending approval, as the sidebar does', () => {
    const held = [ws('a', { status: 'trust' })]
    expect(count(held, [ask('p1', { workspaceId: 'a' })])).toBe(1)
    expect(count(held, [ask('p1', { workspaceId: 'a' }), ask('p2', { workspaceId: 'other' })])).toBe(2)
    // An answered approval no longer covers it.
    expect(count(held, [ask('p1', { workspaceId: 'a', status: 'allowed' })])).toBe(1)
  })

  it('drops out of every count once the status moves on', () => {
    expect(count([ws('a', { status: 'trust' })])).toBe(1)
    expect(count([ws('a', { status: 'setup' })])).toBe(0)
    expect(count([ws('a', { status: 'ready' })])).toBe(0)
  })

  it('makes the room card say Needs you, and only while a workspace is held', () => {
    expect(roomState(room, [], undefined, [ws('a', { status: 'trust' })])).toBe('you')
    expect(roomState(room, [], undefined, [ws('a', { status: 'ready' })])).toBe('idle')
    expect(roomState(room, [], { kernel: 'working' }, [ws('a', { status: 'trust', roomId: 'other' })])).toBe('working')
    expect(roomState({ ...room, archived: true }, [], undefined, [ws('a', { status: 'trust' })])).toBe('archived')
  })
})
