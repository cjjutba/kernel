import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { actions, canBack, getState, launchRoute, resetHistory, setState } from '../src/renderer/src/store'
import { nearest, placeToSave, restorePlace, stillThere, tabOf } from '../src/renderer/src/nav'
import type { AgentDef, Chat, Room, Route, Workspace } from '../src/shared/types'

const room = (id: string, over: Partial<Room> = {}): Room => ({ id, name: id, path: `/r/${id}`, defaultBranch: 'main', paused: false, createdAt: 1, ...over }) as Room
const ws = (id: string, roomId: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId, name: id, branch: id, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 0, status: 'ready', ...over }) as Workspace
const chat = (id: string, workspaceId: string, over: Partial<Chat> = {}): Chat => ({ id, workspaceId, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: 1, ...over }) as Chat
const lead = { id: 'rowan', lead: true } as AgentDef

/** One room with a Lead workspace of three chats, a second workspace of one, and a second room. */
function seed() {
  setState({
    rooms: [room('r1'), room('r2')],
    agents: { r1: [lead] },
    workspaces: [ws('lead', 'r1', { name: 'lead', mode: 'current', agentId: 'rowan' }), ws('other', 'r1'), ws('r2lead', 'r2', { name: 'lead', mode: 'current' })],
    chats: { lead: [chat('c1', 'lead'), chat('c2', 'lead'), chat('c3', 'lead')], other: [chat('o1', 'other')], r2lead: [chat('x1', 'r2lead')] }
  })
  setState((s) => ({ ui: { ...s.ui, route: { name: 'home' }, tabs: {} } }))
}
const route = () => getState().ui.route
const at = (workspaceId: string): Route => ({ name: 'workspace', workspaceId })

beforeEach(seed)

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
    expect(getState().ui.tabs.lead).toEqual({ tab: 'file:a.ts', lastChat: 'c3', files: ['a.ts'], diffs: [] })
  })
})

describe('openTab', () => {
  it('sets lastChat for chats only and lists a file or diff once', () => {
    actions.ui.openTab('lead', 'c2')
    actions.ui.openTab('lead', 'diff:src/a.ts')
    actions.ui.openTab('lead', 'diff:src/a.ts')
    actions.ui.openTab('lead', 'image:1')
    expect(getState().ui.tabs.lead).toEqual({ tab: 'image:1', lastChat: 'c2', files: [], diffs: ['src/a.ts'] })
  })
})

describe('stillThere and nearest', () => {
  it('keeps a route that is there', () => {
    expect(stillThere(at('other'), getState())).toBe(true)
    expect(nearest(at('other'), getState())).toEqual(at('other'))
  })
  it('sends an archived workspace to the room’s Lead workspace', () => {
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    expect(stillThere(at('other'), getState())).toBe(false)
    expect(nearest(at('other'), getState())).toEqual(at('lead'))
  })
  it('sends an archived Lead workspace to the room’s Team page', () => {
    actions.workspaces.upsert(ws('lead', 'r1', { name: 'lead', mode: 'current', agentId: 'rowan', status: 'archived' }))
    expect(nearest(at('lead'), getState())).toEqual({ name: 'team', roomId: 'r1' })
  })
  it('sends a removed room, and a hidden or archived one, Home', () => {
    actions.rooms.upsert(room('r2', { archived: true }))
    expect(nearest(at('r2lead'), getState())).toEqual({ name: 'home' })
    actions.rooms.remove('r1')
    expect(nearest(at('other'), getState())).toEqual({ name: 'home' })
    expect(nearest({ name: 'team', roomId: 'r1' }, getState())).toEqual({ name: 'home' })
  })
  it('treats a Settings room page as gone with its room, and other pages as always there', () => {
    expect(stillThere({ name: 'settings', page: 'room', roomId: 'r1' }, getState())).toBe(true)
    actions.rooms.remove('r1')
    expect(stillThere({ name: 'settings', page: 'room', roomId: 'r1' }, getState())).toBe(false)
    expect(nearest({ name: 'settings', page: 'room', roomId: 'r1' }, getState())).toEqual({ name: 'home' })
    expect(stillThere({ name: 'settings', page: 'models' }, getState())).toBe(true)
  })
})

