import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushEvent } from '../src/shared/ipc'
import type { AgentDef, Project, Route, Thread, Workspace } from '../src/shared/types'

// KERNEL-596: one rule decides where an archive takes you. The chat or workspace on screen goes to the project's front door, in the step that
// stores its archived status. Anything else leaves you where you are. Never History, never another chat.
let fail: Error | undefined
vi.mock('../src/renderer/src/api', () => ({
  cleanError: (e: unknown) => String(e),
  onPush: () => () => undefined,
  call: async () => { if (fail) throw fail; return { ok: true } }
}))

const { apply, getState, setState, subscribe } = await import('../src/renderer/src/store')
const { archiveDestination, frontDoor, projectHome } = await import('../src/renderer/src/nav')
const { followArchives } = await import('../src/renderer/src/screens/workspace/archiveLanding')
const { archiveByHand, restoredFromHistory } = await import('../src/renderer/src/screens/workspace/byHand')

const project = (id: string): Project => ({ id, name: id, path: `/r/${id}`, defaultBranch: 'main', paused: false, createdAt: 1 }) as Project
const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, projectId: 'r1', name: id, branch: id, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'christian', port: 0, status: 'ready', prState: 'none', createdAt: 1, ...over }) as Workspace
const chat = (id: string, threadId: string, over: Partial<Workspace> = {}) => ws(id, { lead: true, threadId, agentId: 'kernel', ...over })
const thread = (id: string, over: Partial<Thread> = {}): Thread => ({ id, projectId: 'r1', title: id, createdAt: 1, ...over }) as Thread
const kernel = { id: 'kernel', lead: true } as AgentDef
const christian = { id: 'christian', name: 'Christian' } as AgentDef
const artkin = { id: 'artkin', name: 'Artkin' } as AgentDef

const world = () => [
  chat('newer', 't2', { createdAt: 2 }), chat('older', 't1'),
  ws('handed', { threadId: 't2' }), ws('plain'),
  ws('merged', { prState: 'merged', prNumber: 164 }),
  ws('review', { agentId: 'artkin', reviewOf: 'merged' })
]
const at = (workspaceId: string): Route => ({ name: 'workspace', workspaceId })
const door: Route = { name: 'leadNew', projectId: 'r1' }
const archived = (id: string): PushEvent => ({ type: 'workspace', workspace: { ...getState().workspaces.find((w) => w.id === id)!, status: 'archived', archivedAt: 9 } })

beforeEach(() => {
  fail = undefined
  setState({
    projects: [project('r1')], agents: { r1: [kernel, christian, artkin] }, workspaces: world(),
    threads: { t1: thread('t1', { createdAt: 1 }), t2: thread('t2', { createdAt: 2 }) }, chats: {}
  })
  setState((s) => ({ ui: { ...s.ui, route: { name: 'inbox' }, modal: null, toasts: [] } }))
})

describe("the project's front door (KERNEL-596)", () => {
  it('is New chat with Kernel whatever chats are open, where projectHome would pick the top chat', () => {
    expect(projectHome('r1', getState())).toEqual(at('newer'))
    expect(frontDoor('r1', getState())).toEqual(door)
  })

  it('is the Agents page of a project with no Lead, and reads a Lead from its workspaces before agents load', () => {
    setState({ agents: { r1: [christian] } })
    expect(frontDoor('r1', getState())).toEqual({ name: 'settings', page: 'project', projectId: 'r1', section: 'agents' })
    setState({ agents: {} })
    expect(frontDoor('r1', getState())).toEqual(door)
  })
})

describe('where an archive takes you', () => {
  const stored = (...ids: string[]) => (id: string) => ids.includes(id)

  it.each(['newer', 'handed', 'plain', 'merged', 'review'])('goes to the front door when %s, the workspace on screen, is archived', (id) => {
    expect(archiveDestination(at(id), getState(), stored(id))).toEqual(door)
  })

  it('goes to the project of the archived workspace, not to the project you were last in', () => {
    setState((s) => ({ projects: [...s.projects, project('r2')], workspaces: [...s.workspaces, ws('far', { projectId: 'r2' })] }))
    expect(archiveDestination(at('far'), getState(), stored('far'))).toEqual({ name: 'settings', page: 'project', projectId: 'r2', section: 'agents' })
  })

  it('stays where you are for anything not on screen', () => {
    expect(archiveDestination(at('older'), getState(), stored('newer'))).toBeUndefined()
    for (const route of [{ name: 'history' }, { name: 'inbox' }, { name: 'inbox' }, door, { name: 'settings', page: 'project', projectId: 'r1', section: 'agents' }, { name: 'settings', page: 'general' }] as Route[]) {
      expect(archiveDestination(route, getState(), stored('newer', 'handed', 'plain'))).toBeUndefined()
    }
  })

  it('never answers History or another chat', () => {
    for (const id of ['newer', 'older', 'handed', 'plain', 'merged', 'review']) {
      const to = archiveDestination(at(id), getState(), stored(id))
      expect(to?.name).not.toBe('history')
      expect(to).not.toEqual(at('newer'))
      expect(to).not.toEqual(at('older'))
    }
  })
})

