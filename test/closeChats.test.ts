import { beforeEach, describe, expect, it, vi } from 'vitest'
import { actions, getState, resetHistory, setState } from '../src/renderer/src/store'
import { tabOf } from '../src/renderer/src/nav'
import type { AgentDef, Chat, Room, Workspace } from '../src/shared/types'

// What the main process answers: the Lead's workspace's chats, which `chats.close` shrinks. `chats.list` returns the open ones.
let server: Chat[] = []
vi.mock('../src/renderer/src/api', () => ({
  cleanError: (e: unknown) => String(e),
  onPush: () => () => undefined,
  call: async (channel: string, req: { chatId?: string }) => {
    if (channel === 'chats.close') { server = server.map((c) => (c.id === req.chatId ? { ...c, closed: true } : c)); return { ok: true } }
    if (channel === 'chats.list') return server.filter((c) => !c.closed)
    return []
  }
}))

const { closeChats, closesThread, frozenWhole, wholeChat } = await import('../src/renderer/src/screens/workspace/ConfirmCloseChats')

const room = { id: 'r1', name: 'r1', path: '/r/r1', defaultBranch: 'main', paused: false, createdAt: 1 } as Room
const rowan = { id: 'rowan', lead: true } as AgentDef
const lead = { id: 'lead', roomId: 'r1', name: 'lead', branch: 'main', baseRef: 'main', path: '/w/lead', mode: 'current', lead: true, agentId: 'rowan', port: 0, status: 'ready', prState: 'none', createdAt: 1 } as Workspace
const tab = (id: string, threadId: string, over: Partial<Chat> = {}): Chat =>
  ({ id, workspaceId: 'lead', title: id, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1, threadId, ...over })

/** Three Lead chats: t1 with two tabs, t2 and t3 with one each. */
function seed(chats = [tab('a1', 't1'), tab('a2', 't1'), tab('b1', 't2'), tab('c1', 't3')]) {
  server = chats
  setState({ rooms: [room], agents: { r1: [rowan] }, workspaces: [lead], chats: { lead: chats }, threads: {} })
  setState((s) => ({ ui: { ...s.ui, route: { name: 'home' }, tabs: {}, foldedChats: [] } }))
  resetHistory()
}
const route = () => getState().ui.route
const select = vi.fn()

beforeEach(() => { select.mockClear(); seed() })

describe('closesThread', () => {
  it('names the chat when the tabs are all of its open tabs, and nothing when another tab stays', () => {
    expect(closesThread(getState(), 'lead', ['a1'])).toBeUndefined()
    expect(closesThread(getState(), 'lead', ['a1', 'a2'])?.id).toBe('t1')
    expect(closesThread(getState(), 'lead', ['b1'])?.id).toBe('t2')
  })

  it('counts only open tabs, so the last open tab of a chat closes it', () => {
    seed([tab('a1', 't1'), tab('a2', 't1', { closed: true })])
    expect(closesThread(getState(), 'lead', ['a1'])?.id).toBe('t1')
  })

  it('has no chat to close outside the Lead\'s workspace, or for a terminal', () => {
    setState({ workspaces: [{ ...lead, agentId: 'kai' }] })
    expect(closesThread(getState(), 'lead', ['b1'])).toBeUndefined()
    seed([tab('a1', 't1'), tab('term', 't1', { kind: 'terminal' })])
    expect(closesThread(getState(), 'lead', ['term'])).toBeUndefined()
  })
})

describe('the Close this chat dialog (KERNEL-362)', () => {
  it('has a chat to name once the Lead\'s chats load, if it opened before', () => {
    setState({ chats: {}, agents: {} })
    expect(wholeChat(getState(), 'lead', ['b1'])).toBeUndefined()
    setState({ chats: { lead: server }, agents: { r1: [rowan] } })
    expect(wholeChat(getState(), 'lead', ['b1'])).toMatchObject({ id: 't2', title: 'b1', started: 0 })
  })

  it('keeps the chat it first found while Close chat is busy and after the tab closes', async () => {
    let kept = frozenWhole(undefined, wholeChat(getState(), 'lead', ['b1']))
    expect(kept?.id).toBe('t2')
    actions.ui.go({ name: 'workspace', workspaceId: 'lead' })
    await closeChats('lead', ['b1'], 'b1', select)
    expect(wholeChat(getState(), 'lead', ['b1'])).toBeUndefined()
    kept = frozenWhole(kept, wholeChat(getState(), 'lead', ['b1']))
    expect(kept?.id).toBe('t2')
  })

  it('is not made by a dialog for tabs that leave another tab of their chat open', () => {
    expect(frozenWhole(undefined, wholeChat(getState(), 'lead', ['a1']))).toBeUndefined()
  })
})

describe('closeChats in the Lead\'s workspace (KERNEL-338)', () => {
  const closeLast = async (id: string) => {
    actions.ui.go({ name: 'workspace', workspaceId: 'lead' })
    actions.ui.openTab('lead', id)
    await closeChats('lead', [id], id, select)
  }

  it('opens the chat row above when a chat closes', async () => {
    await closeLast('b1')
    expect(tabOf(getState(), 'lead')).toBe('a1')
  })

  it('opens the chat row below when the first chat closes', async () => {
    await closeLast('a1')
    await closeChats('lead', ['a2'], 'a2', select)
    expect(tabOf(getState(), 'lead')).toBe('b1')
  })

  it('opens New chat with Rowan when no chat is left, since the shared Lead workspace hosts none (KERNEL-405)', async () => {
    seed([tab('only', 't1')])
    actions.ui.go({ name: 'workspace', workspaceId: 'elsewhere' })
    await closeChats('lead', ['only'], 'only', select)
    expect(route()).toEqual({ name: 'leadNew', roomId: 'r1' })
  })

  it('picks the next tab of the same chat when a tab that is not the last closes', async () => {
    seed([tab('a1', 't1'), tab('b1', 't2'), tab('a2', 't1')])
    actions.ui.go({ name: 'workspace', workspaceId: 'lead' })
    await closeChats('lead', ['a1'], 'a1', select)
    expect(select).toHaveBeenCalledWith('a2')
  })
})
