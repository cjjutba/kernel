import { describe, expect, it } from 'vitest'
import { mergeChatList, slotKey, slotsFor, sidebarRows } from '../src/renderer/src/components/sidebar/slots'
import type { AgentDef, Chat, Room, Workspace } from '../src/shared/types'

const room: Room = { id: 'a', name: 'Client A', path: '/p/a', defaultBranch: 'main', paused: false, createdAt: 0 }
const rowan: AgentDef = { id: 'rowan', name: 'Rowan', role: 'Lead', description: 'Lead.', model: 'opus', lead: true, prompt: '', file: '.claude/agents/rowan.md' }
const kai: AgentDef = { ...rowan, id: 'kai', name: 'Kai', role: 'Frontend', lead: false }
const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, roomId: 'a', name: id, branch: `feat/${id}`, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'none', createdAt: 1, ...over })
const home = ws('home', { name: 'lead', agentId: 'rowan', mode: 'current' })
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({ id, workspaceId: 'home', title: id, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1, ...over })
const agents = { a: [rowan, kai] }
const keys = (rows: ReturnType<typeof sidebarRows>) => rows.map(slotKey)

describe('sidebar rows', () => {
  it('lists each open chat followed by its workspaces, then the workspaces nobody owns', () => {
    const workspaces = [home, ws('w1', { leadChatId: 'c2' }), ws('loose'), ws('w2', { leadChatId: 'c1' }), ws('w3', { leadChatId: 'c2' })]
    const rows = sidebarRows(room, agents, workspaces, { home: [chat('c1'), chat('c2'), chat('c3')] })
    expect(keys(rows)).toEqual(['chat:c1', 'workspace:w2', 'chat:c2', 'workspace:w1', 'workspace:w3', 'chat:c3', 'workspace:loose'])
    expect(rows.filter((r) => r.kind === 'workspace').map((r) => r.kind === 'workspace' && r.nested)).toEqual([true, true, true, false])
  })

  it('leaves out closed chats and terminals, and moves their workspaces to the unowned rows', () => {
    const workspaces = [home, ws('w1', { leadChatId: 'gone' }), ws('w2', { leadChatId: 'term' })]
    const rows = sidebarRows(room, agents, workspaces, { home: [chat('c1'), chat('gone', { closed: true }), chat('term', { kind: 'terminal' })] })
    expect(keys(rows)).toEqual(['chat:c1', 'workspace:w1', 'workspace:w2'])
  })

  it('keeps the Lead row while the Lead has no open chat, and lists only workspaces when the room has no Lead', () => {
    expect(keys(sidebarRows(room, agents, [ws('w1')], {}))).toEqual(['lead', 'workspace:w1'])
    expect(keys(sidebarRows(room, agents, [home, ws('w1')], { home: [chat('c1', { closed: true })] }))).toEqual(['lead', 'workspace:w1'])
    expect(keys(sidebarRows(room, { a: [kai] }, [ws('w1')], {}))).toEqual(['workspace:w1'])
  })

  it('does not list archived workspaces or another room\'s', () => {
    const rows = sidebarRows(room, agents, [home, ws('old', { status: 'archived' }), ws('other', { roomId: 'b' })], { home: [chat('c1')] })
    expect(keys(rows)).toEqual(['chat:c1'])
  })

  it('numbers the same rows top to bottom and stops at nine', () => {
    const many = Array.from({ length: 12 }, (_, i) => ws(`w${i}`, { leadChatId: i < 6 ? 'c1' : undefined }))
    const chats = { home: [chat('c1'), chat('c2')] }
    expect(keys(slotsFor(room, agents, [home, ...many], chats))).toEqual([
      'chat:c1', 'workspace:w0', 'workspace:w1', 'workspace:w2', 'workspace:w3', 'workspace:w4', 'workspace:w5', 'chat:c2', 'workspace:w6'
    ])
    // A room with only the Lead row numbers it first.
    expect(keys(slotsFor(room, agents, [], {}))).toEqual(['lead'])
  })

  it('draws a workspace as unowned when its chat is archived with it or no chat is open', () => {
    const rows = sidebarRows(room, agents, [home, ws('w1', { leadChatId: 'c1', status: 'archived' }), ws('w2', { leadChatId: 'c1' })], { home: [chat('c1')] })
    expect(keys(rows)).toEqual(['chat:c1', 'workspace:w2'])
    const noChat = sidebarRows(room, agents, [ws('w3', { leadChatId: 'c1' })], {})
    expect(noChat.map((r) => r.kind === 'workspace' && r.nested)).toEqual([false, false])
  })
})

