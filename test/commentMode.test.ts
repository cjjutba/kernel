import { describe, expect, it } from 'vitest'
import { canSend, chipName, hoverLabel, imageCropRect, pinSpot, popoverPlace, previewLines } from '../src/renderer/src/screens/workspace/shared/comment'
import { commentParts, commentText, whereOf } from '../src/main/services/sharedComments'
import type { SharedAnchor, SharedFile } from '../src/shared/types'

const file = (kind: SharedFile['kind'], title = 'Pricing page draft', latest = 2): SharedFile => ({
  id: 'sh', projectId: 'r', workspaceId: 'w', agentId: 'noor', source: '.kernel/shared/pricing.html', title, kind, createdAt: 1, updatedAt: 1,
  versions: Array.from({ length: latest }, (_, i) => ({ n: i + 1, at: i + 1, file: 'f', mime: 'text/html', bytes: 1, sha256: `s${i}`, width: 616, height: 385 }))
})
const page: SharedAnchor = { x: 412, y: 188, viewport: { width: 1280, height: 800, scrollY: 0 }, element: { selector: 'section.hero > div.actions > button.cta', tag: 'button', text: 'Start free trial', rect: { x: 40, y: 160, width: 120, height: 36 } } }
const image: SharedAnchor = { x: 117, y: 70, viewport: { width: 616, height: 385, scrollY: 0 } }
const block: SharedAnchor = { x: 4, y: 6, block: { index: 3, text: 'Open questions   about  fonts' } }

describe('canSend', () => {
  it('needs words, a reachable agent and no send in flight', () => {
    expect(canSend('Make it blue', false, false)).toBe(true)
    expect(canSend('   \n', false, false)).toBe(false)
    expect(canSend('Make it blue', true, false)).toBe(false)
    expect(canSend('Make it blue', false, true)).toBe(false)
  })
})

describe('hoverLabel', () => {
  it('names the last step of the path without its position', () => {
    expect(hoverLabel({ selector: 'section.plans > div.plan:nth-of-type(3)', tag: 'div' })).toBe('div.plan')
    expect(hoverLabel({ selector: '', tag: 'main' })).toBe('main')
  })
})

describe('imageCropRect', () => {
  it('centres the crop on the point and keeps it inside the image', () => {
    expect(imageCropRect({ x: 300, y: 200 }, { width: 616, height: 385 })).toEqual({ x: 140, y: 100, width: 320, height: 200 })
    expect(imageCropRect({ x: 5, y: 5 }, { width: 616, height: 385 })).toEqual({ x: 0, y: 0, width: 320, height: 200 })
    expect(imageCropRect({ x: 610, y: 380 }, { width: 616, height: 385 })).toEqual({ x: 296, y: 185, width: 320, height: 200 })
  })
  it('takes the whole of an image smaller than the crop', () => {
    expect(imageCropRect({ x: 20, y: 20 }, { width: 100, height: 50 })).toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })
})

describe('popoverPlace', () => {
  const layer = { width: 755, height: 530 }
  const pop = { width: 380, height: 200 }
  it('goes below the pin, a little to its left', () => {
    expect(popoverPlace({ x: 159, y: 162 }, layer, pop)).toEqual({ x: 95, y: 190 })
  })
  it('stays inside the layer sideways', () => {
    expect(popoverPlace({ x: 20, y: 100 }, layer, pop).x).toBe(8)
    expect(popoverPlace({ x: 740, y: 100 }, layer, pop).x).toBe(755 - 380 - 8)
  })
  it('goes above the pin where there is no space below', () => {
    expect(popoverPlace({ x: 300, y: 480 }, layer, pop).y).toBeLessThan(480)
  })
})

describe('pinSpot', () => {
  it('keeps its offset in the element and follows the element', () => {
    // Left at 412, 188 in a box at 40, 160 (120 by 36): 372 across is past the box, so it sits on the box's right edge.
    expect(pinSpot(page, { x: 100, y: 300, width: 120, height: 36 })).toEqual({ x: 220, y: 328 })
  })
  it('falls back to where it was left when the element is gone', () => {
    expect(pinSpot(page, null)).toEqual({ x: 412, y: 188 })
    expect(pinSpot(image, null)).toEqual({ x: 117, y: 70 })
  })
})

// The popover shows what the agent will get, so it has to say what the engine says.
describe('previewLines', () => {
  const note = 'Make this bigger.'
  const cases: [string, SharedFile, number, SharedAnchor][] = [
    ['a page', file('html'), 2, page],
    ['an older version of a page', file('html', 'Pricing page draft', 3), 2, page],
    ['a point on a page', file('html'), 2, { x: 5, y: 9 }],
    ['an image', file('image', 'Embedded fonts check', 1), 1, image],
    ['markdown', file('markdown', 'PDF renderer notes'), 2, block]
  ]
  for (const [name, f, v, anchor] of cases) {
    it(`matches the message the engine sends for ${name}`, () => {
      const text = commentText(f, v, note, anchor)
      expect(text.startsWith(previewLines(f, v, anchor).join('\n'))).toBe(true)
    })
  }
  it('says where in the same words as the engine', () => {
    for (const [, f, v, anchor] of cases) expect(previewLines(f, v, anchor)[1]).toBe(`Where: ${whereOf(f, v, anchor)}`)
  })
})

describe('chipName', () => {
  it('is the name the engine gives the picture', () => {
    for (const title of ['Pricing page draft', 'Embedded fonts check', 'A very long title that goes on and on and on past forty letters']) {
      const name = commentParts(file('html', title), 2, 'x', page, { dataUrl: 'data:image/png;base64,', width: 1, height: 1 }).find((p) => p.type === 'image')
      expect(name && 'name' in name ? name.name : '').toBe(chipName(title, 2))
    }
  })
})
