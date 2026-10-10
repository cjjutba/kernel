import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { actions, canBack, canForward, getState, go, resetHistory, setState } from '../src/renderer/src/store'
import { tabOf } from '../src/renderer/src/nav'
import type { AgentDef, Chat, Room, Route, Workspace } from '../src/shared/types'

// KERNEL-200: Back and Forward over the places you visited. The rules are in docs/decisions/KERNEL-200.md.

const room = (id: string): Room => ({ id, name: id, path: `/r/${id}`, defaultBranch: 'main', paused: false, createdAt: 1 }) as Room
const ws = (id: string, roomId: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId, name: id, branch: id, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 0, status: 'ready', ...over }) as Workspace
const chat = (id: string, workspaceId: string, over: Partial<Chat> = {}): Chat => ({ id, workspaceId, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: 1, ...over }) as Chat
const lead = { id: 'rowan', lead: true } as AgentDef

const at = (workspaceId: string): Route => ({ name: 'workspace', workspaceId })
const route = () => getState().ui.route
const tab = () => tabOf(getState(), 'lead')
const back = () => actions.ui.back()
const forward = () => actions.ui.forward()

beforeEach(() => {
  setState({
    rooms: [room('r1'), room('r2')],
    agents: { r1: [lead] },
    workspaces: [ws('lead', 'r1', { name: 'lead', mode: 'current', agentId: 'rowan' }), ws('other', 'r1'), ws('r2lead', 'r2', { name: 'lead', mode: 'current' })],
    chats: { lead: [chat('c1', 'lead'), chat('c2', 'lead'), chat('c3', 'lead')], other: [chat('o1', 'other')], r2lead: [chat('x1', 'r2lead')] }
  })
  setState((s) => ({ ui: { ...s.ui, route: { name: 'home' }, tabs: {}, modal: null } }))
  resetHistory()
})

describe('what is recorded', () => {
  it('pushes the place you leave and goes back to it', () => {
    go({ name: 'inbox' })
    go(at('lead'))
    expect(canBack()).toBe(true)
    back()
    expect(route()).toEqual({ name: 'inbox' })
    back()
    expect(route()).toEqual({ name: 'home' })
    expect(canBack()).toBe(false)
  })
  it('records nothing for the place you are already on', () => {
    go({ name: 'inbox' })
    go({ name: 'inbox' })
    go({ name: 'inbox' })
    back()
    expect(route()).toEqual({ name: 'home' })
    expect(canBack()).toBe(false)
  })
  it('replaces for history: replace, so Back right after launch does nothing', () => {
    go({ name: 'inbox' }, { history: 'replace' })
    expect(canBack()).toBe(false)
    expect(back()).toBe(false)
    expect(route()).toEqual({ name: 'inbox' })
  })
  it('does not record a move to onboarding or devUi, or a move away from onboarding', () => {
    go({ name: 'onboarding', step: 'welcome' })
    go({ name: 'onboarding', step: 'checks' })
    go({ name: 'home' })
    expect(canBack()).toBe(false)
    go({ name: 'devUi', page: 'components' })
    expect(canBack()).toBe(false)
  })
  it('lets one Back leave Settings however many pages were opened', () => {
    go({ name: 'inbox' })
    go({ name: 'settings', page: 'general' })
    go({ name: 'settings', page: 'models' })
    go({ name: 'settings', page: 'hooks' })
    back()
    expect(route()).toEqual({ name: 'inbox' })
    forward()
    expect(route()).toEqual({ name: 'settings', page: 'hooks' })
  })
  it('records history: none moves nothing', () => {
    go({ name: 'inbox' }, { history: 'none' })
    expect(canBack()).toBe(false)
  })
})

