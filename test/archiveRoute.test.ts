import { beforeEach, describe, expect, it } from 'vitest'
import { getState, setState } from '../src/renderer/src/store'
import { archiveLanding } from '../src/renderer/src/screens/workspace/pr/model'
import type { AgentDef, Room, Thread, Workspace } from '../src/shared/types'

// KERNEL-547: where the open workspace goes in the step that archives it, read from the store with no wait on main.

const room = (id: string): Room => ({ id, name: id, path: `/r/${id}`, defaultBranch: 'main', paused: false, createdAt: 1 }) as Room
const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId: 'r1', name: id, branch: id, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 0, status: 'archived', prState: 'none', createdAt: 1, ...over }) as Workspace
const chat = (id: string, threadId: string, over: Partial<Workspace> = {}) => ws(id, { lead: true, threadId, agentId: 'rowan', status: 'ready', ...over })
const thread = (id: string, over: Partial<Thread> = {}): Thread => ({ id, roomId: 'r1', title: id, createdAt: 1, ...over }) as Thread
const lead = { id: 'rowan', lead: true } as AgentDef

const merged = ws('mine', { prState: 'merged', prNumber: 164 })
const onItsOwn = { seen: true, byHand: false }
const toast = { title: "Archived Kai's workspace after PR #164 merged", sub: 'Restore it from History.' }

beforeEach(() => {
  setState({
    rooms: [room('r1')],
    agents: { r1: [lead] },
    workspaces: [merged, chat('older', 't1'), chat('newer', 't2')],
    threads: { t1: thread('t1', { createdAt: 1 }), t2: thread('t2', { createdAt: 2 }) }
  })
})

describe('where the open workspace goes once it is archived (KERNEL-547)', () => {
  it('goes to History when the user archived it, with no toast', () => {
    expect(archiveLanding(merged, undefined, 'Kai', { seen: true, byHand: true }, getState())).toEqual({ route: { name: 'history' } })
  })

  it('goes to History for a workspace that was already archived when it opened, and for a PR that was only closed', () => {
    expect(archiveLanding(merged, undefined, 'Kai', { seen: false, byHand: false }, getState())).toEqual({ route: { name: 'history' } })
    expect(archiveLanding(ws('mine', { prState: 'closed', prNumber: 164 }), undefined, 'Kai', onItsOwn, getState())).toEqual({ route: { name: 'history' } })
  })

  it("opens the room's newest open chat with Rowan, with the toast, for a workspace Kernel archived on its own", () => {
    expect(archiveLanding(merged, undefined, 'Kai', onItsOwn, getState())).toEqual({ route: { name: 'workspace', workspaceId: 'newer' }, toast })
  })

  it('opens the chat the sidebar lists on top, and skips one whose folder is gone', () => {
    setState({ threads: { t1: thread('t1', { createdAt: 1, lastSentAt: 9 }), t2: thread('t2', { createdAt: 2 }) } })
    expect(archiveLanding(merged, undefined, 'Kai', onItsOwn, getState()).route).toEqual({ name: 'workspace', workspaceId: 'older' })
    setState((s) => ({ workspaces: s.workspaces.map((w) => (w.id === 'older' ? { ...w, folderGone: true } : w)) }))
    expect(archiveLanding(merged, undefined, 'Kai', onItsOwn, getState()).route).toEqual({ name: 'workspace', workspaceId: 'newer' })
  })

  it('never lands on the workspace it just archived, even when that is the Lead chat', () => {
    const own = chat('newer', 't2', { status: 'archived', prState: 'merged', prNumber: 164 })
    setState((s) => ({ workspaces: s.workspaces.map((w) => (w.id === 'newer' ? own : w)) }))
    expect(archiveLanding(own, undefined, 'Rowan', onItsOwn, getState()).route).toEqual({ name: 'workspace', workspaceId: 'older' })
  })

  it('opens New chat with Rowan when no chat is open, and Team when the room has no Lead', () => {
    setState({ workspaces: [merged] })
    expect(archiveLanding(merged, undefined, 'Kai', onItsOwn, getState()).route).toEqual({ name: 'leadNew', roomId: 'r1' })
    setState({ agents: { r1: [] } })
    expect(archiveLanding(merged, undefined, 'Kai', onItsOwn, getState()).route).toEqual({ name: 'team', roomId: 'r1' })
  })

  it('opens the room for a review Kernel archived once the work it reviewed merged, and goes to History when that work is still open', () => {
    const review = ws('review', { reviewOf: 'mine', agentId: 'theo' })
    const sent = archiveLanding(review, merged, 'Theo', onItsOwn, getState())
    expect(sent.route).toEqual({ name: 'workspace', workspaceId: 'newer' })
    expect(sent.toast).toEqual({ title: "Archived Theo's review after PR #164 merged", sub: 'Restore it from History.' })
    expect(archiveLanding(review, ws('mine', { prState: 'ready', prNumber: 164 }), 'Theo', onItsOwn, getState())).toEqual({ route: { name: 'history' } })
  })
})
