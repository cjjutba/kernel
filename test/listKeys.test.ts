import { describe, expect, it } from 'vitest'
import { listKeyAction } from '../src/renderer/src/ui/listKeys'

const key = (k: string, mods: object = {}) => ({ key: k, ...mods })

describe('list keys (KERNEL-871)', () => {
  it('moves one row with the arrows and with j and k', () => {
    for (const k of ['ArrowDown', 'j']) expect(listKeyAction(key(k), 1, 5)).toEqual({ kind: 'move', to: 2 })
    for (const k of ['ArrowUp', 'k']) expect(listKeyAction(key(k), 1, 5)).toEqual({ kind: 'move', to: 0 })
  })

  it('stops at the ends by default', () => {
    expect(listKeyAction(key('ArrowDown'), 4, 5)).toEqual({ kind: 'move', to: 4 })
    expect(listKeyAction(key('ArrowUp'), 0, 5)).toEqual({ kind: 'move', to: 0 })
  })

  it('wraps at the ends when asked', () => {
    expect(listKeyAction(key('ArrowDown'), 4, 5, true)).toEqual({ kind: 'move', to: 0 })
    expect(listKeyAction(key('k'), 0, 5, true)).toEqual({ kind: 'move', to: 4 })
  })

  it('lands on the first row when nothing is chosen yet', () => {
    expect(listKeyAction(key('j'), -1, 5)).toEqual({ kind: 'move', to: 0 })
    expect(listKeyAction(key('k'), -1, 5)).toEqual({ kind: 'move', to: 0 })
  })

  it('jumps to the first and last row with Home and End', () => {
    expect(listKeyAction(key('Home'), 3, 5)).toEqual({ kind: 'move', to: 0 })
    expect(listKeyAction(key('End'), 1, 5)).toEqual({ kind: 'move', to: 4 })
  })

  it('opens the current row with Enter, and has nothing to open without one', () => {
    expect(listKeyAction(key('Enter'), 2, 5)).toEqual({ kind: 'open' })
    expect(listKeyAction(key('Enter'), -1, 5)).toBeNull()
  })

  it('leaves modified keys, other keys and an empty list alone', () => {
    expect(listKeyAction(key('ArrowDown', { shiftKey: true }), 1, 5)).toBeNull()
    expect(listKeyAction(key('j', { metaKey: true }), 1, 5)).toBeNull()
    expect(listKeyAction(key('a'), 1, 5)).toBeNull()
    expect(listKeyAction(key('ArrowDown'), -1, 0)).toBeNull()
  })
})
