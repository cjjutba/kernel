import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { actions, canBack, getState, launchRoute, resetHistory, setState } from '../src/renderer/src/store'
import { currentThread, hasTab, isChatTab, nearest, placeToSave, restorePlace, projectHome, stillThere, tabOf } from '../src/renderer/src/nav'
import type { AgentDef, Chat, Project, Route, SharedFile, Workspace } from '../src/shared/types'

const project = (id: string, over: Partial<Project> = {}): Project => ({ id, name: id, path: `/r/${id}`, defaultBranch: 'main', paused: false, createdAt: 1, ...over }) as Project
const ws = (id: string, projectId: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, projectId, name: id, branch: id, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 0, status: 'ready', ...over }) as Workspace
const chat = (id: string, workspaceId: string, over: Partial<Chat> = {}): Chat => ({ id, workspaceId, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: 1, ...over }) as Chat
const lead = { id: 'kernel', lead: true } as AgentDef

/** One project with a Lead workspace of three chats, a second workspace of one, and a second project. */
function seed() {
  setState({
    projects: [project('r1'), project('r2')],
    agents: { r1: [lead] },
    workspaces: [ws('lead', 'r1', { name: 'lead', lead: true, threadId: 't1', agentId: 'kernel' }), ws('other', 'r1'), ws('r2lead', 'r2', { name: 'lead', lead: true, threadId: 'r2t' })],
    chats: { lead: [chat('c1', 'lead'), chat('c2', 'lead'), chat('c3', 'lead')], other: [chat('o1', 'other')], r2lead: [chat('x1', 'r2lead')] }
  })
  setState((s) => ({ ui: { ...s.ui, route: { name: 'projects' }, tabs: {} } }))
}
const route = () => getState().ui.route
const at = (workspaceId: string): Route => ({ name: 'workspace', workspaceId })

beforeEach(seed)

describe('currentThread (KERNEL-338)', () => {
  it('is the thread of the open chat tab, and of the last chat while a file tab is open', () => {
    setState({ chats: { lead: [chat('a1', 'lead', { threadId: 't1' }), chat('a2', 'lead', { threadId: 't1' }), chat('b1', 'lead', { threadId: 't2' }), chat('term', 'lead', { kind: 'terminal' })] } })
    expect(currentThread(getState(), 'lead')).toBe('t1')
    actions.ui.openTab('lead', 'b1')
    expect(currentThread(getState(), 'lead')).toBe('t2')
    actions.ui.openTab('lead', 'file:src/a.ts')
    expect(currentThread(getState(), 'lead')).toBe('t2')
    // A terminal has no chat of its own to show, so the chat before it stays the current one.
    actions.ui.openTab('lead', 'term')
    expect(currentThread(getState(), 'lead')).toBe('t2')
  })
  it('moves to another thread when the one on screen has no open tab left, and is none without chats', () => {
    setState({ chats: { lead: [chat('a1', 'lead', { threadId: 't1' }), chat('b1', 'lead', { threadId: 't2' })] } })
    actions.ui.openTab('lead', 'b1')
    actions.chats.upsert(chat('b1', 'lead', { threadId: 't2', closed: true }))
    expect(currentThread(getState(), 'lead')).toBe('t1')
    expect(currentThread(getState(), 'nothing')).toBeUndefined()
  })
})

describe('tabOf', () => {
  it('has no tab until a workspace has chats, then the first open chat', () => {
    expect(tabOf(getState(), 'nothing')).toBeUndefined()
    expect(tabOf(getState(), 'lead')).toBe('c1')
  })
  it('returns the stored chat, and falls back to the first open chat when it is gone', () => {
    actions.ui.openTab('lead', 'c3')
    expect(tabOf(getState(), 'lead')).toBe('c3')
    actions.chats.upsert(chat('c3', 'lead', { closed: true }))
    expect(tabOf(getState(), 'lead')).toBe('c1')
  })
  it('falls back to the last chat when a file or diff tab is not in the lists', () => {
    actions.ui.openTab('lead', 'c2')
    actions.ui.openTab('lead', 'file:a.ts')
    expect(tabOf(getState(), 'lead')).toBe('file:a.ts')
    actions.ui.setTabs('lead', { files: [] })
    expect(tabOf(getState(), 'lead')).toBe('c2')
    actions.ui.openTab('lead', 'diff:')
    expect(tabOf(getState(), 'lead')).toBe('diff:')
    actions.ui.setTabs('lead', { diffs: [] })
    expect(tabOf(getState(), 'lead')).toBe('c2')
  })
  it('keeps one tab per workspace', () => {
    actions.ui.openTab('lead', 'c3')
    actions.ui.openTab('other', 'o1')
    actions.ui.openTab('lead', 'file:a.ts')
    expect(tabOf(getState(), 'other')).toBe('o1')
    expect(getState().ui.tabs.lead).toEqual({ tab: 'file:a.ts', lastChat: 'c3', files: ['a.ts'], diffs: [], shared: [], recent: ['file:a.ts', 'c3'] })
  })
})

