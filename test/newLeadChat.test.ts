import { describe, expect, it, vi } from 'vitest'
import { leadHasNoChat, newChatTab } from '../src/renderer/src/screens/workspace/leadNoChat'

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
