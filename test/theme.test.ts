import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveTheme } from '../src/renderer/src/ui/theme'

describe('resolveTheme', () => {
  it('keeps an explicit theme whatever the system says', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })
  it('follows the system for "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

// KERNEL-29: light theme rules.
const root = join(__dirname, '..')
const tokensCss = readFileSync(join(root, 'src/renderer/src/tokens.css'), 'utf8')

/** The `--name: #hex` declarations of one theme block. */
function tokens(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(selector)
  const block = tokensCss.slice(start, tokensCss.indexOf('\n}', start))
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2].toLowerCase()]))
}
const channel = (h: string, i: number) => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const lum = (h: string) => 0.2126 * channel(h, 1) + 0.7152 * channel(h, 3) + 0.0722 * channel(h, 5)
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

const SURFACES = ['canvas', 'panel', 'surface', 'surface-2', 'surface-3', 'hover', 'card-bg', 'code-bg', 'input-bg']
const TEXT = ['ink', 'ink-2', 'ink-3', 'muted', 'add', 'del', 'merged', 'working', 'needs']
const TERM = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].map((n) => `term-${n}`)

describe('theme contrast', () => {
  const light = tokens("[data-theme='light']")
  const dark = tokens(":root, [data-theme='dark']")
  it('light text, diff, merged and terminal colors reach 4.5:1 on every surface', () => {
    const fails: string[] = []
    for (const t of [...TEXT, 'faint', 'danger', ...TERM]) for (const s of SURFACES) if (contrast(light[t], light[s]) < 4.5) fails.push(`${t} on ${s}: ${contrast(light[t], light[s]).toFixed(2)}`)
    expect(fails).toEqual([])
  })
  it('dark text, diff, merged and terminal colors reach 4.5:1 on the main surfaces', () => {
    const fails: string[] = []
    for (const t of [...TEXT, ...TERM.filter((n) => n !== 'term-black')]) for (const s of ['canvas', 'panel', 'surface', 'surface-2', 'code-bg']) if (contrast(dark[t], dark[s]) < 4.5) fails.push(`${t} on ${s}: ${contrast(dark[t], dark[s]).toFixed(2)}`)
    expect(fails).toEqual([])
  })
  it('hover card status words reach 4.5:1 on their pill in both themes', () => {
    const fails: string[] = []
    for (const [name, theme] of [['light', light], ['dark', dark]] as const) for (const t of ['working', 'needs', 'add', 'del', 'merged', 'muted'])
      if (contrast(theme[t], theme[`tint-${t}`]) < 4.5) fails.push(`${name} ${t} on tint-${t}: ${contrast(theme[t], theme[`tint-${t}`]).toFixed(2)}`)
    expect(fails).toEqual([])
  })
  it('solid buttons keep readable labels in light', () => {
    expect(contrast(light['on-solid'], light.danger)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light['on-solid'], light['merged-solid'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light['on-ink'], light.ink)).toBeGreaterThanOrEqual(4.5)
  })
  it('every token exists in both themes', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort())
  })
})

describe('no hardcoded colors', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return p === join(root, 'src/renderer/src/floor') ? [] : files(p)
    return /\.(tsx?|css)$/.test(e.name) && e.name !== 'tokens.css' ? [p] : []
  })
  it('renderer code uses tokens, except tokens.css and the floor art', () => {
    const hits: string[] = []
    for (const f of files(join(root, 'src/renderer/src'))) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (/#[0-9a-fA-F]{3,8}\b(?![\w-])|\brgba?\(|\bhsla?\(/.test(line.replace(/error #\d+/g, ''))) hits.push(`${f.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 80)}`) })
    }
    expect(hits).toEqual([])
  })
})