describe('openTab', () => {
  it('sets lastChat for chats only and lists a file or diff once', () => {
    actions.ui.openTab('lead', 'c2')
    actions.ui.openTab('lead', 'diff:src/a.ts')
    actions.ui.openTab('lead', 'diff:src/a.ts')
    actions.ui.openTab('lead', 'image:1')
    expect(getState().ui.tabs.lead).toEqual({ tab: 'image:1', lastChat: 'c2', files: [], diffs: ['src/a.ts'], shared: [], recent: ['image:1', 'diff:src/a.ts', 'c2'] })
  })
})

const sharedFile = (id: string, versions: number[]): SharedFile => ({
  id, projectId: 'r1', workspaceId: 'lead', agentId: 'noor', source: `.kernel/shared/${id}.html`, title: id, kind: 'html', createdAt: 1, updatedAt: 1,
  versions: versions.map((n) => ({ n, at: n, file: `${id}.html`, mime: 'text/html', bytes: 10, sha256: `${id}${n}` }))
})

describe('shared tabs', () => {
  beforeEach(() => setState({ shared: { s1: sharedFile('s1', [1, 2, 3]), s2: sharedFile('s2', [1]) } }))

  it('lists a shared tab once, selects it and leaves lastChat on the chat', () => {
    actions.ui.openTab('lead', 'c2')
    actions.ui.openTab('lead', 'shared:s1')
    actions.ui.openTab('lead', 'shared:s2')
    actions.ui.openTab('lead', 'shared:s1')
    expect(getState().ui.tabs.lead).toEqual({ tab: 'shared:s1', lastChat: 'c2', files: [], diffs: [], shared: ['s1', 's2'], recent: ['shared:s1', 'shared:s2', 'c2'] })
  })
  it('is open only while it is in the list, and falls back to the last chat when it is closed', () => {
    expect(hasTab(getState(), 'lead', 'shared:s1')).toBe(false)
    actions.ui.openTab('lead', 'c3')
    actions.ui.openShared('lead', 's1')
    expect(hasTab(getState(), 'lead', 'shared:s1')).toBe(true)
    expect(hasTab(getState(), 'other', 'shared:s1')).toBe(false)
    expect(tabOf(getState(), 'lead')).toBe('shared:s1')
    actions.ui.setTabs('lead', { shared: [] })
    expect(hasTab(getState(), 'lead', 'shared:s1')).toBe(false)
    expect(tabOf(getState(), 'lead')).toBe('c3')
  })
  it('is not a chat tab, so switching to it is not a step', () => {
    expect(isChatTab('shared:s1')).toBe(false)
    expect(isChatTab('c1')).toBe(true)
    resetHistory()
    actions.ui.go(at('lead'))
    actions.ui.openTab('lead', 'c2')
    resetHistory()
    actions.ui.openShared('lead', 's1')
    expect(canBack()).toBe(false)
  })
  it('opens in any workspace, since the copy is Kernel\'s', () => {
    actions.ui.openShared('other', 's2')
    expect(tabOf(getState(), 'other')).toBe('shared:s2')
    expect(getState().ui.tabs.other.shared).toEqual(['s2'])
  })
  it('follows the latest version until an older one is picked, and the latest clears the pick', () => {
    actions.ui.openShared('lead', 's1')
    expect(getState().ui.tabs.lead.sharedVersion).toBeUndefined()
    actions.ui.openShared('lead', 's1', 2)
    expect(getState().ui.tabs.lead.sharedVersion).toEqual({ s1: 2 })
    // Opening the tab again from a card keeps the pick.
    actions.ui.openShared('lead', 's1')
    expect(getState().ui.tabs.lead.sharedVersion).toEqual({ s1: 2 })
    actions.ui.openShared('lead', 's1', 3)
    expect(getState().ui.tabs.lead.sharedVersion).toEqual({})
  })
  it('keeps each file\'s pick apart', () => {
    actions.ui.openShared('lead', 's1', 1)
    actions.ui.openShared('lead', 's2', 1)
    expect(getState().ui.tabs.lead.sharedVersion).toEqual({ s1: 1 })
  })
  it('is saved and restored with the tabs', () => {
    actions.ui.go(at('lead'))
    actions.ui.openShared('lead', 's1', 2)
    const place = placeToSave(getState())!
    expect(place.tabs.lead).toMatchObject({ tab: 'shared:s1', shared: ['s1'], recent: ['shared:s1'], sharedVersion: { s1: 2 } })
    const back = restorePlace(JSON.stringify(place), getState())
    expect(back?.tabs.lead).toEqual({ tab: 'shared:s1', lastChat: undefined, files: [], diffs: [], shared: ['s1'], recent: ['shared:s1'], sharedVersion: { s1: 2 } })
  })
  it('restores only well-formed shared tabs', () => {
    const tabs = { lead: { tab: 'shared:s1', lastChat: 'c2', files: [], diffs: [], shared: ['s1', 4, ''], sharedVersion: { s1: 'two', s2: 1 } } }
    expect(restorePlace(JSON.stringify({ v: 1, route: at('lead'), tabs }), getState())?.tabs.lead).toEqual({ tab: 'shared:s1', lastChat: 'c2', files: [], diffs: [], shared: ['s1'] })
  })
})

