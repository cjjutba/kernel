import { describe, expect, it } from 'vitest'
import type { Approval } from '../src/shared/types'
import { pendingRequest, runTarget } from '../src/renderer/src/screens/workspace/shortcuts'

// KERNEL-539: the shortcuts Settings, Shortcuts lists that no button owned.
const req = (id: string, extra: Partial<Approval> = {}): Approval => ({ id, kind: 'tool', source: 'sdk', projectId: 'r', chatId: 'c1', toolName: 'Bash', title: 'Run x', status: 'pending', createdAt: 1, ...extra })

describe('workspace shortcuts', () => {
  it('answers the oldest permission request waiting in the open chat', () => {
    const list = [req('late', { createdAt: 5 }), req('early', { createdAt: 2 }), req('other', { chatId: 'c2', createdAt: 1 }), req('done', { status: 'allowed', createdAt: 0 })]
    expect(pendingRequest(list, 'c1')?.id).toBe('early')
    expect(pendingRequest(list, 'c3')).toBeUndefined()
    expect(pendingRequest(list, undefined)).toBeUndefined()
  })

  it('leaves plans and questions to their own keys', () => {
    expect(pendingRequest([req('p', { kind: 'plan' }), req('q', { kind: 'question' })], 'c1')).toBeUndefined()
  })

  it('stops the run script that is running, else starts the project\'s first', () => {
    expect(runTarget(['web'], ['run', 'web'])).toEqual({ name: 'web', stop: true })
    expect(runTarget([], ['storybook', 'run'])).toEqual({ name: 'storybook', stop: false })
    expect(runTarget([], [])).toEqual({ name: 'run', stop: false })
  })
})

// configurable-hotkeys: the bindings Settings, Shortcuts lets the user change, and how a key press is matched against them.
describe('configurable hotkeys', async () => {
  const h = await import('../src/shared/hotkeys')
  const ev = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}, key = code.startsWith('Key') ? code.slice(3).toLowerCase() : '') =>
    ({ key, code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift })

  it('has a unique id and no two defaults that press the same keys', () => {
    const ids = h.HOTKEYS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const d of h.HOTKEYS) expect(h.conflictOf(h.DEFAULT_HOTKEYS, d.id, d.combo), d.id).toBeUndefined()
  })

  it('matches modifiers exactly, letters by what the layout typed and ranges by digit', () => {
    expect(h.matches(ev('KeyK', { meta: true }), 'meta+KeyK')).toBe(true)
    expect(h.matches(ev('KeyK', { meta: true, shift: true }), 'meta+KeyK')).toBe(false)
    // Dvorak: the key in QWERTY's K spot types t.
    expect(h.matches(ev('KeyK', { meta: true }, 't'), 'meta+KeyT')).toBe(true)
    // Option turns B into ∫, so the physical key counts.
    expect(h.matches(ev('KeyB', { meta: true, alt: true }, '∫'), 'meta+alt+KeyB')).toBe(true)
    expect(h.digitOf(ev('Digit3', { ctrl: true, meta: true }), 'ctrl+meta+Digit#', 4)).toBe(3)
    expect(h.digitOf(ev('Digit5', { ctrl: true, meta: true }), 'ctrl+meta+Digit#', 4)).toBeNull()
    expect(h.digitOf(ev('Digit3', { meta: true }), 'ctrl+meta+Digit#', 4)).toBeNull()
  })

  it('records a new combo, and refuses one taken, reserved or without a modifier', () => {
    const keys = h.DEFAULT_HOTKEYS
    expect(h.recorded(keys, 'palette', ev('KeyP', { meta: true, alt: true }))).toEqual({ combo: 'meta+alt+KeyP' })
    expect(h.recorded(keys, 'palette', ev('MetaLeft', { meta: true }, 'Meta'))).toBeNull()
    expect(h.recorded(keys, 'palette', ev('KeyN', { meta: true }))).toEqual({ error: '⌘N is already New chat' })
    expect(h.recorded(keys, 'palette', ev('KeyC', { meta: true }))).toEqual({ error: '⌘C belongs to macOS or text editing' })
    expect(h.recorded(keys, 'palette', ev('KeyP'))).toEqual({ error: 'Add ⌘, ⌃ or ⌥ to the key' })
    // A range takes a number, and a combo inside another range is a conflict.
    expect(h.recorded(keys, 'nthChat', ev('KeyP', { meta: true, alt: true }))).toEqual({ error: 'Hold the modifier keys and press a number' })
    expect(h.recorded(keys, 'nthChat', ev('Digit2', { meta: true, alt: true }))).toEqual({ combo: 'meta+alt+Digit#' })
    expect(h.recorded(keys, 'palette', ev('Digit2', { ctrl: true }))).toEqual({ error: '⌃2 is already Open the nth workspace of this chat' })
  })

  it('keeps only valid overrides that differ from the default', () => {
    expect(h.hotkeyOverrides({ palette: 'meta+alt+KeyP', settings: 'meta+Comma', sidebar: 'KeyB', back: 'meta+KeyC', nope: 'meta+KeyY', nthChat: 'meta+KeyY', focusMode: null }))
      .toEqual({ palette: 'meta+alt+KeyP' })
    const keys = h.resolveHotkeys({ palette: 'meta+alt+KeyP', sidebar: 'garbage' })
    expect(keys.palette).toBe('meta+alt+KeyP')
    expect(keys.sidebar).toBe('meta+KeyB')
  })

  it('draws a combo as caps and spoken words', () => {
    expect(h.comboKeys('meta+shift+KeyP')).toEqual(['⌘', '⇧', 'P'])
    expect(h.comboKeys('ctrl+meta+Digit#', 4)).toEqual(['⌃', '⌘', '1 to 4'])
    expect(h.comboLabel('meta+Enter')).toBe('⌘↵')
    expect(h.comboSpoken('meta+alt+KeyZ')).toBe('Command Option Z')
  })
})
