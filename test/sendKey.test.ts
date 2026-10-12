import { describe, expect, it } from 'vitest'
import { sendHint, sendsOn } from '../src/renderer/src/screens/workspace/composer/sendKey'

const press = (key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) =>
  ({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods })

describe('Send messages with (KERNEL-536)', () => {
  it('sends on Enter by default, and Shift+Enter breaks the line', () => {
    expect(sendsOn(press('Enter'))).toBe(true)
    expect(sendsOn(press('Enter'), 'enter')).toBe(true)
    expect(sendsOn(press('Enter', { metaKey: true }), 'enter')).toBe(true)
    expect(sendsOn(press('Enter', { shiftKey: true }), 'enter')).toBe(false)
    expect(sendsOn(press('a'), 'enter')).toBe(false)
  })

  it('sends only on Cmd+Enter when set to it, so Enter breaks the line', () => {
    expect(sendsOn(press('Enter'), 'cmdEnter')).toBe(false)
    expect(sendsOn(press('Enter', { metaKey: true }), 'cmdEnter')).toBe(true)
    expect(sendsOn(press('Enter', { ctrlKey: true }), 'cmdEnter')).toBe(true)
    expect(sendsOn(press('Enter', { metaKey: true, shiftKey: true }), 'cmdEnter')).toBe(false)
  })

  it('says which key sends under a comment box', () => {
    expect(sendHint('enter')).toBe('Enter to send')
    expect(sendHint('cmdEnter')).toBe('⌘ Enter to send')
  })
})