describe('shared files in the store', () => {
  it('adds a pushed file and replaces it when a new version arrives', () => {
    actions.shared.set([sharedFile('s1', [1])])
    actions.shared.upsert(sharedFile('s2', [1]))
    actions.shared.upsert(sharedFile('s1', [1, 2]))
    expect(Object.keys(getState().shared).sort()).toEqual(['s1', 's2'])
    expect(getState().shared.s1.versions).toHaveLength(2)
  })
})

describe('stillThere and nearest', () => {
  it('keeps a route that is there', () => {
    expect(stillThere(at('other'), getState())).toBe(true)
    expect(nearest(at('other'), getState())).toEqual(at('other'))
  })
  it('sends an archived workspace to the project’s Lead workspace', () => {
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    expect(stillThere(at('other'), getState())).toBe(false)
    expect(nearest(at('other'), getState())).toEqual(at('lead'))
  })
  it('sends an archived chat with Kernel to New chat with Kernel when no other chat is open, and a project with no Lead to Team (KERNEL-405)', () => {
    actions.workspaces.upsert(ws('lead', 'r1', { name: 'lead', lead: true, threadId: 't1', agentId: 'kernel', status: 'archived' }))
    expect(nearest(at('lead'), getState())).toEqual({ name: 'leadNew', projectId: 'r1' })
    setState((s) => ({ agents: { ...s.agents, r1: [] } }))
    expect(nearest(at('lead'), getState())).toEqual({ name: 'settings', page: 'project', projectId: 'r1', section: 'agents' })
  })
  it("sends a chat whose workspace closed to the project's newest open chat (KERNEL-405)", () => {
    actions.workspaces.upsert(ws('newer', 'r1', { lead: true, threadId: 't2', agentId: 'kernel', createdAt: 5 }))
    setState((s) => ({ threads: { t1: { id: 't1', projectId: 'r1', title: 'One', createdAt: 1 }, t2: { id: 't2', projectId: 'r1', title: 'Two', createdAt: 2 } } }))
    expect(projectHome('r1', getState())).toEqual(at('newer'))
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    expect(nearest(at('other'), getState())).toEqual(at('newer'))
  })
  it('opens a project on the chat the user last sent a message in, the one the sidebar lists on top (KERNEL-498)', () => {
    const newer = ws('newer', 'r1', { lead: true, threadId: 't2', agentId: 'kernel', createdAt: 5 })
    actions.workspaces.upsert(newer)
    setState({ threads: { t1: { id: 't1', projectId: 'r1', title: 'One', createdAt: 1, lastSentAt: 9 }, t2: { id: 't2', projectId: 'r1', title: 'Two', createdAt: 2 } } })
    expect(projectHome('r1', getState())).toEqual(at('lead'))
    // The engine pushes the thread when the user sends in the newer chat.
    actions.threads.upsert({ id: 't2', projectId: 'r1', title: 'Two', createdAt: 2, lastSentAt: 12 })
    expect(projectHome('r1', getState())).toEqual(at('newer'))
    // A chat whose folder is gone is passed over for the next one down.
    actions.workspaces.upsert({ ...newer, folderGone: true })
    expect(projectHome('r1', getState())).toEqual(at('lead'))
  })
  it("treats a workspace whose folder was deleted outside Kernel as gone, so reopening and Back skip it (KERNEL-291)", () => {
    actions.workspaces.upsert(ws('other', 'r1', { folderGone: true }))
    expect(stillThere(at('other'), getState())).toBe(false)
    expect(nearest(at('other'), getState())).toEqual(at('lead'))
    actions.workspaces.upsert(ws('lead', 'r1', { name: 'lead', lead: true, threadId: 't1', agentId: 'kernel', folderGone: true }))
    expect(projectHome('r1', getState())).toEqual({ name: 'leadNew', projectId: 'r1' })
  })
  it('sends a removed project, and a hidden or archived one, to New chat in another project, or New chat with no project when none is left', () => {
    actions.projects.upsert(project('r2', { archived: true }))
    expect(nearest(at('r2lead'), getState())).toEqual({ name: 'leadNew', projectId: 'r1' })
    actions.projects.remove('r1')
    expect(nearest(at('other'), getState())).toEqual({ name: 'leadNew', projectId: '' })
    expect(nearest({ name: 'settings', page: 'project', projectId: 'r1', section: 'agents' }, getState())).toEqual({ name: 'leadNew', projectId: '' })
  })
  it('treats a Settings project page as gone with its project, and other pages as always there', () => {
    expect(stillThere({ name: 'settings', page: 'project', projectId: 'r1' }, getState())).toBe(true)
    actions.projects.remove('r1')
    expect(stillThere({ name: 'settings', page: 'project', projectId: 'r1' }, getState())).toBe(false)
    expect(nearest({ name: 'settings', page: 'project', projectId: 'r1' }, getState())).toEqual({ name: 'leadNew', projectId: 'r2' })
    expect(stillThere({ name: 'settings', page: 'models' }, getState())).toBe(true)
  })
})

