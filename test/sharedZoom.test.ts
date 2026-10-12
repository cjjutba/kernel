import { describe, expect, it } from 'vitest'
import { canZoomIn, canZoomOut, clampScale, doubleClickTarget, fitScale, percent, settleScale, stepScale, wheelFactor, zoomKey, zoomStops } from '../src/renderer/src/screens/workspace/shared/zoom'

describe('fitScale', () => {
  it('shrinks an image that is bigger than its frame, to the tighter side', () => {
    expect(fitScale({ width: 1000, height: 400 }, { width: 500, height: 500 })).toBe(0.5)
    expect(fitScale({ width: 400, height: 2000 }, { width: 500, height: 500 })).toBe(0.25)
  })
  it('never enlarges an image that already fits, and says 1 before anything is measured', () => {
    expect(fitScale({ width: 616, height: 385 }, { width: 900, height: 600 })).toBe(1)
    expect(fitScale({ width: 0, height: 0 }, { width: 900, height: 600 })).toBe(1)
    expect(fitScale({ width: 616, height: 385 }, { width: 0, height: 0 })).toBe(1)
  })
})

describe('clampScale', () => {
  it('holds a scale between 25% and 400%', () => {
    expect(clampScale(0.1, 0.5)).toBe(0.25)
    expect(clampScale(9, 0.5)).toBe(4)
    expect(clampScale(1.5, 0.5)).toBe(1.5)
  })
  it('goes below 25% only as far as Fit, where Fit is smaller', () => {
    expect(clampScale(0.05, 0.1)).toBe(0.1)
    expect(clampScale(0.2, 0.1)).toBe(0.2)
  })
})

describe('settleScale', () => {
  it('keeps Fit as null, so it follows the frame, and a scale beside Fit settles on it', () => {
    expect(settleScale(0.5, 0.5)).toBeNull()
    expect(settleScale(0.502, 0.5)).toBeNull()
    expect(settleScale(0.6, 0.5)).toBe(0.6)
  })
  it('clamps before it settles', () => {
    expect(settleScale(12, 0.5)).toBe(4)
    expect(settleScale(0.01, 0.1)).toBeNull()
  })
})

describe('zoomStops', () => {
  it('lists the stops with Fit among them, in order', () => {
    expect(zoomStops(0.6)).toEqual([0.25, 0.5, 0.6, 0.75, 1, 1.5, 2, 3, 4])
  })
  it('lets a stop beside Fit give way to it', () => {
    expect(zoomStops(0.5)).toEqual([0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4])
    expect(zoomStops(1)).toEqual([0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4])
  })
  it('starts at Fit where Fit is under 25%', () => {
    expect(zoomStops(0.1)).toEqual([0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4])
  })
})

describe('stepScale', () => {
  it('steps up from Fit to the next stop, one at a time, up to 400%', () => {
    expect(stepScale(0.6, 1, 0.6)).toBe(0.75)
    expect(stepScale(1, 1, 0.6)).toBe(1.5)
    expect(stepScale(3, 1, 0.6)).toBe(4)
    expect(stepScale(4, 1, 0.6)).toBe(4)
  })
  it('steps down through Fit to 25%, and stops there', () => {
    expect(stepScale(1, -1, 0.6)).toBe(0.75)
    expect(stepScale(0.75, -1, 0.6)).toBe(0.6)
    expect(stepScale(0.6, -1, 0.6)).toBe(0.5)
    expect(stepScale(0.5, -1, 0.6)).toBe(0.25)
    expect(stepScale(0.25, -1, 0.6)).toBe(0.25)
  })
  it('stops at Fit where Fit is under 25%', () => {
    expect(stepScale(0.25, -1, 0.1)).toBe(0.1)
    expect(stepScale(0.1, -1, 0.1)).toBe(0.1)
    expect(stepScale(0.1, 1, 0.1)).toBe(0.25)
  })
  it('moves on from a scale between two stops, as a pinch leaves it', () => {
    expect(stepScale(0.9, 1, 0.6)).toBe(1)
    expect(stepScale(0.9, -1, 0.6)).toBe(0.75)
  })
})

describe('the ends of the range', () => {
  it('says when a button has nowhere to go', () => {
    expect(canZoomIn(4)).toBe(false)
    expect(canZoomIn(3)).toBe(true)
    expect(canZoomOut(0.25, 0.6)).toBe(false)
    expect(canZoomOut(0.6, 0.6)).toBe(true)
    expect(canZoomOut(0.1, 0.1)).toBe(false)
  })
})

describe('doubleClickTarget', () => {
  it('goes from Fit to 100%, and from anywhere else back to Fit', () => {
    expect(doubleClickTarget(0.6, 0.6)).toBe(1)
    expect(doubleClickTarget(2, 0.6)).toBeNull()
    expect(doubleClickTarget(1, 0.6)).toBeNull()
  })
  it('goes to 200% where Fit already is 100%, so the gesture does something', () => {
    expect(doubleClickTarget(1, 1)).toBe(2)
    expect(doubleClickTarget(2, 1)).toBeNull()
  })
})

describe('wheelFactor', () => {
  it('zooms in on a negative delta and out on a positive one', () => {
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(1)
    expect(wheelFactor(10, 0, true)).toBeLessThan(1)
    expect(wheelFactor(0, 0, false)).toBe(1)
  })
  it('counts a pinch for more than a ⌘ scroll of the same delta', () => {
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0, false))
  })
  it('keeps one event from jumping more than double, and reads lines and pages as pixels', () => {
    expect(wheelFactor(-100000, 0, true)).toBe(2)
    expect(wheelFactor(100000, 0, true)).toBe(0.5)
    expect(wheelFactor(-3, 1, false)).toBe(wheelFactor(-48, 0, false))
  })
})

describe('labels and keys', () => {
  it('reads a scale as a rounded percent', () => {
    expect(percent(2)).toBe('200%')
    expect(percent(0.3333)).toBe('33%')
    expect(percent(0.255)).toBe('26%')
  })
  it('maps + and =, -, and 0 to zoom in, out and Fit', () => {
    expect(zoomKey('+')).toBe('in')
    expect(zoomKey('=')).toBe('in')
    expect(zoomKey('-')).toBe('out')
    expect(zoomKey('0')).toBe('reset')
    expect(zoomKey('a')).toBeNull()
  })
})
