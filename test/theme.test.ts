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

// KERNEL-29: light theme rules. KERNEL-575: the text ladder.
const root = join(__dirname, '..')
const tokensCss = readFileSync(join(root, 'src/renderer/src/tokens.css'), 'utf8')

/** The text between the braces of the first rule in `css` that starts with `selector`. */
function block(selector: string, css = tokensCss): string {
  const open = css.indexOf('{', css.indexOf(selector))
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error(`no rule for ${selector}`)
}
/** The `--name: #hex` declarations of a rule body. */
const hexes = (body: string): Record<string, string> => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2].toLowerCase()]))
const tokens = (selector: string, css = tokensCss) => hexes(block(selector, css))
/** `--focus: rgba(r, g, b, a)` of a rule body. */
const ringOf = (body: string): number[] => (/--focus:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(body) ?? []).slice(1).map(Number)
/** A translucent color laid over an opaque hex, as the browser paints it. */
const over = ([r, g, b, a]: number[], bg: string) => '#' + [r, g, b].map((v, i) => Math.round(v * a + parseInt(bg.slice(1 + i * 2, 3 + i * 2), 16) * (1 - a)).toString(16).padStart(2, '0')).join('')
const channel = (h: string, i: number) => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const lum = (h: string) => 0.2126 * channel(h, 1) + 0.7152 * channel(h, 3) + 0.0722 * channel(h, 5)
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

const SURFACES = ['canvas', 'panel', 'surface', 'surface-2', 'surface-3', 'hover', 'card-bg', 'code-bg', 'input-bg', 'aside']
// Where an input or a card sits. Hover is a fill that comes and goes, so it is left out of the border checks.
const BORDERED = SURFACES.filter((s) => s !== 'hover')
const TIERS = ['ink', 'ink-2', 'ink-3', 'muted']
const LADDER = [...TIERS, 'faint']
const STATUS = ['add', 'del', 'mod', 'merged', 'needs']
const TERM = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].map((n) => `term-${n}`)
// Pairs allowed under AA. Empty since KERNEL-611 moved dark del up to pass on hover.
const BELOW_AA = new Set<string>()
const GAP = 1.35

type Theme = Record<string, string>
const themes = (t: { light: Theme; dark: Theme }) => [['light', t.light], ['dark', t.dark]] as const
/** `name on surface: ratio` for every pair under `min`. */
function under(name: string, theme: Theme, fgs: string[], surfaces: string[], min: number, note = '') {
  const fails: string[] = []
  for (const fg of fgs) for (const s of surfaces) {
    const c = contrast(theme[fg], theme[s])
    if (c < min && !BELOW_AA.has(`${name} ${fg} on ${s}`)) fails.push(`${name}${note} ${fg} on ${s}: ${c.toFixed(2)}`)
  }
  return fails
}

