import { describe, expect, it } from 'vitest'
import type { Approval, Chat, Workspace } from '../src/shared/types'
import { handedOff, handedWord, type HandedInput } from '../src/renderer/src/screens/workspace/handedOff'
import { hasOwnWork, sessionView } from '../src/renderer/src/screens/workspace/sessionStages'

// The Session rail of a chat with Kernel: the rows of what it handed off and their order, the stage word of each, and when the chat's own stages show.

const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, projectId: 'p', name: id, branch: `feat/${id}`, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1, ...over }) as Workspace
const chat = (id: string, workspaceId: string, over: Partial<Chat> = {}): Chat => ({ id, workspaceId, title: id, kind: 'chat', model: 'm', effort: 'high', plan: false, createdAt: 1, ...over }) as Chat
const ask = (workspaceId: string, status: Approval['status'] = 'pending'): Approval => ({ id: `ap-${workspaceId}`, kind: 'question', source: 'sdk', workspaceId, status, createdAt: 1, title: 'Which one?' }) as Approval

const lead = ws('lead', { lead: true, threadId: 't1', agentId: 'kernel-lead' })
const handed = (id: string, over: Partial<Workspace> = {}) => ws(id, { threadId: 't1', leadChatId: 'c1', ...over })
const input = (workspaces: Workspace[], over: Partial<HandedInput> = {}): HandedInput => ({ workspaces, chats: { lead: [chat('c1', 'lead', { threadId: 't1' })] }, running: {}, approvals: [], ...over })
const ids = (rows: { ws: Workspace }[]) => rows.map((r) => r.ws.id)

describe('the workspaces a chat handed off', () => {
  it('lists the teammates this chat created and nothing else', () => {
    const rows = handedOff(input([
      lead,
      handed('mine'),
      handed('other-thread', { threadId: 't2', leadChatId: 'c2' }),
      handed('old-record', { threadId: undefined }),
      handed('review', { reviewOf: 'mine' }),
      handed('elsewhere', { projectId: 'q' }),
      ws('own-work')
    ]), lead, 't1')
    expect(ids(rows)).toEqual(['mine', 'old-record'])
  })

  it('keeps a merged workspace after it is archived and drops one archived without merging', () => {
    const rows = handedOff(input([handed('merged', { status: 'archived', prState: 'merged' }), handed('discarded', { status: 'archived' })]), lead, 't1')
    expect(rows.map((r) => [r.ws.id, r.word])).toEqual([['merged', 'Merged']])
  })

  it('puts the ones waiting on you first, then the newest', () => {
    const workspaces = [lead, handed('old', { createdAt: 10 }), handed('new', { createdAt: 30 }), handed('asks', { createdAt: 5 }), handed('answered', { createdAt: 20 })]
    const rows = handedOff(input(workspaces, {
      chats: { lead: [chat('c1', 'lead', { threadId: 't1' })], asks: [chat('ca', 'asks')] },
      approvals: [ask('asks'), ask('answered', 'answered')]
    }), lead, 't1')
    expect(ids(rows)).toEqual(['asks', 'new', 'answered', 'old'])
    expect(rows[0]).toMatchObject({ word: 'Waiting on you', needs: true })
    expect(rows.slice(1).every((r) => !r.needs)).toBe(true)
  })

  it('reads a running turn from the teammate\'s own chats', () => {
    const rows = handedOff(input([lead, handed('busy'), handed('idle')], { chats: { lead: [chat('c1', 'lead', { threadId: 't1' })], busy: [chat('cb', 'busy')] }, running: { cb: true } }), lead, 't1')
    expect(Object.fromEntries(rows.map((r) => [r.ws.id, r.word]))).toEqual({ busy: 'Building', idle: 'Idle' })
  })

  it('finds a teammate by the chat that made it when an older record has no thread', () => {
    const rows = handedOff(input([lead, handed('legacy', { threadId: undefined, leadChatId: 'c1' }), handed('stranger', { threadId: undefined, leadChatId: 'zz' })]), lead, 't1')
    expect(ids(rows)).toEqual(['legacy'])
  })
})

describe('the stage word of a handed-off workspace', () => {
  const word = (over: Partial<Workspace>, running = false, waiting = false) => handedWord(ws('w', over), running, waiting)
  it('follows the same facts as the stages', () => {
    expect(word({ status: 'failed' })).toBe('Failed')
    expect(word({ prState: 'merged' }, true, true)).toBe('Merged')
    expect(word({}, true, true)).toBe('Waiting on you')
    expect(word({ prState: 'closed', prNumber: 4 })).toBe('Closed')
    expect(word({ status: 'setup' }, true)).toBe('Setting up')
    expect(word({ prState: 'open', prNumber: 4 }, true)).toBe('In review')
    expect(word({}, true)).toBe('Building')
    expect(word({ stat: { files: 2, added: 3, removed: 1 } })).toBe('Built')
    expect(word({})).toBe('Idle')
  })
})

describe('the chat\'s own stages', () => {
  it('show only once the chat has work of its own', () => {
    expect(hasOwnWork(ws('a'))).toBe(false)
    expect(hasOwnWork(ws('a', { stat: { files: 0, added: 0, removed: 0 } }))).toBe(false)
    expect(hasOwnWork(ws('a', { stat: { files: 1, added: 2, removed: 0 } }))).toBe(true)
    expect(hasOwnWork(ws('a', { prState: 'creating' }))).toBe(true)
    expect(hasOwnWork(ws('a', { prState: 'open', prNumber: 3 }))).toBe(true)
  })

  it('open with a stage started by the user\'s message, and skip Set up on the shared folder', () => {
    const mine = sessionView({ ws: lead, running: false, lead: true }).stages
    expect(mine[0]).toMatchObject({ id: 'briefed', label: 'Started', sub: 'Started by your message' })
    expect(mine.map((s) => s.id)).toContain('setup')
    const shared = sessionView({ ws: { ...lead, shared: true }, running: false, lead: true }).stages
    expect(shared.map((s) => s.id)).not.toContain('setup')
    expect(sessionView({ ws: lead, running: false }).stages[0].label).toBe('Briefed')
  })
})