describe('chat tabs', () => {
  beforeEach(() => go(at('lead')))

  it('records a change of chat in the workspace on screen', () => {
    actions.ui.openTab('lead', 'c3')
    expect(tab()).toBe('c3')
    back()
    expect(tab()).toBe('c1')
    expect(route()).toEqual(at('lead'))
    forward()
    expect(tab()).toBe('c3')
  })
  it('does not record file, diff, image or text tabs', () => {
    const before = canBack()
    actions.ui.openTab('lead', 'file:a.ts')
    actions.ui.openTab('lead', 'diff:src/a.ts')
    actions.ui.openTab('lead', 'image:1')
    actions.ui.openTab('lead', 'text:1')
    expect(canBack()).toBe(before)
    back()
    expect(route()).toEqual({ name: 'home' })
  })
  it('does not record a tab opened in a workspace that is not on screen', () => {
    actions.ui.openTab('other', 'o1')
    expect(getState().ui.tabs.other?.tab).toBe('o1')
    back()
    expect(route()).toEqual({ name: 'home' })
  })
  it('never makes a file or diff tab a step: leaving one counts as leaving the chat you were last on', () => {
    actions.ui.openTab('lead', 'c2')
    actions.ui.openTab('lead', 'file:a.ts')
    actions.ui.openTab('lead', 'c3')
    back()
    expect(tab()).toBe('c2')
    back()
    expect(tab()).toBe('c1')
    forward()
    forward()
    expect(tab()).toBe('c3')
    actions.ui.openTab('lead', 'diff:src/a.ts')
    actions.ui.openTab('lead', 'c1')
    back()
    expect(tab()).toBe('c3')
  })
  it('records nothing when a file tab goes back to the chat it was opened from', () => {
    actions.ui.openTab('lead', 'c2')
    actions.ui.openTab('lead', 'file:a.ts')
    actions.ui.openTab('lead', 'c2')
    back()
    expect(tab()).toBe('c1')
  })
  it('falls back through tabOf when the chat was closed since', () => {
    actions.ui.openTab('lead', 'c3')
    go({ name: 'inbox' })
    actions.chats.upsert(chat('c1', 'lead', { closed: true }))
    back()
    expect(route()).toEqual(at('lead'))
    expect(tab()).toBe('c3')
    // The entry for c1 now opens c3, where you already are, so it is skipped.
    back()
    expect(route()).toEqual({ name: 'home' })
  })
  it('does not record the fallback chat when the open chat is closed', () => {
    actions.ui.openTab('lead', 'c3')
    go({ name: 'inbox' })
    go(at('lead'))
    actions.chats.upsert(chat('c3', 'lead', { closed: true }))
    // Closing c3 opens its neighbour, as ConfirmCloseChats does. c1 was never visited in between, so Back goes to the Inbox.
    actions.ui.openTab('lead', 'c2')
    back()
    expect(route()).toEqual({ name: 'inbox' })
  })
  it('remembers the chat, not an image or text tab, when you leave one', () => {
    actions.ui.openTab('lead', 'c2')
    actions.ui.openTab('lead', 'image:1')
    actions.ui.openTab('lead', 'c3')
    go({ name: 'inbox' })
    back()
    expect(tab()).toBe('c3')
    back()
    expect(tab()).toBe('c2')
    expect(getState().ui.tabs.lead?.tab).toBe('c2')
  })
  it('does not bring back a file tab that was closed', () => {
    actions.ui.openTab('lead', 'file:a.ts')
    actions.ui.openTab('lead', 'c2')
    actions.ui.setTabs('lead', { files: [] })
    back()
    expect(getState().ui.tabs.lead?.files).toEqual([])
    expect(tab()).toBe('c2')
  })
})

describe('back and forward', () => {
  it('walks Home, Inbox, a workspace and returns', () => {
    go({ name: 'inbox' })
    go(at('other'))
    back()
    back()
    expect(route()).toEqual({ name: 'home' })
    forward()
    forward()
    expect(route()).toEqual(at('other'))
    expect(canForward()).toBe(false)
  })
  it('skips a workspace archived in between', () => {
    go({ name: 'inbox' })
    go(at('other'))
    go({ name: 'history' })
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    back()
    expect(route()).toEqual({ name: 'inbox' })
  })
  it('does nothing and stays put when every entry is dead', () => {
    go(at('other'), { history: 'replace' })
    go({ name: 'inbox' })
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    expect(canBack()).toBe(false)
    expect(back()).toBe(false)
    expect(route()).toEqual({ name: 'inbox' })
  })
  it('skips an entry that is where you already are', () => {
    go(at('other'))
    go({ name: 'inbox' })
    go(at('other'))
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    go({ name: 'history' })
    actions.workspaces.upsert(ws('other', 'r1', { status: 'ready' }))
    go(at('other'))
    back()
    expect(route()).toEqual({ name: 'history' })
  })
  it('clears forward on a new push', () => {
    go({ name: 'inbox' })
    go(at('other'))
    back()
    expect(canForward()).toBe(true)
    go({ name: 'history' })
    expect(canForward()).toBe(false)
    expect(forward()).toBe(false)
  })
  it('keeps forward through Back and Forward themselves', () => {
    go({ name: 'inbox' })
    go({ name: 'history' })
    back()
    back()
    expect(canForward()).toBe(true)
    forward()
    expect(route()).toEqual({ name: 'inbox' })
    expect(canForward()).toBe(true)
  })
  it('closes a modal like any move', () => {
    go({ name: 'inbox' })
    actions.ui.openModal({ name: 'search' })
    back()
    expect(getState().ui.modal).toBeNull()
  })
  it('keeps 50 entries and drops the oldest', () => {
    const rooms = Array.from({ length: 60 }, (_, i) => `rm${i}`)
    setState({ rooms: rooms.map(room) })
    for (const r of rooms) go({ name: 'team', roomId: r })
    let steps = 0
    while (back()) steps++
    expect(steps).toBe(50)
    // Home and rm0 to rm8 fell off, so the oldest place left is rm9.
    expect(route()).toEqual({ name: 'team', roomId: 'rm9' })
  })
})

