import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushEvent } from '../src/shared/ipc'
import type { AgentDef, Chat, Room, Route, Thread, Workspace } from '../src/shared/types'

// KERNEL-578, KERNEL-596: archiving a chat with Rowan that is on screen moves the route once, straight to the room's front door, in the step that
// stores the archived workspace, whatever main takes to answer. Main's archive is a script of pushes here, in the order archiveLeadChat sends
// them: the workspaces the chat handed off one by one, then its own, then the closed thread.
let main: (threadId: string) => Promise<void> = async () => undefined
const calls: string[] = []
vi.mock('../src/renderer/src/api', () => ({
  cleanError: (e: unknown) => String(e),
  onPush: () => () => undefined,
  call: async (channel: string, req: { threadId: string }) => {
    calls.push(channel)
    if (channel === 'threads.archive') await main(req.threadId)
    return { ok: true }
  }
}))

const { apply, getState, setState, subscribe } = await import('../src/renderer/src/store')
const { archiveChatNow } = await import('../src/renderer/src/screens/workspace/archiveChat')
const { followArchives } = await import('../src/renderer/src/screens/workspace/archiveLanding')

const room: Room = { id: 'r1', name: 'Client A', path: '/r/r1', defaultBranch: 'main', paused: false, createdAt: 1 }
const rowan = { id: 'rowan', lead: true } as AgentDef
const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId: 'r1', name: id, branch: `rowan/${id}`, baseRef: 'origin/main', path: `/w/${id}`, mode: 'worktree', agentId: 'rowan', lead: true, port: 0, status: 'ready', prState: 'none', createdAt: 1, ...over }) as Workspace
const kai = (id: string, threadId: string) => ws(id, { lead: undefined, agentId: 'kai', threadId, prState: 'ready', prNumber: 7 })
const thread = (id: string, at: number): Thread => ({ id, roomId: 'r1', title: `Chat ${id}`, createdAt: at })
const tab = (id: string, workspaceId: string, threadId: string): Chat => ({ id, workspaceId, threadId, title: id, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1 })

// Newest first in the sidebar: c, b, a.
const workspaces = () => [ws('a', { threadId: 't1' }), ws('b', { threadId: 't2' }), ws('c', { threadId: 't3' }), kai('kai-b', 't2')]
const archived = (id: string): PushEvent => ({ type: 'workspace', workspace: { ...getState().workspaces.find((w) => w.id === id)!, status: 'archived', archivedAt: 9 } })
const closed = (id: string): PushEvent => ({ type: 'thread', thread: { ...getState().threads[id], closedAt: 9 } })

// Every route the store takes, and every point where a push had been applied while the route sat on an archived workspace: with
// the push and the move in one synchronous step, no frame can paint between them.
let routes: Route[]
let exposed: string[]
const listen = () => {
  let last: Route = getState().ui.route
  return subscribe(() => {
    const now = getState().ui.route
    if (now !== last) routes.push(now)
    last = now
  })
}
const deliver = (e: PushEvent) => {
  apply(e)
  const route = getState().ui.route
  if (route.name === 'workspace' && getState().workspaces.find((w) => w.id === route.workspaceId)?.status === 'archived') exposed.push(route.workspaceId)
}

// Puts the window on a workspace, which is not a move of the archive's.
const on = (workspaceId: string) => {
  setState((s) => ({ ui: { ...s.ui, route: { name: 'workspace', workspaceId }, modal: null } }))
  routes = []
}

let stop: () => void
let follow: () => void
beforeEach(() => {
  stop?.()
  follow?.()
  calls.length = 0
  routes = []
  exposed = []
  setState({
    rooms: [room], agents: { r1: [rowan] }, workspaces: workspaces(),
    threads: { t1: thread('t1', 1), t2: thread('t2', 2), t3: thread('t3', 3) },
    chats: { a: [tab('a1', 'a', 't1')], b: [tab('b1', 'b', 't2')], c: [tab('c1', 'c', 't3')] }
  })
  main = async () => undefined
  on('b')
  stop = listen()
  follow = followArchives()
})
afterEach(() => follow?.())