describe('tabs are dropped with their workspace', () => {
  it('on archive, on workspaces.set and when the project is removed', () => {
    for (const id of ['lead', 'other', 'r2lead']) actions.ui.openTab(id, id === 'lead' ? 'c2' : id === 'other' ? 'o1' : 'x1')
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    expect(Object.keys(getState().ui.tabs).sort()).toEqual(['lead', 'r2lead'])
    actions.projects.remove('r2')
    expect(Object.keys(getState().ui.tabs)).toEqual(['lead'])
    actions.workspaces.set([])
    expect(getState().ui.tabs).toEqual({})
  })
})

describe('Settings remembers where you were', () => {
  it('Back to app returns to the workspace and its chat, through any number of Settings pages', () => {
    actions.ui.go(at('lead'))
    actions.ui.openTab('lead', 'c3')
    actions.ui.openSettings()
    actions.ui.go({ name: 'settings', page: 'models' })
    actions.ui.go({ name: 'settings', page: 'permissions' })
    actions.ui.leaveSettings()
    expect(route()).toEqual(at('lead'))
    expect(tabOf(getState(), 'lead')).toBe('c3')
  })
  it('keeps a diff tab and the chat behind it', () => {
    actions.ui.go(at('lead'))
    actions.ui.openTab('lead', 'c2')
    actions.ui.openTab('lead', 'diff:src/a.ts')
    actions.ui.openSettings()
    actions.ui.leaveSettings()
    expect(tabOf(getState(), 'lead')).toBe('diff:src/a.ts')
    expect(getState().ui.tabs.lead.lastChat).toBe('c2')
  })
  it('does not take Settings as the place to return to', () => {
    actions.ui.go({ name: 'inbox' })
    actions.ui.go({ name: 'settings', page: 'general' })
    actions.ui.go({ name: 'settings', page: 'hooks' })
    actions.ui.leaveSettings()
    expect(route()).toEqual({ name: 'inbox' })
  })
  it('switching workspaces and back keeps each one’s chat', () => {
    actions.ui.go(at('lead'))
    actions.ui.openTab('lead', 'c3')
    actions.ui.go(at('other'))
    actions.ui.go(at('lead'))
    expect(tabOf(getState(), 'lead')).toBe('c3')
  })
  it('⌘, reopens the last page, and General when that project page is gone', () => {
    actions.ui.go({ name: 'settings', page: 'project', projectId: 'r2' })
    actions.ui.leaveSettings()
    actions.ui.openSettings()
    expect(route()).toEqual({ name: 'settings', page: 'project', projectId: 'r2' })
    actions.ui.leaveSettings()
    actions.projects.remove('r2')
    actions.ui.openSettings()
    expect(route()).toEqual({ name: 'settings', page: 'general' })
  })
  it('Back to app lands on the nearest place when the workspace was archived or the project removed meanwhile', () => {
    actions.ui.go(at('other'))
    actions.ui.openSettings()
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    actions.ui.leaveSettings()
    expect(route()).toEqual(at('lead'))
    actions.ui.go(at('r2lead'))
    actions.ui.openSettings()
    actions.projects.remove('r2')
    actions.ui.leaveSettings()
    expect(route()).toEqual({ name: 'leadNew', projectId: 'r1' })
  })
})