describe('leaveSettings', () => {
  it('is Back when Settings was opened from the app', () => {
    go({ name: 'inbox' })
    actions.ui.openSettings()
    go({ name: 'settings', page: 'hooks' })
    actions.ui.leaveSettings()
    expect(route()).toEqual({ name: 'inbox' })
    expect(canForward()).toBe(true)
  })
  it('does not leave Settings behind Back when it falls back to where it was opened from', () => {
    go(at('other'))
    actions.ui.openSettings()
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    actions.ui.leaveSettings()
    expect(route()).toEqual(at('lead'))
    back()
    expect(route()).not.toEqual({ name: 'settings', page: 'general' })
  })
  it('still returns to where Settings was opened from when nothing was recorded', () => {
    go(at('lead'), { history: 'replace' })
    actions.ui.openSettings()
    resetHistory()
    actions.ui.leaveSettings()
    expect(route()).toEqual(at('lead'))
  })
})

// KERNEL-201: the place a relaunch reopens, saved in kernel.lastPlace.
describe('the saved place', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
    setState((s) => ({ system: { ...s.system, booted: true } }))
  })
  afterEach(() => {
    setState((s) => ({ system: { ...s.system, booted: false } }))
    vi.unstubAllGlobals()
  })
  const saved = () => JSON.parse(store.get('kernel.lastPlace') ?? 'null')

  it('saves the place you arrive at with the tabs as they are after the move, never the one you left', () => {
    go(at('lead'))
    actions.ui.openTab('lead', 'c3')
    go({ name: 'inbox' })
    expect(saved().route).toEqual({ name: 'inbox' })
    go(at('lead'))
    expect(saved()).toMatchObject({ v: 1, route: at('lead'), tabs: { lead: { tab: 'c3', lastChat: 'c3' } } })
  })
  it('saves a tab change in the workspace on screen and one in another workspace', () => {
    go(at('lead'))
    actions.ui.openTab('lead', 'file:a.ts')
    expect(saved().tabs.lead).toMatchObject({ tab: 'file:a.ts', files: ['a.ts'] })
    actions.ui.openTab('other', 'o1')
    expect(saved()).toMatchObject({ route: at('lead'), tabs: { other: { tab: 'o1' } } })
  })
  it('saves on Back and Forward, which record no history', () => {
    go(at('lead'))
    actions.ui.openTab('lead', 'c2')
    go({ name: 'inbox' })
    back()
    expect(saved()).toMatchObject({ route: at('lead'), tabs: { lead: { tab: 'c2' } } })
    go({ name: 'rooms' })
    go({ name: 'home' })
    back()
    expect(saved().route).toEqual({ name: 'rooms' })
    forward()
    expect(saved().route).toEqual({ name: 'home' })
  })
  it('saves a closed file or diff tab, which is not a move', () => {
    go(at('lead'))
    actions.ui.openTab('lead', 'diff:src/a.ts')
    actions.ui.openTab('lead', 'file:a.ts')
    actions.ui.setTabs('lead', { files: [], tab: 'c1' })
    expect(saved().tabs.lead).toMatchObject({ files: [], diffs: ['src/a.ts'], tab: 'c1' })
    actions.ui.setTabs('lead', { diffs: [] })
    expect(saved().tabs.lead.diffs).toEqual([])
  })
  it('saves the tabs left when a workspace is archived or its room removed', () => {
    for (const id of ['lead', 'other', 'r2lead']) actions.ui.openTab(id, `file:${id}.ts`)
    go(at('lead'))
    actions.workspaces.upsert(ws('other', 'r1', { status: 'archived' }))
    expect(Object.keys(saved().tabs).sort()).toEqual(['lead', 'r2lead'])
    actions.rooms.remove('r2')
    expect(Object.keys(saved().tabs)).toEqual(['lead'])
  })
  it('saves the place Settings was opened from, never Settings', () => {
    go(at('lead'))
    actions.ui.openTab('lead', 'c2')
    actions.ui.openSettings()
    expect(saved()).toMatchObject({ route: at('lead'), tabs: { lead: { tab: 'c2' } } })
    go({ name: 'settings', page: 'models' })
    expect(saved().route).toEqual(at('lead'))
    actions.ui.openTab('lead', 'file:a.ts')
    expect(saved().route).toEqual(at('lead'))
  })
  it('saves an image or text tab as the chat you were last on', () => {
    go(at('lead'))
    actions.ui.openTab('lead', 'c2')
    actions.ui.openTab('lead', 'image:1')
    expect(saved().tabs.lead).toMatchObject({ tab: 'c2', lastChat: 'c2' })
  })
  it('never saves onboarding or the dev pages, and leaves the last place alone', () => {
    go(at('lead'))
    go({ name: 'onboarding', step: 'welcome' })
    go({ name: 'devUi', page: 'components' })
    expect(saved().route).toEqual(at('lead'))
  })
  it('saves nothing before the app has booted', () => {
    setState((s) => ({ system: { ...s.system, booted: false } }))
    go(at('lead'))
    actions.ui.openTab('lead', 'c3')
    expect(store.has('kernel.lastPlace')).toBe(false)
  })
  it('works when localStorage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(() => go(at('lead'))).not.toThrow()
  })
})
