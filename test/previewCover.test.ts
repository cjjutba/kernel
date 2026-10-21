import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COVER_SELECTOR, intersects, isCovered, overlayBoxes, type Probe } from '../src/renderer/src/screens/workspace/shared/cover'

const rect = { x: 100, y: 100, width: 400, height: 300 }
const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })

describe('isCovered', () => {
  it('is covered by a box that overlaps the rect, however little', () => {
    expect(isCovered(rect, [box(0, 0, 101, 101)])).toBe(true)
    expect(isCovered(rect, [box(200, 150, 300, 250)])).toBe(true)
    expect(isCovered(rect, [box(0, 0, 2000, 2000)])).toBe(true)
  })
  it('is not covered by boxes that only touch the edge or sit beside it', () => {
    expect(isCovered(rect, [box(0, 0, 100, 500)])).toBe(false)
    expect(isCovered(rect, [box(500, 0, 600, 500)])).toBe(false)
    expect(isCovered(rect, [box(0, 400, 700, 500)])).toBe(false)
    expect(isCovered(rect, [box(0, 0, 700, 100)])).toBe(false)
  })
  it('is not covered when nothing is on screen', () => {
    expect(isCovered(rect, [])).toBe(false)
    expect(intersects(rect, box(300, 200, 301, 201))).toBe(true)
  })
})

const probe = (b: ReturnType<typeof box>, o: { inStage?: boolean; empty?: boolean } = {}): Probe => ({
  closest: (s) => (s === '.sv-stage' && o.inStage ? {} : null),
  getBoundingClientRect: () => ({ ...b, width: o.empty ? 0 : b.right - b.left, height: o.empty ? 0 : b.bottom - b.top })
})
const visible = { display: 'block', visibility: 'visible', opacity: '1' }

describe('overlayBoxes', () => {
  const scan = (els: Probe[], style = () => visible) => overlayBoxes({ querySelectorAll: () => els }, style)
  it('takes the box of each overlay outside the stage', () => {
    expect(scan([probe(box(0, 0, 10, 10)), probe(box(5, 5, 20, 20))])).toEqual([expect.objectContaining(box(0, 0, 10, 10)), expect.objectContaining(box(5, 5, 20, 20))])
  })
  it("skips what sits in the view's own stage and what takes up no space", () => {
    expect(scan([probe(box(0, 0, 10, 10), { inStage: true }), probe(box(0, 0, 10, 10), { empty: true })])).toEqual([])
  })
  it('skips what is hidden by display, visibility or opacity', () => {
    for (const hidden of [{ display: 'none' }, { visibility: 'hidden' }, { opacity: '0' }]) expect(scan([probe(box(0, 0, 10, 10))], () => ({ ...visible, ...hidden }))).toEqual([])
  })
})

/** The class names and roles the cover list leans on. A rename in the component fails here, before a menu draws under the page. */
describe('the cover list matches what Kernel draws', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../src/renderer/src', p), 'utf8')
  const ui = read('ui/overlays.tsx')
  const tips = read('ui/Tooltips.tsx')
  const toasts = read('components/Toasts.tsx')
  const classed = (src: string, name: string) => new RegExp(`className=(?:"|\\{[^}]*)[^"}]*\\b${name}\\b`).test(src)

  it('names each class and role it checks', () => {
    const named = COVER_SELECTOR.split(',').map((s) => s.trim())
    expect(named.filter((s) => s.startsWith('.')).sort()).toEqual(['.menu', '.modal', '.popover', '.scrim', '.toast', '.tooltip'])
    expect(named.filter((s) => s.startsWith('[')).sort()).toEqual(['[role="dialog"]', '[role="listbox"]', '[role="menu"]', '[role="tooltip"]'])
  })
  it('finds the scrim, modal, menu, popover and toast in ui/overlays.tsx', () => {
    for (const c of ['scrim', 'modal', 'menu', 'popover', 'toast']) expect(classed(ui, c), c).toBe(true)
    expect(ui).toContain('role="menu"')
    expect(ui).toContain('role="dialog"')
  })
  it('finds the tooltip in ui/Tooltips.tsx', () => {
    expect(classed(tips, 'tooltip')).toBe(true)
  })
  it('draws toasts with the Toast component in components/Toasts.tsx', () => {
    expect(toasts).toMatch(/<Toast\b/)
    expect(toasts).toMatch(/import \{[^}]*\bToast\b[^}]*\} from '..\/ui'/)
  })
  it('keeps the roles of the lists and cards that have no class of their own', () => {
    expect(read('screens/workspace/composer/AutoMenu.tsx')).toContain('role="listbox"')
    expect(read('screens/workspace/composer/ModelPicker.tsx')).toContain('role="dialog"')
  })
})