describe('tabs are dropped with their workspace', () => {
  it('on archive, on workspaces.set and when the room is removed', () => {
    for (const id of ['lead', 'other', 'r2lead']) actions.ui.openTab(id, id === 'lead' ? 'c2' : id === 'other' ? 'o1' : 'x1')
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    expect(Object.keys(getState().ui.tabs).sort()).toEqual(['lead', 'r2lead'])
    actions.rooms.remove('r2')
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
  it('⌘, reopens the last page, and General when that room page is gone', () => {
    actions.ui.go({ name: 'settings', page: 'room', roomId: 'r2' })
    actions.ui.leaveSettings()
    actions.ui.openSettings()
    expect(route()).toEqual({ name: 'settings', page: 'room', roomId: 'r2' })
    actions.ui.leaveSettings()
    actions.rooms.remove('r2')
    actions.ui.openSettings()
    expect(route()).toEqual({ name: 'settings', page: 'general' })
  })
  it('Back to app lands on the nearest place when the workspace was archived or the room removed meanwhile', () => {
    actions.ui.go(at('other'))
    actions.ui.openSettings()
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    actions.ui.leaveSettings()
    expect(route()).toEqual(at('lead'))
    actions.ui.go(at('r2lead'))
    actions.ui.openSettings()
    actions.rooms.remove('r2')
    actions.ui.leaveSettings()
    expect(route()).toEqual({ name: 'home' })
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
  it('drops the tabs of a workspace that is archived or gone, and opens the room\'s Lead chat', () => {
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    const tabs = { ...lead3, other: { tab: 'o1', files: [], diffs: [] }, vanished: { tab: 'v1', files: [], diffs: [] } }
    expect(restorePlace(saved(at('other'), tabs), getState())).toEqual({ route: at('lead'), tabs: lead3 })
  })
  it('opens Home when the room is gone', () => {
    actions.rooms.remove('r2')
    expect(restorePlace(saved(at('r2lead')), getState())?.route).toEqual({ name: 'home' })
    expect(restorePlace(saved({ name: 'team', roomId: 'r2' }), getState())?.route).toEqual({ name: 'home' })
  })
  it('opens the room\'s Team page for an agent, task, floor or board route', () => {
    for (const route of [{ name: 'agent', roomId: 'r1', agentId: 'kai' }, { name: 'task', roomId: 'r1', taskId: 't1' }, { name: 'floor', roomId: 'r1' }, { name: 'board', roomId: 'r1' }]) {
      expect(restorePlace(saved(route), getState())?.route).toEqual({ name: 'team', roomId: 'r1' })
    }
  })
  it('opens the other screens as they were', () => {
    for (const route of [{ name: 'inbox' }, { name: 'history' }, { name: 'rooms' }, { name: 'issues', issueId: 'KERNEL-9' }, { name: 'team', roomId: 'r1' }]) {
      expect(restorePlace(saved(route), getState())?.route).toEqual(route)
    }
  })
  it('has nothing to restore for no value, bad JSON, an unknown version or a route it will not reopen', () => {
    expect(restorePlace(null, getState())).toBeUndefined()
    expect(restorePlace('{nope', getState())).toBeUndefined()
    expect(restorePlace('null', getState())).toBeUndefined()
    expect(restorePlace(saved(at('lead'), {}, 2), getState())).toBeUndefined()
    expect(restorePlace(JSON.stringify({ route: at('lead'), tabs: {} }), getState())).toBeUndefined()
    for (const route of [{ name: 'settings', page: 'general' }, { name: 'onboarding', step: 'welcome' }, { name: 'devUi', page: 'components' }, { name: 'nope' }, { name: 'workspace' }, { name: 'team' }, 'home', null]) {
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
    expect(placeToSave(getState())).toEqual({ v: 1, route: at('lead'), tabs: { lead: { tab: 'c2', lastChat: 'c2', files: [], diffs: [] } } })
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
  const openTo = (value: 'lastPlace' | 'home' | 'inbox') => setState({ settings: { ...DEFAULT_SETTINGS('/home/cj'), general: { ...DEFAULT_SETTINGS('/home/cj').general, openTo: value } } })

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
    actions.workspaces.upsert(ws('lead', 'r1', { name: 'lead', mode: 'current', agentId: 'rowan', status: 'archived' }))
    actions.workspaces.upsert(ws('lead2', 'r1', { name: 'lead', mode: 'current', agentId: 'rowan' }))
    continueFromChecks()
    expect(route()).toEqual(at('lead2'))
  })
  it('with Inbox opens Inbox, and with Home opens Home', () => {
    openTo('inbox')
    continueFromChecks()
    expect(route()).toEqual({ name: 'inbox' })
    openTo('home')
    continueFromChecks()
    expect(route()).toEqual({ name: 'home' })
  })
  it('keeps a tab that is already open, so asking again after boot changes nothing', () => {
    openTo('lastPlace')
    actions.ui.setTabs('lead', { diffs: ['kept.ts'] })
    launchRoute()
    expect(getState().ui.tabs.lead.diffs).toEqual(['kept.ts'])
  })
  it('without a saved place falls back to the last room, then Home', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'kernel.lastRoom' ? 'r1' : null), setItem: () => undefined, removeItem: () => undefined })
    openTo('lastPlace')
    expect(launchRoute()).toEqual(at('lead'))
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    expect(launchRoute()).toEqual({ name: 'home' })
  })
})

// KERNEL-191 put each room's settings under the room, as a section of the room page. KERNEL-201 must keep them working.
describe('a room Settings page with a section', () => {
  const page: Route = { name: 'settings', page: 'room', roomId: 'r2', section: 'git' }

  it('⌘, reopens it with its section, and Back to app returns to where Settings was opened from', () => {
    actions.ui.go(at('lead'))
    actions.ui.go(page)
    actions.ui.leaveSettings()
    expect(route()).toEqual(at('lead'))
    actions.ui.openSettings()
    expect(route()).toEqual(page)
  })
  it('falls back to General when its room is removed', () => {
    actions.ui.go(page)
    actions.ui.leaveSettings()
    actions.rooms.remove('r2')
    actions.ui.openSettings()
    expect(route()).toEqual({ name: 'settings', page: 'general' })
  })
  it('saves the place it was opened from, never the room page, for the page and for moving between pages', () => {
    actions.ui.go(at('lead'))
    actions.ui.openTab('lead', 'c2')
    actions.ui.go(page)
    expect(placeToSave(getState(), { route: at('lead') })?.route).toEqual(at('lead'))
    actions.ui.go({ ...page, section: 'scripts' } as Route)
    expect(placeToSave(getState(), { route: at('lead') })?.route).toEqual(at('lead'))
    expect(placeToSave(getState(), { route: at('lead') })?.tabs.lead.tab).toBe('c2')
  })
  it('is never restored: a saved room page opens nothing', () => {
    expect(restorePlace(JSON.stringify({ v: 1, route: page, tabs: {} }), getState())).toBeUndefined()
  })
})
