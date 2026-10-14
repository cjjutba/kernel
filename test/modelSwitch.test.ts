import { describe, expect, it } from 'vitest'
import { lastRanOn, noteOpened, noteSent, warnsOnSwitch } from '../src/renderer/src/screens/workspace/composer/modelSwitch'

describe('model switch warning', () => {
  it('warns only for a started chat on another model', () => {
    expect(warnsOnSwitch(true, 'a', 'b')).toBe(true)
    expect(warnsOnSwitch(false, 'a', 'b')).toBe(false)
    expect(warnsOnSwitch(true, 'a', 'a')).toBe(false)
  })

  it('stays quiet when switching away and back, and warns again after a send', () => {
    noteOpened('c1', 'a')
    noteOpened('c1', 'b')
    expect(lastRanOn('c1')).toBe('a')
    expect(warnsOnSwitch(true, lastRanOn('c1'), 'b')).toBe(true)
    expect(warnsOnSwitch(true, lastRanOn('c1'), 'a')).toBe(false)
    noteSent('c1', 'b')
    expect(warnsOnSwitch(true, lastRanOn('c1'), 'a')).toBe(true)
  })

  it('has nothing to compare for a chat it never saw', () => {
    expect(warnsOnSwitch(true, lastRanOn('never'), 'a')).toBe(false)
  })
})
