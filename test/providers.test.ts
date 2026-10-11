import { describe, expect, it } from 'vitest'
import { chatProvider, limitProvider, providerOf } from '../src/shared/providers'

describe('which provider runs a model (KERNEL-406)', () => {
  it('reads Claude ids and the aliases agent files use as Claude, and anything else as Codex', () => {
    expect(providerOf('claude-opus-5-5')).toBe('claude')
    expect(providerOf('Opus')).toBe('claude')
    expect(providerOf('haiku')).toBe('claude')
    expect(providerOf('gpt-6-astra')).toBe('codex')
    expect(providerOf('gpt-5.6-luna')).toBe('codex')
  })
  it('reads chats and limits saved before KERNEL-406 as Claude', () => {
    expect(chatProvider({})).toBe('claude')
    expect(chatProvider({ provider: 'codex' })).toBe('codex')
    expect(limitProvider({})).toBe('claude')
  })
})
