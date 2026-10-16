import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEME_COLOR } from '@/lib/site'

// The design rules from docs/plans/website.md section 14.4, as tests.

const root = join(import.meta.dirname, '..', '..')

function files(dir: string, test: (path: string) => boolean): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name)
    return statSync(join(root, path)).isDirectory() ? files(path, test) : test(path) ? [path] : []
  })
}

function offenders(paths: string[], pattern: RegExp, skip: (path: string, line: string) => boolean = () => false) {
  return paths.flatMap((path) =>
    readFileSync(join(root, path), 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        pattern.test(line) && !skip(path, line) ? [`${relative(root, join(root, path))}:${i + 1}: ${line.trim()}`] : []
      )
  )
}

const code = (p: string) => /\.tsx?$/.test(p)
// Brand assets keep the colors they were drawn with: the mark, the app icon and the favicons.
const brandAsset = (p: string) => p.endsWith('.svg')
const image = (p: string) => /\.(png|jpe?g|ico|webp|avif)$/.test(p)

const globals = readFileSync(join(root, 'app', 'globals.css'), 'utf8')
const colorNames = [...globals.matchAll(/^\s*--color-([a-z0-9-]+):/gm)].map((m) => m[1]!).filter((n) => n !== '*')

/** globals.css with every @theme block removed, so only the rules that use the tokens are left. */
function outsideTheme(css: string) {
  let out = ''
  let i = 0
  for (let start = css.indexOf('@theme', i); start !== -1; start = css.indexOf('@theme', i)) {
    out += css.slice(i, start)
    let depth = 0
    let j = css.indexOf('{', start)
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++
      if (css[j] === '}' && --depth === 0) break
    }
    // Keeps the line count, so the offenders' line numbers still point into globals.css.
    out += '\n'.repeat(css.slice(start, j + 1).split('\n').length - 1)
    i = j + 1
  }
  return out + css.slice(i)
}

function cssOffenders(pattern: RegExp, skip: (line: string) => boolean = () => false) {
  return outsideTheme(globals)
    .split('\n')
    .flatMap((line, i) => (pattern.test(line) && !skip(line) ? [`app/globals.css:${i + 1}: ${line.trim()}`] : []))
}

const hex = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/i
// Release notes cite pull requests as (#339), so in content a hex color has a letter in it or six or eight digits.
const contentHex = /#(?:(?=[0-9a-f]*[a-f])(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})|\d{8}|\d{6})\b/i
const colorFunction = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
const palette =
  /(?<![\w-])(?:bg|text|border|fill|stroke|from|via|to|ring|outline|decoration|divide|accent|caret|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black)\b/

// The documented scale from docs/plans/website.md section 6.2, plus the control sizes below.
const SPACING_SCALE = ['1', '2', '3', '4', '6', '8', '10', '12', '14', '16', '20', '24', '32', '40']
const CONTROL_SIZES: Record<string, string> = {
  '0': 'resets, such as inset-0 and pl-0 on a first column',
  '1.5': 'the 6 px side padding of a PR chip',
  '2.5': 'the 10 px side padding of the star count',
  '0.5': '2 px: hairline nudges',
  '3.5': '14 px: docs search and nav padding',
  '4.5': '18 px: FAQ rows and pricing rows',
  '11': '44 px: touch targets',
  '28': '112 px: section bottoms',
  '36': '144 px: footer bottom',
  '5': '20 px: the small badge and PR chip height, the large button padding',
  '7': '28 px: the mini buttons in the How it works mockups',
  '9': '36 px: the product tour tabs'
}
const SPACING = new Set([...SPACING_SCALE, ...Object.keys(CONTROL_SIZES)])
const spacingUtility =
  /(?<![\w-])-?(?:p[xytblrse]?|m[xytblrse]?|gap(?:-[xy])?|space-[xy]|size|[hw]|min-[hw]|max-h|top|left|right|bottom|start|end|inset(?:-[xy])?|translate-[xy]|scroll-[mp][xytblrse]?)-(\d+(?:\.\d+)?)(?![\w./-])/g

