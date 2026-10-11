import { describe, expect, it } from 'vitest'
import { mergeChatList, slotKey, slotsFor, sidebarRows, threadTab } from '../src/renderer/src/components/sidebar/slots'
import type { AgentDef, Chat, Room, Thread, Workspace } from '../src/shared/types'

const room: Room = { id: 'a', name: 'Client A', path: '/p/a', defaultBranch: 'main', paused: false, createdAt: 0 }
const rowan: AgentDef = { id: 'rowan', name: 'Rowan', role: 'Lead', description: 'Lead.', model: 'opus', lead: true, prompt: '', file: '.claude/agents/rowan.md' }
const kai: AgentDef = { ...rowan, id: 'kai', name: 'Kai', role: 'Frontend', lead: false }
const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, roomId: 'a', name: id, branch: `feat/${id}`, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'none', createdAt: 1, ...over })
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({ id, workspaceId: 'home', title: id, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1, ...over })
const thread = (id: string, over: Partial<Thread> = {}): Thread => ({ id, roomId: 'a', title: id, createdAt: 1, ...over })
const threadsOf = (...list: Thread[]) => Object.fromEntries(list.map((t) => [t.id, t]))
/** A chat with Rowan's own workspace for the thread `t`, and its tabs (KERNEL-405). */
const own = (t: string, over: Partial<Workspace> = {}) => ws(`ws-${t}`, { name: t, branch: `rowan/${t}`, agentId: 'rowan', lead: true, threadId: t, ...over })
const tabsOf = (t: string, ...list: Chat[]) => ({ [`ws-${t}`]: list.length ? list : [chat(`${t}-tab`, { workspaceId: `ws-${t}`, threadId: t })] })
const agents = { a: [rowan, kai] }
const keys = (rows: ReturnType<typeof sidebarRows>) => rows.map(slotKey)

describe('sidebar rows (KERNEL-405)', () => {
  it('lists each open chat with Rowan, oldest first, followed by the workspaces it handed off, then the workspaces nobody owns', () => {
    const workspaces = [own('t2'), ws('w1', { threadId: 't2' }), ws('loose'), own('t1'), ws('w2', { threadId: 't1' }), ws('w3', { threadId: 't2' }), own('t3')]
    const threads = threadsOf(thread('t1', { createdAt: 1 }), thread('t2', { createdAt: 2 }), thread('t3', { createdAt: 3 }))
    const rows = sidebarRows(room, agents, workspaces, { ...tabsOf('t1'), ...tabsOf('t2'), ...tabsOf('t3') }, threads)
    expect(keys(rows)).toEqual(['chat:t1', 'workspace:w2', 'chat:t2', 'workspace:w1', 'workspace:w3', 'chat:t3', 'workspace:loose'])
    expect(rows.filter((r) => r.kind === 'workspace').map((r) => r.kind === 'workspace' && r.nested)).toEqual([true, true, true, false])
    const first = rows[0]
    expect(first.kind === 'chat' && first.ws?.id).toBe('ws-t1')
  })

  it("shows a chat's open chat tabs, not its terminals or closed tabs, and lists the chat before its list loads", () => {
    const tabs = tabsOf('t1', chat('a1', { workspaceId: 'ws-t1', threadId: 't1' }), chat('a2', { workspaceId: 'ws-t1', threadId: 't1', closed: true }), chat('term', { workspaceId: 'ws-t1', kind: 'terminal' }))
    const rows = sidebarRows(room, agents, [own('t1'), own('t2')], tabs, threadsOf(thread('t1'), thread('t2', { title: 'Plan wave 3' })))
    expect(rows.map((r) => r.kind === 'chat' && { id: r.thread.id, tabs: r.tabs.map((c) => c.id), title: r.thread.title })).toEqual([
      { id: 't1', tabs: ['a1'], title: 't1' },
      { id: 't2', tabs: [], title: 'Plan wave 3' }
    ])
  })

  it("titles a row by its first tab while the thread hasn't reached the store, else by its workspace", () => {
    const rows = sidebarRows(room, agents, [own('t1'), own('t2', { title: 'Look at the flaky test' })], tabsOf('t1', chat('a1', { workspaceId: 'ws-t1', threadId: 't1', title: 'Tab one' })))
    expect(rows.map((r) => r.kind === 'chat' && r.thread.title)).toEqual(['Tab one', 'Look at the flaky test'])
  })

  it('keeps the Lead row while no chat is open, and lists only workspaces when the room has no Lead', () => {
    expect(keys(sidebarRows(room, agents, [ws('w1')], {}))).toEqual(['lead', 'workspace:w1'])
    expect(keys(sidebarRows(room, agents, [own('t1', { status: 'archived' }), ws('w1', { threadId: 't1' })], {}))).toEqual(['lead', 'workspace:w1'])
    expect(keys(sidebarRows(room, { a: [kai] }, [ws('w1')], {}))).toEqual(['workspace:w1'])
  })

  it("never lists the shared Lead workspace from before, or archived workspaces, or another room's", () => {
    const shared = ws('home', { name: 'lead', agentId: 'rowan', mode: 'current', lead: true })
    const rows = sidebarRows(room, agents, [shared, own('t1'), ws('old', { status: 'archived' }), ws('other', { roomId: 'b' })], tabsOf('t1'))
    expect(keys(rows)).toEqual(['chat:t1'])
  })

  it('draws the workspaces of an archived chat at room level', () => {
    const workspaces = [own('t1', { status: 'archived' }), own('t2'), ws('w1', { threadId: 't1' }), ws('w2', { threadId: 't2' })]
    const rows = sidebarRows(room, agents, workspaces, tabsOf('t2'), threadsOf(thread('t1', { closedAt: 5 }), thread('t2')))
    expect(keys(rows)).toEqual(['chat:t2', 'workspace:w2', 'workspace:w1'])
    expect(rows.filter((r) => r.kind === 'workspace').map((r) => r.kind === 'workspace' && r.nested)).toEqual([true, false])
  })

  it('numbers only the chats, in sidebar order, nine of ten, whatever workspaces sit between them', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `t${i}`)
    const workspaces = [...ten.map((t) => own(t)), ws('w1', { threadId: 't0' }), ws('loose')]
    const threads = threadsOf(...ten.map((t, i) => thread(t, { createdAt: i })))
    expect(keys(slotsFor(room, agents, workspaces, {}, threads))).toEqual(ten.slice(0, 9).map((t) => `chat:${t}`))
  })

  it('numbers the Lead row when no chat is open, and nothing when the room has no Lead', () => {
    expect(keys(slotsFor(room, agents, [], {}))).toEqual(['lead'])
    expect(slotsFor(room, { a: [kai] }, [ws('w1')], {})).toEqual([])
  })

  it('opens a chat on the tab last shown in it, else its first tab', () => {
    const tabs = [chat('a1'), chat('a2'), chat('a3')]
    expect(threadTab(tabs, { t1: 'a2' }, 't1')?.id).toBe('a2')
    expect(threadTab(tabs, { t1: 'gone' }, 't1')?.id).toBe('a1')
    expect(threadTab(tabs, {}, 't1')?.id).toBe('a1')
    expect(threadTab([], {}, 't1')).toBeUndefined()
  })
})

