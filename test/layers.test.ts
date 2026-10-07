import { describe, expect, it } from 'vitest'
import { isOutsidePress } from '../src/renderer/src/ui/hooks'

// Minimal stand-ins for DOM nodes: `contains` is all the check uses.
const node = (...inside: object[]) => ({ contains: (n: object) => inside.includes(n) }) as unknown as HTMLElement

describe('isOutsidePress', () => {
  const inLayer = {}
  const inAnchor = {}
  const elsewhere = {}
  const layer = node(inLayer)
  const anchor = node(inAnchor)

  it('is false for a press inside the layer', () => {
    expect(isOutsidePress(inLayer as Node, layer, anchor)).toBe(false)
  })
  it('is false for a press inside the anchor, so the trigger can toggle the layer', () => {
    expect(isOutsidePress(inAnchor as Node, layer, anchor)).toBe(false)
  })
  it('is true for a press elsewhere', () => {
    expect(isOutsidePress(elsewhere as Node, layer, anchor)).toBe(true)
    expect(isOutsidePress(elsewhere as Node, layer)).toBe(true)
  })
  it('is false when there is no layer element yet', () => {
    expect(isOutsidePress(elsewhere as Node, null, anchor)).toBe(false)
  })
})