describe('folded chats', () => {
  const workspaces = [home, ws('w1', { leadChatId: 'c1' }), ws('w2', { leadChatId: 'c1' }), ws('loose'), ws('w3', { leadChatId: 'c2' })]
  const lists = { home: [chat('c1'), chat('c2'), chat('c3')] }

  it('hides the workspaces of a folded chat, and the chat carries them with its folded flag', () => {
    const rows = sidebarRows(room, agents, workspaces, lists, ['c1'])
    expect(keys(rows)).toEqual(['chat:c1', 'chat:c2', 'workspace:w3', 'chat:c3', 'workspace:loose'])
    const c1 = rows[0]
    expect(c1.kind === 'chat' && { folded: c1.folded, owned: c1.owned.map((w) => w.id) }).toEqual({ folded: true, owned: ['w1', 'w2'] })
    const c2 = rows[1]
    expect(c2.kind === 'chat' && { folded: c2.folded, owned: c2.owned.map((w) => w.id) }).toEqual({ folded: false, owned: ['w3'] })
  })

  it('still reports the owned workspaces of a chat that is not folded', () => {
    const rows = sidebarRows(room, agents, workspaces, lists)
    const c1 = rows[0]
    expect(c1.kind === 'chat' && c1.owned.map((w) => w.id)).toEqual(['w1', 'w2'])
    expect(keys(rows)).toEqual(['chat:c1', 'workspace:w1', 'workspace:w2', 'chat:c2', 'workspace:w3', 'chat:c3', 'workspace:loose'])
  })

  it('lists a folded chat with no workspaces like an unfolded one', () => {
    const rows = sidebarRows(room, agents, workspaces, lists, ['c3'])
    expect(keys(rows)).toEqual(keys(sidebarRows(room, agents, workspaces, lists)))
    const c3 = rows.find((r) => r.kind === 'chat' && r.chat.id === 'c3')
    expect(c3?.kind === 'chat' && { folded: c3.folded, owned: c3.owned }).toEqual({ folded: false, owned: [] })
  })

  it('leaves unowned workspaces alone, and ignores ids that are not open chats', () => {
    const rows = sidebarRows(room, agents, workspaces, lists, ['c1', 'c2', 'gone'])
    expect(keys(rows)).toEqual(['chat:c1', 'chat:c2', 'chat:c3', 'workspace:loose'])
    expect(rows.filter((r) => r.kind === 'workspace').map((r) => r.kind === 'workspace' && r.nested)).toEqual([false])
  })

  it('numbers only the rows you can see, so the chat after a folded one takes the next number', () => {
    expect(slotsFor(room, agents, workspaces, lists, ['c1']).map(slotKey)).toEqual(['chat:c1', 'chat:c2', 'workspace:w3', 'chat:c3', 'workspace:loose'])
    expect(slotsFor(room, agents, workspaces, lists).map(slotKey).slice(0, 3)).toEqual(['chat:c1', 'workspace:w1', 'workspace:w2'])
  })
})

describe('chat lists that arrive while a push already made one', () => {
  it('holds the Lead row back until the Lead\'s list has loaded', () => {
    expect(keys(sidebarRows(room, agents, [home, ws('w1')], {}))).toEqual(['workspace:w1'])
    expect(keys(sidebarRows(room, agents, [home, ws('w1')], { home: [] }))).toEqual(['lead', 'workspace:w1'])
  })

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