describe('folded chats', () => {
  const workspaces = [own('t1'), own('t2'), own('t3'), ws('w1', { threadId: 't1' }), ws('w2', { threadId: 't1' }), ws('loose'), ws('w3', { threadId: 't2' })]
  const threads = threadsOf(thread('t1', { createdAt: 1 }), thread('t2', { createdAt: 2 }), thread('t3', { createdAt: 3 }))
  const lists = { ...tabsOf('t1'), ...tabsOf('t2'), ...tabsOf('t3') }

  it('hides the workspaces of a folded chat, and the chat carries them with its folded flag', () => {
    const rows = sidebarRows(room, agents, workspaces, lists, threads, ['t1'])
    expect(keys(rows)).toEqual(['chat:t1', 'chat:t2', 'workspace:w3', 'chat:t3', 'workspace:loose'])
    const t1 = rows[0]
    expect(t1.kind === 'chat' && { folded: t1.folded, owned: t1.owned.map((w) => w.id) }).toEqual({ folded: true, owned: ['w1', 'w2'] })
  })

  it('keeps a fold saved under a tab id, and lists a folded chat with no workspaces like an unfolded one', () => {
    expect(keys(sidebarRows(room, agents, workspaces, lists, threads, ['t1-tab']))).toEqual(['chat:t1', 'chat:t2', 'workspace:w3', 'chat:t3', 'workspace:loose'])
    expect(keys(sidebarRows(room, agents, workspaces, lists, threads, ['t3']))).toEqual(keys(sidebarRows(room, agents, workspaces, lists, threads)))
  })

  it('keeps every number when a chat is folded', () => {
    expect(keys(slotsFor(room, agents, workspaces, lists, threads))).toEqual(['chat:t1', 'chat:t2', 'chat:t3'])
  })
})

describe('chat lists that arrive while a push already made one', () => {
  it('returns the fetched list when nothing was pushed', () => {
    const fetched = [chat('c1'), chat('c2')]
    expect(mergeChatList(fetched, undefined)).toBe(fetched)
    expect(mergeChatList(fetched, [])).toBe(fetched)
  })

  it('keeps every fetched chat when a push made a one-chat list first', () => {
    expect(mergeChatList([chat('c1'), chat('c2'), chat('c3')], [chat('c2')]).map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('lets a pushed chat win over its fetched copy, and keeps a chat only the push knows', () => {
    const merged = mergeChatList([chat('c1', { title: 'old' }), chat('c2')], [chat('c1', { title: 'renamed' }), chat('c9')])
    expect(merged.map((c) => [c.id, c.title])).toEqual([['c1', 'renamed'], ['c2', 'c2'], ['c9', 'c9']])
  })
})