// KERNEL-201: reopening where you left off.
describe('restorePlace', () => {
  const saved = (route: unknown, tabs: unknown = {}, v: unknown = 1) => JSON.stringify({ v, route, tabs })
  const lead3 = { lead: { tab: 'c3', lastChat: 'c3', files: [], diffs: [] } }

  it('opens a live workspace on its tab, with its tabs', () => {
    const tabs = { lead: { tab: 'c3', lastChat: 'c3', files: ['a.ts'], diffs: ['src/a.ts', ''] }, other: { tab: 'diff:src/b.ts', files: [], diffs: ['src/b.ts'] } }
    expect(restorePlace(saved(at('lead'), tabs), getState())).toEqual({ route: at('lead'), tabs })
  })
  it('drops the tabs of a workspace that is archived or gone, and opens the project\'s Lead chat', () => {
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    const tabs = { ...lead3, other: { tab: 'o1', files: [], diffs: [] }, vanished: { tab: 'v1', files: [], diffs: [] } }
    expect(restorePlace(saved(at('other'), tabs), getState())).toEqual({ route: at('lead'), tabs: lead3 })
  })
  it('opens New chat in another project when the project is gone', () => {
    actions.projects.remove('r2')
    expect(restorePlace(saved(at('r2lead')), getState())?.route).toEqual({ name: 'leadNew', projectId: 'r1' })
    expect(restorePlace(saved({ name: 'team', projectId: 'r2' }), getState())?.route).toEqual({ name: 'leadNew', projectId: 'r1' })
  })
  it('opens the project\'s Agents page in Settings for a team, agent, task, floor or board route', () => {
    for (const route of [{ name: 'team', projectId: 'r1' }, { name: 'agent', projectId: 'r1', agentId: 'kai' }, { name: 'task', projectId: 'r1', taskId: 't1' }, { name: 'floor', projectId: 'r1' }, { name: 'board', projectId: 'r1' }]) {
      expect(restorePlace(saved(route), getState())?.route).toEqual({ name: 'settings', page: 'project', projectId: 'r1', section: 'agents' })
    }
  })
  it('opens the other screens as they were', () => {
    for (const route of [{ name: 'inbox' }, { name: 'history' }, { name: 'projects' }, { name: 'issues', issueId: 'KERNEL-9' }, { name: 'leadNew', projectId: 'r1' }]) {
      expect(restorePlace(saved(route), getState())?.route).toEqual(route)
    }
  })
  it('reads a place saved before rooms were renamed projects (KERNEL-880)', () => {
    expect(restorePlace(saved({ name: 'rooms' }), getState())?.route).toEqual({ name: 'projects' })
    expect(restorePlace(saved({ name: 'leadNew', roomId: 'r1' }), getState())?.route).toEqual({ name: 'leadNew', projectId: 'r1' })
    expect(restorePlace(saved({ name: 'issues', issueId: 'KERNEL-9', roomId: 'r1' }), getState())?.route).toEqual({ name: 'issues', issueId: 'KERNEL-9', projectId: 'r1' })
  })
  it('keeps the source and picks of the New chat page, and drops ones that are not whole (KERNEL-788)', () => {
    const source = { kind: 'issue', id: 'KERNEL-9', title: 'Toast says which account', url: 'https://linear.app/x/KERNEL-9', tracker: 'linear' }
    const picks = { mode: 'worktree', model: 'claude-opus-5-5', effort: 'high', plan: true, baseRef: 'origin/dev' }
    expect(restorePlace(saved({ name: 'leadNew', projectId: 'r1', source, picks }), getState())?.route).toEqual({ name: 'leadNew', projectId: 'r1', source, picks })
    expect(restorePlace(saved({ name: 'leadNew', projectId: 'r1', source: { kind: 'issue' }, picks: { ...picks, plan: 'yes' } }), getState())?.route).toEqual({ name: 'leadNew', projectId: 'r1' })
  })
  it('has nothing to restore for no value, bad JSON, an unknown version or a route it will not reopen', () => {
    expect(restorePlace(null, getState())).toBeUndefined()
    expect(restorePlace('{nope', getState())).toBeUndefined()
    expect(restorePlace('null', getState())).toBeUndefined()
    expect(restorePlace(saved(at('lead'), {}, 2), getState())).toBeUndefined()
    expect(restorePlace(JSON.stringify({ route: at('lead'), tabs: {} }), getState())).toBeUndefined()
    for (const route of [{ name: 'settings', page: 'general' }, { name: 'onboarding', step: 'welcome' }, { name: 'devUi', page: 'components' }, { name: 'nope' }, { name: 'workspace' }, { name: 'team' }, { name: 'home' }, 'home', null]) {
      expect(restorePlace(saved(route), getState())).toBeUndefined()
    }
  })
  it('keeps only well-formed tabs', () => {
    const tabs = { lead: { tab: 7, lastChat: 'c2', files: ['a.ts', 3], diffs: 'no' } }
    expect(restorePlace(saved(at('lead'), tabs), getState())?.tabs).toEqual({ lead: { lastChat: 'c2', files: ['a.ts'], diffs: [] } })
  })
})

