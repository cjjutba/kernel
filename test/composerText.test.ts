import { describe, expect, it } from 'vitest'
import { filterSkills, isLongPaste, mentionAt, slashAt } from '../src/renderer/src/screens/workspace/composer/autocomplete'
import { toUserMessage } from '../src/main/services/sessions'

describe('composer text rules', () => {
  it('turns a paste into a chip over 4 lines or 280 characters', () => {
    expect(isLongPaste('a\nb\nc\nd')).toBe(false)
    expect(isLongPaste('a\nb\nc\nd\ne')).toBe(true)
    expect(isLongPaste('x'.repeat(280))).toBe(false)
    expect(isLongPaste('x'.repeat(281))).toBe(true)
  })

  it('finds the @ word before the caret and a leading slash', () => {
    expect(mentionAt('see @inv')).toEqual({ start: 4, query: 'inv' })
    expect(mentionAt('mail me@inv')).toBeNull()
    expect(mentionAt('@')).toEqual({ start: 0, query: '' })
    expect(slashAt('/ver', false)).toEqual({ query: 'ver' })
    expect(slashAt('/ver', true)).toBeNull()
    expect(slashAt('a /ver', false)).toBeNull()
  })

  it('lists prefix matches before other matches', () => {
    const s = (name: string, description = '') => ({ name, description, source: 'project' as const, enabled: true })
    const list = [s('review', 'Check the verify step'), s('verify'), s('setup')]
    expect(filterSkills(list, 'ver').map((x) => x.name)).toEqual(['verify', 'review'])
    expect(filterSkills([{ ...s('off'), enabled: false }], '')).toEqual([])
  })

  it('sends a skill chip as a slash command with the text after it', () => {
    const blocks = (m: ReturnType<typeof toUserMessage>) => (m.message.content as { type: string; text?: string }[]).map((b) => b.text)
    expect(blocks(toUserMessage([{ type: 'skill', name: 'verify' }, { type: 'text', text: 'the invoice table' }]))).toEqual(['/verify the invoice table'])
    expect(blocks(toUserMessage([{ type: 'skill', name: 'plan' }]))).toEqual(['/plan'])
  })
})