describe('theme contrast', () => {
  const light = tokens("[data-theme='light']")
  const dark = tokens(":root, [data-theme='dark']")
  const both = { light, dark }
  it('every text tier and status color reaches 4.5:1 on every surface in both themes', () => {
    const fails = themes(both).flatMap(([name, theme]) => under(name, theme, [...TIERS, ...STATUS], SURFACES, 4.5))
    expect(fails).toEqual([])
  })
  it('light danger and the terminal colors reach 4.5:1 on every surface, dark terminal colors on the main ones', () => {
    const main = ['canvas', 'panel', 'surface', 'surface-2', 'code-bg', 'aside']
    expect([...under('light', light, ['danger', ...TERM], SURFACES, 4.5), ...under('dark', dark, TERM.filter((n) => n !== 'term-black'), main, 4.5)]).toEqual([])
  })
  it('faint is non-text and reaches 3:1 on every surface in both themes', () => {
    expect(themes(both).flatMap(([name, theme]) => under(name, theme, ['faint'], SURFACES, 3))).toEqual([])
  })
  it('adjacent tiers differ by at least 1.35x in contrast on every surface in both themes', () => {
    const fails: string[] = []
    for (const [name, theme] of themes(both)) for (const s of SURFACES) LADDER.slice(1).forEach((lower, i) => {
      const gap = contrast(theme[LADDER[i]], theme[s]) / contrast(theme[lower], theme[s])
      if (gap < GAP) fails.push(`${name} ${LADDER[i]} over ${lower} on ${s}: ${gap.toFixed(2)}x`)
    })
    expect(fails).toEqual([])
  })
  it('the dark neutrals are grey with a slight cool lean: red equals green, blue 0 to 3 above (KERNEL-611)', () => {
    const rgb = (v: string) => [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16))
    const lean = Object.entries(dark).filter(([k, v]) => {
      if (![...SURFACES, 'hover', 'aside', ...LADDER, 'line', 'line-2', 'line-3', 'line-4', 'input-line'].includes(k)) return false
      const [r, g, b] = rgb(v)
      return r !== g || b - r < 0 || b - r > 3
    })
    expect(lean).toEqual([])
  })
  it('an input border reaches 3:1 on every surface it sits on, and line-2 stays a hairline', () => {
    expect(themes(both).flatMap(([name, theme]) => under(name, theme, ['input-line'], BORDERED, 3))).toEqual([])
    for (const theme of [light, dark]) expect(contrast(theme['line-2'], theme.panel)).toBeLessThan(1.5)
  })
  it('the focus ring reaches 3:1 on every surface in both themes', () => {
    const fails: string[] = []
    for (const [name, body] of [['light', block("[data-theme='light']")], ['dark', block(":root, [data-theme='dark']")]] as const)
      for (const s of SURFACES) { const theme = name === 'light' ? light : dark; const c = contrast(over(ringOf(body), theme[s]), theme[s]); if (c < 3) fails.push(`${name} focus on ${s}: ${c.toFixed(2)}`) }
    expect(fails).toEqual([])
  })
  it('status words reach 4.5:1 on their tint in both themes', () => {
    const fails: string[] = []
    for (const [name, theme] of themes(both)) for (const t of ['add', 'del', 'muted'])
      if (contrast(theme[t], theme[`tint-${t}`]) < 4.5) fails.push(`${name} ${t} on tint-${t}: ${contrast(theme[t], theme[`tint-${t}`]).toFixed(2)}`)
    expect(fails).toEqual([])
  })
  it('solid buttons keep readable labels in light', () => {
    expect(contrast(light['on-solid'], light.danger)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light['on-solid'], light['merged-solid'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light['on-ink'], light.ink)).toBeGreaterThanOrEqual(4.5)
  })
  it('PR header bands keep their label, link and button text readable in both themes', () => {
    const fails: string[] = []
    for (const [name, theme] of themes(both)) for (const t of ['merged', 'ready', 'fail']) {
      for (const fg of ['text', 'fg']) for (const bg of ['band', 'soft']) {
        const c = contrast(theme[`pr-${t}-${fg}`], theme[`pr-${t}-${bg}`])
        if (c < 4.5) fails.push(`${name} pr-${t}-${fg} on pr-${t}-${bg}: ${c.toFixed(2)}`)
      }
      if (theme[`pr-${t}-solid`] && contrast('#ffffff', theme[`pr-${t}-solid`]) < 4.5) fails.push(`${name} white on pr-${t}-solid`)
    }
    expect(fails).toEqual([])
  })
  it('plan mode blue reads as text and carries its button label in both themes', () => {
    for (const theme of [light, dark]) {
      expect(contrast(theme['on-plan'], theme.plan)).toBeGreaterThanOrEqual(4.5)
      for (const s of ['panel', 'input-bg']) expect(contrast(theme.plan, theme[s])).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('every token exists in both themes', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort())
  })
})

