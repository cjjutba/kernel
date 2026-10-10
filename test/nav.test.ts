import { beforeEach, describe, expect, it } from 'vitest'
import { actions, getState, setState } from '../src/renderer/src/store'
import { nearest, stillThere, tabOf } from '../src/renderer/src/nav'
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
    actions.ui.go({ name: 'settings', page: 'agents' })
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