describe('the route follows the archived status (KERNEL-596)', () => {
  let stop: () => void
  let routes: Route[]
  let exposed: string[]
  let mark: ReturnType<typeof subscribe>
  const on = (id: string) => {
    setState((s) => ({ ui: { ...s.ui, route: at(id), modal: null, toasts: [] } }))
    routes = []
  }
  // A push applied while the route still sits on an archived workspace is a point where a frame could paint the stripped screen.
  const deliver = (e: PushEvent) => {
    apply(e)
    const route = getState().ui.route
    if (route.name === 'workspace' && getState().workspaces.find((w) => w.id === route.workspaceId)?.status === 'archived') exposed.push(route.workspaceId)
  }

  beforeEach(() => {
    routes = []
    exposed = []
    stop = followArchives()
    let last: Route = getState().ui.route
    mark = subscribe(() => { const now = getState().ui.route; if (now !== last) routes.push(now); last = now })
  })
  afterEach(() => { stop(); mark(); for (const w of world()) restoredFromHistory(w.id) })

  it.each([
    ['a chat with Kernel', 'newer'],
    ['a workspace it handed off', 'handed'],
    ['a plain workspace', 'plain'],
    ['a workspace whose PR merged', 'merged'],
    ['a review', 'review']
  ])('moves once, straight to the front door, when %s on screen is archived', (_, id) => {
    on(id)
    deliver(archived(id))
    expect(routes).toEqual([door])
    expect(exposed).toEqual([])
    deliver({ type: 'thread', thread: { ...getState().threads.t2, closedAt: 9 } })
    deliver(archived('older'))
    expect(routes).toEqual([door])
  })

  it('does not move for a different screen, or for another chat or workspace being archived', () => {
    for (const route of [{ name: 'history' }, { name: 'inbox' }, { name: 'settings', page: 'project', projectId: 'r1', section: 'agents' }, { name: 'settings', page: 'general' }, at('older')] as Route[]) {
      setState((s) => ({ ui: { ...s.ui, route } }))
      routes = []
      deliver(archived('newer'))
      deliver(archived('handed'))
      deliver(archived('plain'))
      expect(routes).toEqual([])
      expect(getState().ui.route).toEqual(route)
      setState({ workspaces: world() })
    }
  })

  it('does not pull you back after you went elsewhere while main was still archiving', () => {
    on('newer')
    setState((s) => ({ ui: { ...s.ui, route: { name: 'history' } } }))
    routes = []
    deliver(archived('newer'))
    expect(routes).toEqual([])
    expect(getState().ui.route).toEqual({ name: 'history' })
  })

  it('stays when an archived workspace is opened, from History, or restored while it is open', () => {
    deliver(archived('plain'))
    on('plain')
    deliver(archived('plain'))
    expect(routes).toEqual([])
    deliver({ type: 'workspace', workspace: ws('plain') })
    expect(routes).toEqual([])
    expect(getState().ui.route).toEqual(at('plain'))
  })

  it('stays when a workspace the window never knew arrives archived', () => {
    on('ghost')
    deliver({ type: 'workspace', workspace: ws('ghost', { status: 'archived' }) })
    expect(routes).toEqual([])
  })

  it('keeps you where you were when the archive fails, because no archived status is stored', async () => {
    on('plain')
    fail = new Error('Could not remove the worktree.')
    await expect(archiveByHand({ workspaceId: 'plain' })).rejects.toThrow('Could not remove the worktree.')
    expect(routes).toEqual([])
    expect(getState().ui.route).toEqual(at('plain'))
  })

  it('says nothing for an archive by hand', async () => {
    for (const id of ['plain', 'merged', 'review']) {
      on(id)
      await archiveByHand({ workspaceId: id })
      deliver(archived(id))
      expect(routes).toEqual([door])
      expect(getState().ui.toasts).toEqual([])
    }
  })

  it('tells the user when Kernel archived the workspace on screen after its PR merged, or a review after its work did', () => {
    on('merged')
    deliver(archived('merged'))
    expect(getState().ui.toasts.map((t) => ({ title: t.title, sub: t.sub }))).toEqual([{ title: "Archived Christian's workspace after PR #164 merged", sub: 'Restore it from History.' }])
    on('review')
    deliver(archived('review'))
    expect(getState().ui.toasts.map((t) => t.title)).toEqual(["Archived Artkin's review after PR #164 merged"])
  })

  it('moves without a toast for any other archive Kernel makes, such as the Lead archiving a workspace', () => {
    on('plain')
    deliver(archived('plain'))
    expect(routes).toEqual([door])
    expect(getState().ui.toasts).toEqual([])
  })

  it('moves at the second of two pushes when the first was not the workspace on screen', () => {
    on('newer')
    deliver(archived('handed'))
    expect(routes).toEqual([])
    deliver(archived('newer'))
    expect(routes).toEqual([door])
  })
})