// Increase contrast: the same checks on the values the media block sets, laid over the normal theme.
describe('prefers-contrast: more', () => {
  const media = block('@media (prefers-contrast: more)')
  const lightBody = block("[data-theme='light']", media)
  const darkBody = block(":root, [data-theme='dark']", media)
  const normal = { light: tokens("[data-theme='light']"), dark: tokens(":root, [data-theme='dark']") }
  const more = { light: { ...normal.light, ...hexes(lightBody) }, dark: { ...normal.dark, ...hexes(darkBody) } }
  const bodies = { light: lightBody, dark: darkBody }
  const LINES = ['line', 'line-2', 'line-3', 'line-4', 'input-line', 'panel-line', 'card-line', 'chip-line', 'pill-line']
  const DIVIDERS = ['line', 'panel-line']
  it('sets the same tokens in both themes', () => {
    expect(Object.keys(hexes(lightBody)).sort()).toEqual(Object.keys(hexes(darkBody)).sort())
    expect(ringOf(lightBody)).toHaveLength(4)
    expect(ringOf(darkBody)).toHaveLength(4)
  })
  it('moves every text tier up one step, with ink at full black or white', () => {
    const fails: string[] = []
    for (const [name, theme] of themes(more)) {
      const was = normal[name]
      if (theme.ink !== (name === 'dark' ? '#ffffff' : '#000000')) fails.push(`${name} ink is ${theme.ink}`)
      LADDER.slice(1).forEach((tier, i) => {
        if (contrast(theme[tier], theme.panel) < contrast(was[LADDER[i]], was.panel)) fails.push(`${name} ${tier} is below the normal ${LADDER[i]}`)
      })
    }
    expect(fails).toEqual([])
  })
  it('every text tier, faint included, reaches 4.5:1 on every surface, and the status colors still do', () => {
    expect(themes(more).flatMap(([name, theme]) => under(name, theme, [...LADDER, ...STATUS], SURFACES, 4.5, ' more'))).toEqual([])
  })
  it('keeps the tiers in order', () => {
    const fails: string[] = []
    for (const [name, theme] of themes(more)) LADDER.slice(1).forEach((tier, i) => { if (contrast(theme[tier], theme.panel) > contrast(theme[LADDER[i]], theme.panel)) fails.push(`${name} ${tier} is above ${LADDER[i]}`) })
    expect(fails).toEqual([])
  })
  it('strengthens every line: dividers reach 2:1, the rest 3:1, and line-4 and the input border 4.5:1', () => {
    const fails: string[] = []
    for (const [name, theme] of themes(more)) for (const l of LINES) {
      const min = DIVIDERS.includes(l) ? 2 : ['line-4', 'input-line'].includes(l) ? 4.5 : 3
      if (contrast(theme[l], theme.panel) <= contrast(normal[name][l], normal[name].panel)) fails.push(`${name} ${l} is no stronger than normal`)
      for (const s of DIVIDERS.includes(l) ? ['panel'] : BORDERED) if (contrast(theme[l], theme[s]) < min) fails.push(`${name} ${l} on ${s}: ${contrast(theme[l], theme[s]).toFixed(2)}`)
    }
    expect(fails).toEqual([])
  })
  it('makes the focus ring stronger and keeps it above 4.5:1 on every surface', () => {
    const fails: string[] = []
    for (const [name, theme] of themes(more)) for (const s of SURFACES) {
      const ring = contrast(over(ringOf(bodies[name]), theme[s]), theme[s])
      const was = contrast(over(ringOf(block(name === 'light' ? "[data-theme='light']" : ":root, [data-theme='dark']")), theme[s]), theme[s])
      if (ring < 4.5 || ring <= was) fails.push(`${name} focus on ${s}: ${ring.toFixed(2)} (was ${was.toFixed(2)})`)
    }
    expect(fails).toEqual([])
  })
})

describe('no hardcoded colors', () => {
  // The character shirt, skin and hair colors are art, not UI chrome.
  const looks = join(root, 'src/renderer/src/screens/agent/looks.ts')
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return files(p)
    return /\.(tsx?|css)$/.test(e.name) && e.name !== 'tokens.css' && p !== looks ? [p] : []
  })
  it('renderer code uses tokens, except tokens.css and the shirt colors in looks.ts', () => {
    const hits: string[] = []
    for (const f of files(join(root, 'src/renderer/src'))) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (/#[0-9a-fA-F]{3,8}\b(?![\w-])|\brgba?\(|\bhsla?\(/.test(line.replace(/\b(?:error|PR) #\d+/g, ''))) hits.push(`${f.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 80)}`) })
    }
    expect(hits).toEqual([])
  })
})