describe('design rules', () => {
  const components = files('components', code)
  const pages = files('app', code)

  it('keeps hex colors in globals.css only', () => {
    const themeColorLine = (path: string, line: string) => path === 'lib/site.ts' && line.startsWith('export const THEME_COLOR =')
    // The confirmation email styles inline for mail clients, so its colors live in lib/waitlistEmail.ts.
    const paths = [...components, ...files('app', (p) => !p.endsWith('.css') && !brandAsset(p) && !image(p)), ...files('lib', (p) => code(p) && p !== join('lib', 'waitlistEmail.ts'))]
    expect(offenders(paths, hex, themeColorLine)).toEqual([])
    expect(offenders(files('content', () => true), contentHex)).toEqual([])
  })

  it('keeps color functions and Tailwind palette colors out of components, pages, lib and content', () => {
    const paths = [...components, ...pages, ...files('lib', code), ...files('content', () => true)]
    expect(offenders(paths, colorFunction)).toEqual([])
    expect(offenders(paths, palette)).toEqual([])
  })

  it('gives the browser chrome the canvas color', () => {
    expect(globals.match(/--color-canvas:\s*(#[0-9a-f]+);/i)?.[1]).toBe(THEME_COLOR)
  })

  it('uses no arbitrary Tailwind values', () => {
    const paths = [...components, ...pages]
    // -[value], -(--var) and -(type:value), [prop:value], [&...] variants, /[alpha] and /(--alpha) modifiers.
    expect(offenders(paths, /-\[|-\(|(?<![\w\])])\[[a-z-]+:[^\s\]]+\]|\[&|\/\[|\/\(--/)).toEqual([])
  })

  it('takes spacing from the scale or a documented control size', () => {
    const paths = [...components, ...pages]
    const off = paths.flatMap((path) =>
      readFileSync(join(root, path), 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          [...line.matchAll(spacingUtility)].filter((m) => !SPACING.has(m[1]!)).map((m) => `${path}:${i + 1}: ${m[0]}`)
        )
    )
    expect(off).toEqual([])
  })

  it('names widths, layers, radii and motion with tokens', () => {
    const paths = [...components, ...pages]
    expect(offenders(paths, /(?<![\w-])max-w-(?:\d|\d*xl\b|xs\b|sm\b|md\b|lg\b)/), 'max-w-<number or size>: add a --container-* token').toEqual([])
    expect(offenders(paths, /(?<![\w-])-?z-\d/), 'z-<number>: add a --z-index-* token').toEqual([])
    expect(offenders(paths, /(?<![\w-])rounded(?:-[a-z]+)?-(?:full|none)\b/), 'use rounded-pill or a --radius-* token').toEqual([])
    expect(offenders(paths, new RegExp(`-(?:${colorNames.join('|')})/\\d`)), 'opacity modifier: add a color token').toEqual([])
    expect(offenders(paths, /(?<![\w-])(?:duration|delay)-\d/), 'duration-<number>: use a --duration-* token').toEqual([])
    expect(offenders(paths, /(?<![\w-])ease-(?:in|out|linear)/)).toEqual([])
    expect(offenders(paths, /(?<![\w-])(?:inset-|drop-)?shadow(?:-[\w/]+)?(?=["'`\s])/), 'no shadows: hairlines instead').toEqual([])
    // Static inline styles are out; a style computed at runtime (a measured height, a delay) has no class to name.
    expect(offenders(paths, /style=\{\{[^}]*:\s*['"\d]/), 'inline styles').toEqual([])
  })

  it('keeps raw values in globals.css inside @theme', () => {
    expect(cssOffenders(hex, (line) => line.includes('mask')), 'hex outside @theme').toEqual([])
    expect(cssOffenders(/font-size:\s*[\d.]+px/), 'px font size outside @theme').toEqual([])
    expect(cssOffenders(/(?:transition|animation)[\w-]*:[^;]*(?<![\w-])\d*\.?\d+m?s\b/), 'literal duration outside @theme').toEqual([])
  })

  it('has no em or en dashes in user facing text', () => {
    const paths = [...files('components', () => true), ...files('content', () => true), ...files('app', (p) => !image(p))]
    expect(offenders(paths, /[–—]/)).toEqual([])
  })
})