describe('placeToSave', () => {
  it('is the route and the tabs', () => {
    actions.ui.go(at('lead'))
    actions.ui.openTab('lead', 'c2')
    expect(placeToSave(getState())).toEqual({ v: 1, route: at('lead'), tabs: { lead: { tab: 'c2', lastChat: 'c2', files: [], diffs: [], shared: [], recent: ['c2'] } } })
  })
  it('is where Settings was opened from while Settings is open, and nothing without one', () => {
    actions.ui.go({ name: 'settings', page: 'general' })
    expect(placeToSave(getState())).toBeUndefined()
    expect(placeToSave(getState(), { route: { name: 'inbox' } })?.route).toEqual({ name: 'inbox' })
  })
  it('is nothing on onboarding or the dev pages', () => {
    actions.ui.go({ name: 'onboarding', step: 'welcome' })
    expect(placeToSave(getState())).toBeUndefined()
    actions.ui.go({ name: 'devUi', page: 'components' })
    expect(placeToSave(getState())).toBeUndefined()
  })
})

// KERNEL-201: Continue on the checks screen opens the place the launch would have.
describe('launchRoute, which Continue on the checks screen goes to', () => {
  const place = JSON.stringify({ v: 1, route: at('lead'), tabs: { lead: { tab: 'c3', lastChat: 'c3', files: [], diffs: ['src/a.ts'] } } })
  const continueFromChecks = () => actions.ui.go(launchRoute(), { history: 'replace' })
  const openTo = (value: 'lastPlace' | 'inbox') => setState({ settings: { ...DEFAULT_SETTINGS('/home/cj'), general: { ...DEFAULT_SETTINGS('/home/cj').general, openTo: value } } })

  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'kernel.lastPlace' ? place : null), setItem: () => undefined, removeItem: () => undefined })
    resetHistory()
    actions.ui.go({ name: 'onboarding', step: 'checks' }, { history: 'replace' })
  })
  afterEach(() => { vi.unstubAllGlobals(); setState({ settings: null }) })

  it('with Where I left off opens the saved place and brings its tabs back', () => {
    openTo('lastPlace')
    continueFromChecks()
    expect(route()).toEqual(at('lead'))
    expect(getState().ui.tabs.lead).toMatchObject({ tab: 'c3', diffs: ['src/a.ts'] })
    expect(tabOf(getState(), 'lead')).toBe('c3')
  })
  it('replaces, so Back right after has nowhere to go', () => {
    openTo('lastPlace')
    continueFromChecks()
    expect(canBack()).toBe(false)
  })
  it('opens the nearest place that is still there when the saved workspace was archived', () => {
    openTo('lastPlace')
    actions.workspaces.upsert(ws('lead', 'r1', { name: 'lead', lead: true, threadId: 't1', agentId: 'kernel', status: 'archived' }))
    actions.workspaces.upsert(ws('lead2', 'r1', { name: 'lead', lead: true, threadId: 't2', agentId: 'kernel' }))
    continueFromChecks()
    expect(route()).toEqual(at('lead2'))
  })
  it('with Inbox opens Inbox', () => {
    openTo('inbox')
    continueFromChecks()
    expect(route()).toEqual({ name: 'inbox' })
  })
  it('keeps a tab that is already open, so asking again after boot changes nothing', () => {
    openTo('lastPlace')
    actions.ui.setTabs('lead', { diffs: ['kept.ts'] })
    launchRoute()
    expect(getState().ui.tabs.lead.diffs).toEqual(['kept.ts'])
  })
  it('without a saved place falls back to the last project, then New chat in the first project', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'kernel.lastRoom' ? 'r1' : null), setItem: () => undefined, removeItem: () => undefined })
    openTo('lastPlace')
    expect(launchRoute()).toEqual(at('lead'))
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    expect(launchRoute()).toEqual({ name: 'leadNew', projectId: 'r1' })
  })
})

