import { describe, expect, it, vi } from 'vitest'
import type { ChatPart } from '../src/shared/types'
import { leadHasNoChat, newChatTab, showsNewChat } from '../src/renderer/src/screens/workspace/leadNoChat'

// KERNEL-366: a room with no chats opens on New chat with Rowan, and + and ⌘T there start no chat.

describe('the Lead workspace with no chat', () => {
  it('picks the New chat state when no chat tab is open, and not for a chat, a closed chat or another agent', () => {
    expect(leadHasNoChat(true, [])).toBe(true)
    expect(leadHasNoChat(true, [{ kind: 'chat', closed: true }])).toBe(true)
    expect(leadHasNoChat(true, [{ kind: 'terminal' }])).toBe(true)
    expect(leadHasNoChat(true, [{ kind: 'chat' }])).toBe(false)
    expect(leadHasNoChat(true, [{ kind: 'chat', closed: true }, { kind: 'chat' }])).toBe(false)
    expect(leadHasNoChat(false, [])).toBe(false)
  })
})

describe('+ and ⌘T', () => {
  it('put the caret in the New chat box and never call chats.create while no chat is open', async () => {
    const focus = vi.fn()
    const create = vi.fn(async () => 'chat-1')
    expect(await newChatTab(true, focus, create)).toBeUndefined()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('add a tab to the open chat as before', async () => {
    const focus = vi.fn()
    const create = vi.fn(async () => 'chat-1')
    expect(await newChatTab(false, focus, create)).toBe('chat-1')
    expect(create).toHaveBeenCalledTimes(1)
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('a big terminal open in a room with no chat', () => {
  const terminal = { id: 't1', kind: 'terminal' as const }

  it('still counts as no chat, so + and ⌘T focus the box and never call chats.create', async () => {
    const noChat = leadHasNoChat(true, [terminal])
    expect(noChat).toBe(true)
    const focus = vi.fn()
    const create = vi.fn(async () => 'chat-1')
    await newChatTab(noChat, focus, create)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('shows the terminal until the box is asked for, then the box, and the box for a file, diff or shared tab', () => {
    expect(showsNewChat(true, false, [terminal], 't1')).toBe(false)
    expect(showsNewChat(true, true, [terminal], 't1')).toBe(true)
    expect(showsNewChat(true, false, [terminal], 'file:a.ts')).toBe(true)
    expect(showsNewChat(true, false, [terminal], 'diff:')).toBe(true)
    expect(showsNewChat(true, false, [terminal], 'shared:s1')).toBe(true)
    expect(showsNewChat(true, false, [terminal], undefined)).toBe(true)
    expect(showsNewChat(false, true, [{ id: 'c1' }], 'c1')).toBe(false)
  })
})

describe("a room's New chat box draft", () => {
  const words = (t: string): ChatPart[] => [{ type: 'text', text: t }]

  it('is its own per room, survives a prune, and leaves the dialog\'s draft alone', async () => {
    vi.resetModules()
    const { loadDraft, newChatDraftOf, NEW_CHAT_DRAFT, pruneDrafts, saveDraft } = await import('../src/renderer/src/screens/workspace/composer/draftStore')
    saveDraft(newChatDraftOf('room-a'), words('plan the week'), '')
    expect(loadDraft(newChatDraftOf('room-a'))).toEqual(words('plan the week'))
    expect(loadDraft(newChatDraftOf('room-b'))).toBeUndefined()
    expect(loadDraft(NEW_CHAT_DRAFT)).toBeUndefined()
    pruneDrafts({ workspaces: [], chats: {} }, () => true)
    expect(loadDraft(newChatDraftOf('room-a'))).toEqual(words('plan the week'))
  })
})
