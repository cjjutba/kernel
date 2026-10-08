import { describe, expect, it } from 'vitest'
import { clearOverlaps, type Box } from '../src/renderer/src/floor/clear'

const box = (id: string, x: number, y: number, w = 80, h = 30): Box => ({ id, x, y, w, h })

describe('clearOverlaps', () => {
  it('leaves boxes that do not touch where they are', () => {
    expect(clearOverlaps([box('a', 100, 200), box('b', 300, 200), box('c', 100, 100)])).toEqual({})
  })

  it('stacks the higher of two overlapping tags above the lower one', () => {
    // Rowan (mid-walk) and Noor share a row, 60px apart with 80px-wide tags.
    expect(clearOverlaps([box('noor', 160, 362), box('rowan', 100, 358)])).toEqual({ rowan: 26 })
  })

  it('puts the last box above every tag it would cover', () => {
    const lift = clearOverlaps([box('kai', 250, 222), box('rowan', 300, 270), box('bubble', 270, 240, 250, 48)], 'bubble')
    // Rowan clears Kai first, then the bubble stacks above both.
    const placed = (id: string, y: number) => y - (lift[id] ?? 0)
    const kai = placed('kai', 222)
    const rowan = placed('rowan', 270)
    const bubble = placed('bubble', 240)
    expect(kai).toBe(222)
    expect(bubble - 48).toBeLessThan(Math.min(kai, rowan) - 30)
  })

  it('leaves no pair of boxes overlapping', () => {
    const boxes = [box('a', 100, 300), box('b', 120, 300), box('c', 140, 300), box('d', 110, 290), box('e', 130, 310, 250, 48)]
    const lift = clearOverlaps(boxes, 'e')
    const moved = boxes.map((b) => ({ ...b, y: b.y - (lift[b.id] ?? 0) }))
    for (const [i, p] of moved.entries()) for (const q of moved.slice(i + 1)) {
      const apart = Math.abs(p.x - q.x) >= (p.w + q.w) / 2 || p.y <= q.y - q.h || q.y <= p.y - p.h
      expect(apart, `${p.id} and ${q.id}`).toBe(true)
    }
  })

  it('lifts the walking tag, whichever is lower on screen', () => {
    const seated = box('noor', 160, 362)
    // The walker is below the seated tag, then above it: the seated one stays put both times.
    expect(Object.keys(clearOverlaps([seated, { ...box('rowan', 120, 380), walking: true }]))).toEqual(['rowan'])
    expect(Object.keys(clearOverlaps([seated, { ...box('rowan', 120, 350), walking: true }]))).toEqual(['rowan'])
  })

  it('does not depend on the order the boxes come in', () => {
    const boxes = [box('a', 100, 300), box('b', 130, 296), box('c', 150, 310)]
    expect(clearOverlaps([...boxes].reverse())).toEqual(clearOverlaps(boxes))
  })
})
