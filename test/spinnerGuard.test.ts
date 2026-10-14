import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dotPatterns, spinnerPatterns } from '../src/renderer/src/ui/dotPatterns'

const root = resolve(__dirname, '../src/renderer/src')
const ui = join(root, 'ui') + sep

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? tsxFiles(p) : p.endsWith('.tsx') ? [p] : []
  })
}

describe('the dot loader (KERNEL-714)', () => {
  it('has no raw ring outside ui/, so every loader is a Spinner', () => {
    const files = tsxFiles(root).filter((f) => !f.startsWith(ui))
    expect(files.length).toBeGreaterThan(0)
    const raw = files.filter((f) => /className=(?:"spin[\s"]|\{`spin)/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))
    expect(raw).toEqual([])
  })
})

// The dip the loader draws, read from tokens.css so this test follows the CSS: a dot shrinks, stays gone, grows back and rests at full size (KERNEL-759 revised).
const css = readFileSync(join(root, 'tokens.css'), 'utf8')
const keyframes = /@keyframes dots-dip \{[^\n]*\}/.exec(css)?.[0] ?? ''
const stops = {
  out: Number(/([\d.]+)%,\s*[\d.]+%\s*\{\s*transform:\s*scale\(0\)/.exec(keyframes)?.[1]) / 100,
  goneEnd: Number(/[\d.]+%,\s*([\d.]+)%\s*\{\s*transform:\s*scale\(0\)/.exec(keyframes)?.[1]) / 100,
  full: Number(/([\d.]+)%,\s*100%\s*\{\s*transform:\s*scale\(1\)/.exec(keyframes)?.[1]) / 100,
}

/** cubic-bezier(0.37, 0, 0.63, 1), the sine ease the keyframes use. */
function sine(x: number) {
  const bez = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3
  let lo = 0, hi = 1
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (bez(m, 0.37, 0.63) < x) lo = m; else hi = m }
  return bez((lo + hi) / 2, 0, 1)
}

/** A dot's size (0 to 1) at loop fraction `u`, when its dip starts at loop fraction `start`. */
function size(start: number, u: number) {
  const r = (((u - start) % 1) + 1) % 1
  if (r < stops.out) return 1 - sine(r / stops.out)
  if (r < stops.goneEnd) return 0
  if (r < stops.full) return sine((r - stops.goneEnd) / (stops.full - stops.goneEnd))
  return 1
}

describe('the dot loader center (KERNEL-759)', () => {
  it('reads its dip from the keyframes', () => {
    expect(stops.out).toBeGreaterThan(0)
    expect(stops.goneEnd).toBeGreaterThan(stops.out)
    expect(stops.full).toBeGreaterThan(stops.goneEnd)
    expect(stops.full).toBeLessThan(1)
  })

  it.each(spinnerPatterns)('%s: the center never shows or dips alone', (name) => {
    const { n, dots } = dotPatterns[name]
    const starts = dots.map((d) => d.at / n)
    const SAMPLES = 1200
    const alone: number[] = []
    for (let k = 0; k < SAMPLES; k++) {
      const u = k / SAMPLES
      const centre = size(starts[4], u)
      const others = starts.filter((_, i) => i !== 4).map((s) => size(s, u))
      const shows = others.some((v) => v > 0.2)
      const dips = others.some((v) => v < 0.9)
      if ((centre > 0.2 && !shows) || (centre < 0.9 && !dips)) alone.push(u)
    }
    expect(alone).toEqual([])
  })

  it.each(spinnerPatterns)('%s: every dot gets a turn and the still frame keeps a neighbor with the center', (name) => {
    const { n, dots, still } = dotPatterns[name]
    expect(dots).toHaveLength(9)
    dots.forEach((d) => { expect(d.at).toBeGreaterThanOrEqual(0); expect(d.at).toBeLessThan(n) })
    expect(still.length).toBeGreaterThan(0)
    if (still.includes(4)) expect(still.length).toBeGreaterThan(1)
  })
})