// KERNEL-191 put each project's settings under the project, as a section of the project page. KERNEL-201 must keep them working.
describe('a project Settings page with a section', () => {
  const page: Route = { name: 'settings', page: 'project', projectId: 'r2', section: 'git' }

  it('⌘, reopens it with its section, and Back to app returns to where Settings was opened from', () => {
    actions.ui.go(at('lead'))
    actions.ui.go(page)
    actions.ui.leaveSettings()
    expect(route()).toEqual(at('lead'))
    actions.ui.openSettings()
    expect(route()).toEqual(page)
  })
  it('falls back to General when its project is removed', () => {
    actions.ui.go(page)
    actions.ui.leaveSettings()
    actions.projects.remove('r2')
    actions.ui.openSettings()
    expect(route()).toEqual({ name: 'settings', page: 'general' })
  })
  it('saves the place it was opened from, never the project page, for the page and for moving between pages', () => {
    actions.ui.go(at('lead'))
    actions.ui.openTab('lead', 'c2')
    actions.ui.go(page)
    expect(placeToSave(getState(), { route: at('lead') })?.route).toEqual(at('lead'))
    actions.ui.go({ ...page, section: 'setup' } as Route)
    expect(placeToSave(getState(), { route: at('lead') })?.route).toEqual(at('lead'))
    expect(placeToSave(getState(), { route: at('lead') })?.tabs.lead.tab).toBe('c2')
  })
  it('is never restored: a saved project page opens nothing', () => {
    expect(restorePlace(JSON.stringify({ v: 1, route: page, tabs: {} }), getState())).toBeUndefined()
  })
})
