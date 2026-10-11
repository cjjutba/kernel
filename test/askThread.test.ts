import { beforeEach, describe, expect, it } from 'vitest'
import { actions, getState, setState } from '../src/renderer/src/store'
import { askThreadOf } from '../src/renderer/src/components/footer/askThread'
import type { AgentDef, Chat, Room, Thread, Workspace } from '../src/shared/types'

const room: Room = { id: 'r1', name: 'Client A', path: '/r/r1', defaultBranch: 'main', paused: false, createdAt: 1 }
const rowan = { id: 'rowan', lead: true } as AgentDef
const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId: 'r1', name: id, branch: id, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 0, status: 'ready', ...over }) as Workspace
const chat = (id: string, threadId: string): Chat => ({ id, workspaceId: 'lead', title: id, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, threadId, createdAt: 1 })
const thread = (id: string, over: Partial<Thread> = {}): Thread => ({ id, roomId: 'r1', title: id, createdAt: 1, ...over })
const at = (route: { name: 'workspace'; workspaceId: string } | { name: 'home' } | { name: 'inbox' }) => setState((s) => ({ ui: { ...s.ui, route } }))

beforeEach(() => {
  setState({
    rooms: [room], agents: { r1: [rowan] },
    workspaces: [ws('lead', { name: 'lead', mode: 'current', agentId: 'rowan' }), ws('under-t2', { threadId: 't2' }), ws('under-tab', { leadChatId: 'c1' }), ws('loose'), ws('under-closed', { threadId: 't3' })],
    chats: { lead: [chat('c1', 't1'), chat('c2', 't2')] },
    threads: { t1: thread('t1'), t2: thread('t2'), t3: thread('t3', { closedAt: 5 }) }
  })
  setState((s) => ({ ui: { ...s.ui, route: { name: 'home' }, tabs: {} } }))
})

describe('the chat Ask Rowan joins (KERNEL-339)', () => {
  it('is the chat the Lead\'s workspace shows', () => {
    at({ name: 'workspace', workspaceId: 'lead' })
    actions.ui.openTab('lead', 'c2')
    expect(askThreadOf(getState())).toBe('t2')
    actions.ui.openTab('lead', 'c1')
    expect(askThreadOf(getState())).toBe('t1')
  })

  it('is the chat that started the workspace you are in, named by its thread or by the tab that handed it off', () => {
    at({ name: 'workspace', workspaceId: 'under-t2' })
    expect(askThreadOf(getState())).toBe('t2')
    at({ name: 'workspace', workspaceId: 'under-tab' })
    expect(askThreadOf(getState())).toBe('t1')
  })

  it('is none from Home, the Inbox, a workspace no chat started, or a chat that has closed, so the answer opens as a new chat', () => {
    expect(askThreadOf(getState())).toBeUndefined()
    at({ name: 'inbox' })
    expect(askThreadOf(getState())).toBeUndefined()
    at({ name: 'workspace', workspaceId: 'loose' })
    expect(askThreadOf(getState())).toBeUndefined()
    at({ name: 'workspace', workspaceId: 'under-closed' })
    expect(askThreadOf(getState())).toBeUndefined()
  })
})
