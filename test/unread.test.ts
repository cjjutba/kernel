import { describe, expect, it } from 'vitest'
import { chatUnread, isUnread, roomUnread, workspaceRowUnread } from '../src/renderer/src/components/sidebar/unread'
import type { Slot } from '../src/renderer/src/components/sidebar/slots'
import type { Chat, Thread, Workspace } from '../src/shared/types'

const tab = (id: string, over: Partial<Chat> = {}): Chat => ({ id, workspaceId: 'lead', title: id, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1, ...over })
const unread = (id: string, workspaceId = 'lead', over: Partial<Chat> = {}) => tab(id, { workspaceId, unreadAt: 500, ...over })
const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId: 'r1', name: id, branch: id, baseRef: 'main', path: `/w/${id}`, mode: 'worktree', agentId: 'kai', port: 0, status: 'ready', prState: 'none', createdAt: 1, ...over }) as Workspace
const thread: Thread = { id: 't1', roomId: 'r1', title: 'Client portal login', createdAt: 1 }
const table = ws('invoice-table')
const row = (o: Partial<Extract<Slot, { kind: 'chat' }>> = {}): Slot => ({ kind: 'chat', thread, tabs: [tab('c1')], owned: [], folded: false, ...o })
const chatInput = { tabs: [tab('c1'), tab('c2')], owned: [table], chats: {}, folded: false, current: false }

describe('unread chats (KERNEL-508)', () => {
  it('a chat is unread when unreadAt is set, and a chat from before reads as read', () => {
    expect(isUnread(unread('c1'))).toBe(true)
    expect(isUnread(tab('c1'))).toBe(false)
  })

  describe('a Lead chat row', () => {
    it('is bold when one of its open tabs is unread', () => {
      expect(chatUnread({ ...chatInput, tabs: [tab('c1'), unread('c2')] })).toBe(true)
      expect(chatUnread(chatInput)).toBe(false)
    })

    it('is bold when a folded chat hides a workspace with an unread chat, and not when it is unfolded', () => {
      const chats = { [table.id]: [unread('w1', table.id)] }
      expect(chatUnread({ ...chatInput, chats, folded: true })).toBe(true)
      // Unfolded, the workspace's own row is bold and the chat's stays as it is.
      expect(chatUnread({ ...chatInput, chats, folded: false })).toBe(false)
    })

    it('counts only the workspaces the chat started, and only their open chats', () => {
      const elsewhere = { other: [unread('x', 'other')] }
      expect(chatUnread({ ...chatInput, chats: elsewhere, folded: true })).toBe(false)
      const hidden = { [table.id]: [unread('a', table.id, { closed: true }), unread('b', table.id, { kind: 'terminal' })] }
      expect(chatUnread({ ...chatInput, chats: hidden, folded: true })).toBe(false)
    })

    it('is never bold on screen, whatever is unread in it', () => {
      const chats = { [table.id]: [unread('w1', table.id)] }
      expect(chatUnread({ ...chatInput, tabs: [unread('c1')], chats, folded: true, current: true })).toBe(false)
    })
  })

  describe('a workspace row', () => {
    it('is bold when one of its chats is unread', () => {
      expect(workspaceRowUnread([tab('a', { workspaceId: 'w' }), unread('b', 'w')], false)).toBe(true)
      expect(workspaceRowUnread([tab('a', { workspaceId: 'w' })], false)).toBe(false)
    })

    it('is read before its chats have loaded, and ignores a closed tab or a terminal', () => {
      expect(workspaceRowUnread(undefined, false)).toBe(false)
      expect(workspaceRowUnread([unread('a', 'w', { closed: true }), unread('b', 'w', { kind: 'terminal' })], false)).toBe(false)
    })

    it('is never bold on screen', () => {
      expect(workspaceRowUnread([unread('a', 'w')], true)).toBe(false)
    })
  })

  describe('a room row', () => {
    it('is bold when collapsed and a Lead chat tab inside it is unread', () => {
      expect(roomUnread({ rows: [row({ tabs: [unread('c1')] })], chats: {}, expanded: false })).toBe(true)
    })

    it('is bold when collapsed and a workspace row inside it has an unread chat', () => {
      const rows: Slot[] = [{ kind: 'workspace', ws: table, nested: false }]
      expect(roomUnread({ rows, chats: { [table.id]: [unread('w1', table.id)] }, expanded: false })).toBe(true)
    })

    it('is bold when collapsed and a folded chat hides a workspace with something unread', () => {
      const rows = [row({ owned: [table], folded: true })]
      expect(roomUnread({ rows, chats: { [table.id]: [unread('w1', table.id)] }, expanded: false })).toBe(true)
    })

    it('is not bold when everything inside is read, or when it has only the Lead row', () => {
      const rows: Slot[] = [row({ owned: [table] }), { kind: 'workspace', ws: table, nested: true }]
      expect(roomUnread({ rows, chats: { [table.id]: [tab('w1', { workspaceId: table.id })] }, expanded: false })).toBe(false)
      expect(roomUnread({ rows: [{ kind: 'lead' }], chats: {}, expanded: false })).toBe(false)
    })

    it('is not bold while it is expanded, since its own rows show what is new', () => {
      expect(roomUnread({ rows: [row({ tabs: [unread('c1')] })], chats: {}, expanded: true })).toBe(false)
    })
  })
})