const door: Route = { name: 'leadNew', roomId: 'r1' }

describe('archiving the chat on screen (KERNEL-596)', () => {
  it('moves once, to the front door, in the step that stores the archived workspace, and never to the chat above', async () => {
    main = async () => { deliver(archived('kai-b')); deliver(archived('b')); deliver(closed('t2')) }
    await archiveChatNow('t2', ['kai-b', 'b'])
    expect(routes).toEqual([door])
    expect(exposed).toEqual([])
    expect(calls).toEqual(['threads.archive'])
  })

  it('goes to the front door from the first chat in the sidebar, and from the only one left', async () => {
    on('c')
    main = async () => { deliver(archived('c')); deliver(closed('t3')) }
    await archiveChatNow('t3', ['c'])
    expect(routes).toEqual([door])
    expect(exposed).toEqual([])

    setState((s) => ({ workspaces: s.workspaces.filter((w) => w.id === 'a') }))
    on('a')
    main = async () => { deliver(archived('a')); deliver(closed('t1')) }
    await archiveChatNow('t1', ['a'])
    expect(routes).toEqual([door])
    expect(exposed).toEqual([])
  })

  it('moves when a workspace the chat handed off is the one on screen, and stays put as the rest of the archive arrives', async () => {
    on('kai-b')
    main = async () => { deliver(archived('kai-b')); deliver(archived('b')); deliver(closed('t2')) }
    await archiveChatNow('t2', ['kai-b', 'b'])
    expect(routes).toEqual([door])
    expect(exposed).toEqual([])
  })

  it('stays on the chat until main archives it, and moves right after, not when main answers', async () => {
    let seen: Route | undefined
    let answered = false
    main = async () => {
      await new Promise((r) => setTimeout(r, 20))
      expect(getState().ui.route).toEqual({ name: 'workspace', workspaceId: 'b' })
      deliver(archived('b'))
      seen = getState().ui.route
      await new Promise((r) => setTimeout(r, 20))
      answered = true
    }
    await archiveChatNow('t2', ['b'])
    expect(seen).toEqual(door)
    expect(answered).toBe(true)
    expect(routes).toHaveLength(1)
  })

  it('never shows History or another chat on the way, whatever order main archives in', async () => {
    main = async () => { deliver(archived('b')); deliver(archived('kai-b')); deliver(closed('t2')) }
    await archiveChatNow('t2', ['kai-b', 'b'])
    expect(routes).toEqual([door])
    expect(routes.some((r) => r.name === 'history' || (r.name === 'workspace' && r.workspaceId !== 'b'))).toBe(false)
  })

  it('leaves you on the chat when the archive fails, and rethrows for the error', async () => {
    main = async () => { throw new Error('Could not remove the worktree.') }
    await expect(archiveChatNow('t2', ['b'])).rejects.toThrow('Could not remove the worktree.')
    expect(routes).toEqual([])
    expect(getState().ui.route).toEqual({ name: 'workspace', workspaceId: 'b' })
  })

  it('does not move you when another screen is open, or pull you back after you went elsewhere', async () => {
    on('a')
    main = async () => { deliver(archived('b')); deliver(closed('t2')) }
    await archiveChatNow('t2', ['b'])
    expect(routes).toEqual([])

    on('b')
    main = async () => {
      setState((s) => ({ ui: { ...s.ui, route: { name: 'history' } } }))
      deliver(archived('b'))
    }
    await archiveChatNow('t2', ['b'])
    expect(getState().ui.route).toEqual({ name: 'history' })
  })

  it('marks the chat as archiving until main answers, so its workspaces fold with it', async () => {
    const { archivingChat } = await import('../src/renderer/src/screens/workspace/archiveChat')
    let during = false
    main = async () => { during = archivingChat('t2') }
    await archiveChatNow('t2', ['b'])
    expect(during).toBe(true)
    expect(archivingChat('t2')).toBe(false)
  })
})