// KERNEL-681: type sizes, weights, line heights, layers and motion come from tokens.css too, and so do the type, color and spacing of
// an inline style. A value that isn't a token yet becomes one in tokens.css (DESIGN.md), never a literal in a screen.
describe('design tokens beyond color', () => {
  const src = join(root, 'src/renderer/src')
  const all = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? all(p) : /\.(tsx?|css)$/.test(e.name) ? [p] : []
  })
  const files = all(src)
  const rel = (f: string) => f.slice(root.length + 1)
  /** A CSS file with its comments blanked out, line breaks kept, so a duration in a comment isn't a hit and line numbers still match. */
  const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const css = files.filter((f) => f.endsWith('.css') && !f.endsWith('tokens.css')).map((f) => [f, code(f)] as const)
  const scan = (list: (readonly [string, string])[], test: (line: string) => boolean) =>
    list.flatMap(([f, text]) => text.split('\n').flatMap((line, i) => (test(line) ? [`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`] : [])))
  const decls = (line: string, prop: RegExp) => [...line.matchAll(new RegExp(`(?<![\\w-])(?:${prop.source})\\s*:\\s*([^;{}]*)`, 'g'))].map((m) => m[1])

  it('font sizes are --fs tokens', () => {
    expect(scan(css, (l) => decls(l, /font-size/).some((v) => /^-?[0-9.]+(px|rem|em)/.test(v.trim()))
      || decls(l, /font/).some((v) => /\b[0-9.]+(px|rem|em)\b/.test(v.replace(/\/[0-9.]+px/g, ''))))).toEqual([])
  })
  it('weights are --fw tokens', () => {
    expect(scan(css, (l) => decls(l, /font-weight/).some((v) => /^\s*\d/.test(v)) || decls(l, /font/).some((v) => /^\s*\d{3}\b/.test(v)))).toEqual([])
  })
  it('unitless line heights are --lh tokens, px ones sit with the control height they centre in', () => {
    expect(scan(css, (l) => decls(l, /line-height/).some((v) => /^\s*[0-9.]+\s*(!important)?\s*$/.test(v)) || decls(l, /font/).some((v) => /\/[0-9.]+(?![0-9.]*px)/.test(v)))).toEqual([])
  })
  it('a layer over other components is a --z token; 1 to 9 order siblings inside one component', () => {
    expect(scan(css, (l) => decls(l, /z-index/).some((v) => /^\s*\d{2,}/.test(v)))).toEqual([])
  })
  it('durations and curves are --dur and --ease tokens', () => {
    const motion = /transition(?:-duration|-delay|-timing-function)?|animation(?:-duration|-delay|-timing-function)?/
    expect(scan(css, (l) => /cubic-bezier\(/.test(l) || decls(l, motion).some((v) => /(?<![\w.-])(?!0s\b|0\.001ms\b)[0-9]*\.?[0-9]+m?s\b/.test(v)))).toEqual([])
  })
  it('an inline style holds no literal type, color or spacing: those are classes', () => {
    const tsx = files.filter((f) => f.endsWith('.tsx') && !f.endsWith('DevUi.tsx')).map((f) => [f, readFileSync(f, 'utf8')] as const)
    expect(scan(tsx, (l) => [...l.matchAll(/style=\{\{([^{}]*)\}\}/g)].some((m) =>
      /(?:^|,)\s*(fontSize|fontWeight|lineHeight|color|background\w*|gap|margin\w*|padding\w*|border\w*)\s*:\s*(-?[0-9.]+|'[^']*')\s*(?:,|$)/.test(m[1])))).toEqual([])
  })
  it('checkboxes and selects are the shared controls, outside ui/', () => {
    const tsx = files.filter((f) => f.endsWith('.tsx') && !rel(f).startsWith('src/renderer/src/ui/')).map((f) => [f, readFileSync(f, 'utf8')] as const)
    expect(scan(tsx, (l) => /<input[^>]*type="checkbox"|<select\b/.test(l))).toEqual([])
  })
  it('every var() names a custom property that is defined', () => {
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    const defined = new Set([...text.matchAll(/(--[\w-]+)\s*:/g), ...text.matchAll(/['"`](--[\w-]+)['"`]/g)].map((m) => m[1]))
    const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
      [...line.matchAll(/var\((--[\w-]+)/g)].filter((m) => !defined.has(m[1])).map((m) => `${rel(f)}:${i + 1}: ${m[1]}`)))
    expect(hits).toEqual([])
  })
  it('every token in tokens.css is used', () => {
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    const tokens = [...new Set([...tokensCss.matchAll(/(?<![\w-])(--[\w-]+)\s*:/g)].map((m) => m[1]))]
    // The terminal reads its palette by a built name (`--term-${n}`), and the scrollbar transitions --scroll-thumb by name.
    const unused = tokens.filter((t) => !t.startsWith('--term-') && t !== '--scroll-thumb' && !text.includes(`var(${t})`) && !text.includes(`var(${t},`) && !text.includes(`'${t}'`))
    expect(unused).toEqual([])
  })
})
