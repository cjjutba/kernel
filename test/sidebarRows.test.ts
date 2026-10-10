import { describe, expect, it } from 'vitest'
import { slotKey, slotsFor, sidebarRows } from '../src/renderer/src/components/sidebar/slots'
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
    expect(keys(slotsFor(room, agents, [home, ...many], chats))).toEqual(keys(sidebarRows(room, agents, [home, ...many], chats)).slice(0, 9))
    expect(slotsFor(room, agents, [home, ...many], chats)).toHaveLength(9)
    // A room with only the Lead row numbers it first.
    expect(keys(slotsFor(room, agents, [], {}))).toEqual(['lead'])
  })
})
