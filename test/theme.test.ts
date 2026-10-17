import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
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
  it('a container edge or row divider stays visibly apart from the fill it sits on, in both themes (KERNEL-1038)', () => {
    // Hairlines are not text, so 3:1 is out of reach. 1.1:1 is about the smallest step the eye still sees on a dark panel; panel-line on surface was 1.0 in dark and the dividers vanished.
    const MIN_EDGE = 1.1
    const pairs = [['card-bg', 'card-line'], ['surface', 'card-line'], ['panel', 'pill-line']]
    const fails = themes(both).flatMap(([name, theme]) => pairs.flatMap(([fill, line]) => {
      const c = contrast(theme[line], theme[fill])
      return c < MIN_EDGE ? [`${name} ${line} on ${fill}: ${c.toFixed(2)}`] : []
    }))
    expect(fails).toEqual([])
  })
  it('the focus ring reaches 3:1 on every surface in both themes', () => {
    const fails: string[] = []
    for (const [name, body] of [['light', block("[data-theme='light']")], ['dark', block(":root, [data-theme='dark']")]] as const)
      for (const s of SURFACES) { const theme = name === 'light' ? light : dark; const c = contrast(over(ringOf(body), theme[s]), theme[s]); if (c < 3) fails.push(`${name} focus on ${s}: ${c.toFixed(2)}`) }
    expect(fails).toEqual([])
  })
  it('a hover card muted status word reaches 4.5:1 on its pill in both themes', () => {
    const fails: string[] = []
    for (const [name, theme] of themes(both)) for (const t of ['muted'])
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
type Kind = 'addDel' | 'btnHeight' | 'checkbox' | 'curve' | 'duration' | 'faintText' | 'fontSize' | 'fontWeight' | 'focusRing' | 'inlineStyle' | 'lineBackground' | 'lineHeight' | 'pillLine' | 'radius' | 'shadow' | 'unknownVar' | 'unusedToken' | 'zIndex'
interface Hit { kind: Kind; line: number; text: string }

/** A file with its comments blanked out, line breaks kept, so a duration in a comment isn't a hit and line numbers still match. */
const blank = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length
const sample = (text: string, line: number) => (text.split('\n')[line - 1] ?? '').trim().slice(0, 100)
/** One hit per kind and line, whatever number of values the line holds (a token is one hit each, see unusedTokenHits). */
function collect(text: string, found: [Kind, number][]): Hit[] {
  const seen = new Set<string>()
  const out: Hit[] = []
  for (const [kind, index] of found) {
    const line = lineOf(text, index)
    if (seen.has(`${kind}:${line}`)) continue
    seen.add(`${kind}:${line}`)
    out.push({ kind, line, text: sample(text, line) })
  }
  return out
}
const noVars = (v: string) => v.replace(/var\([^)]*\)/g, ' ')

/** A literal font size, weight, unitless line height, z-index, duration or curve in a stylesheet. Not for tokens.css. */
export function cssHits(source: string): Hit[] {
  const text = blank(source)
  const found: [Kind, number][] = []
  for (const m of text.matchAll(/(?<![\w-])(font-size|font-weight|line-height|z-index|font|transition(?:-duration|-delay)?|animation(?:-duration|-delay)?)\s*:\s*([^;{}]*)/g)) {
    const [, prop, raw] = m
    const v = noVars(raw)
    const at = m.index
    if (prop === 'font-size' && /^\s*-?[0-9.]+(px|rem|em|pt)\b/.test(v)) found.push(['fontSize', at])
    else if (prop === 'font-weight' && /^\s*(\d{3}|bold|bolder|lighter)\b/.test(v)) found.push(['fontWeight', at])
    else if (prop === 'line-height' && /^\s*[0-9.]+\s*(!important)?\s*$/.test(v)) found.push(['lineHeight', at])
    else if (prop === 'z-index' && /^\s*-?\d{2,}\b/.test(v)) found.push(['zIndex', at])
    else if (prop === 'font') {
      if (/(?<![\w./-])[0-9.]+(px|rem|em|pt)\b/.test(v)) found.push(['fontSize', at])
      if (/^\s*(\d{3}|bold|bolder|lighter)\s/.test(v)) found.push(['fontWeight', at])
      if (/\/\s*[0-9.]+(?![0-9.]|px|rem|em|%)/.test(v)) found.push(['lineHeight', at])
    } else if (/^(transition|animation)/.test(prop) && /(?<![\w.-])(?!0s\b|0\.001ms\b)[0-9]*\.?[0-9]+m?s\b/.test(v)) found.push(['duration', at])
  }
  for (const m of text.matchAll(/cubic-bezier\(/g)) found.push(['curve', m.index])
  return collect(text, found)
}

const STOCK_BTN_HEIGHTS = ['24px', '26px', '28px', '32px']
// Where --add and --del may be spelled: error text, a result or state that is green or red, the diff and a file's letter (DESIGN.md, Color).
const ADD_DEL_ALLOWED = ['[data-tone', '[data-state', '[data-ok', '[data-mark', '-error', '.err', '.step-bad', '.ob-ico', '.ae-diff .add', '.ae-diff .del']
// A faint color is for what isn't read: a disabled control, an icon, a separator or a close mark.
const FAINT_NON_TEXT = /svg|:disabled|\[aria-disabled|-sep\b|\.sep\b|-dot\b|-ico(?:n)?\b|-x\b/
// Rows and boxes whose own outline is off because the row or the box draws the --focus ring.
const FOCUS_ON_ANCESTOR = ['.rm-link', '.prs-main', '.lp-open', '.cmp-input']

/** Every rule in a stylesheet with its selector, its body and where it starts. */
function rulesOf(source: string): { selector: string; body: string; at: number }[] {
  return [...blank(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2], at: m.index + m[0].indexOf(m[1].trim()) }))
}
const declsOf = (body: string) => [...body.matchAll(/(?<![\w-])([\w-]+)\s*:\s*([^;]*)/g)].map((m) => [m[1], m[2].trim()] as const)
const withoutTokenCalc = (v: string) => v.replace(/calc\(\s*var\([^)]*\)\s*[-+]\s*[0-9.]+px\s*\)/g, ' ')

/** Token roles in a stylesheet: --pill-line without --r-pill, a line token as a fill, faint or add or del out of their role, a literal radius, a shadow, a .btn height that isn't stock, a focus outline that isn't --focus. */
export function roleHits(source: string, { tokens = false }: { tokens?: boolean } = {}): Hit[] {
  const found: [Kind, number][] = []
  for (const { selector, body, at } of rulesOf(source)) {
    if (selector.startsWith('@')) continue
    const decls = declsOf(body)
    if (/var\(--pill-line\)/.test(body) && !/var\(--r-pill\)/.test(body)) found.push(['pillLine', at])
    if (!tokens && /var\(--(?:add|del)\)/.test(body) && !ADD_DEL_ALLOWED.some((a) => selector.includes(a))) found.push(['addDel', at])
    if (!tokens && /\.btn\b/.test(selector) && decls.some(([prop, v]) => /^(?:min-|max-)?height$/.test(prop) && !STOCK_BTN_HEIGHTS.includes(v))) found.push(['btnHeight', at])
    if (/:focus-visible/.test(selector)) for (const [prop, v] of decls) {
      if (/^outline(?:-color)?$/.test(prop) && !v.includes('var(--focus)')) found.push(['focusRing', at])
      if (prop === 'outline-style' && !FOCUS_ON_ANCESTOR.some((a) => selector.includes(a))) found.push(['focusRing', at])
    }
    for (const [prop, v] of decls) {
      if (/^background(?:-color)?$/.test(prop) && /var\(--(?:line|line-2|panel-line)\)/.test(v) && !/(?:^|[;\s])(?:width|height)\s*:\s*1px/.test(body)) found.push(['lineBackground', at])
      if (prop === 'color' && /var\(--faint\)/.test(v) && !FAINT_NON_TEXT.test(selector)) found.push(['faintText', at])
      if (prop === 'box-shadow' && !/^none\b/.test(v)) found.push(['shadow', at])
      if (!tokens && prop === 'border-radius' && /[0-9.]+(?:px|rem|em|%)/.test(noVars(withoutTokenCalc(v))) && !/^(?:0(?:px)?|50%)(?:\s+(?:0(?:px)?|50%))*$/.test(v)) found.push(['radius', at])
    }
  }
  return collect(blank(source), found)
}

/** A literal type, color or spacing value in an inline style, or a raw checkbox. `rel` is the file's path from the repo root. */
export function tsxHits(rel: string, source: string): Hit[] {
  const found: [Kind, number][] = []
  const prop = /(?:^|,)\s*(fontSize|fontWeight|lineHeight|color|background\w*|gap|margin\w*|padding\w*|border\w*)\s*:\s*(-?[0-9.]+|'[^']*'|"[^"]*")\s*(?=,|$)/g
  for (const m of source.matchAll(/style=\{\{([^{}]*)\}\}/g)) {
    if ([...m[1].matchAll(prop)].some((p) => !p[2].includes('var('))) found.push(['inlineStyle', m.index])
  }
  if (!rel.startsWith('src/renderer/src/ui/'))
    for (const m of source.matchAll(/<input\b(?:[^>]|=>)*?\btype=["']checkbox["']/g)) found.push(['checkbox', m.index])
  return collect(source, found)
}

/** Every `var(--x)` in `source` that `defined` doesn't have. */
export function unknownVarHits(source: string, defined: Set<string>): Hit[] {
  return collect(source, [...source.matchAll(/var\((--[\w-]+)/g)].filter((m) => !defined.has(m[1])).map((m) => ['unknownVar', m.index] as [Kind, number]))
}

/** Names a file declares (`--x:`), and names it quotes (`'--x'`, set or read from script). */
const declared = (text: string) => [...text.matchAll(/(?<![\w-])(--[\w-]+)\s*:/g), ...text.matchAll(/['"`](--[\w-]+)['"`]/g)].map((m) => m[1])

/** Every token `tokens` declares that `usage` never reads. The terminal reads its palette by a built name and the scrollbar transitions --scroll-thumb by name. */
export function unusedTokenHits(tokens: string, usage: string): Hit[] {
  const text = blank(tokens)
  const names = [...new Set(declared(text).filter((n) => text.includes(`${n}:`)))]
  const unused = names.filter((n) => !n.startsWith('--term-') && n !== '--scroll-thumb' && !new RegExp(`var\\(${n}(?![\\w-])`).test(usage) && !new RegExp(`['"\`]${n}['"\`]`).test(usage))
  return unused.map((n) => {
    const line = lineOf(text, text.search(new RegExp(`(?<![\\w-])${n}\\s*:`)))
    return { kind: 'unusedToken' as const, line, text: n }
  })
}

describe('design tokens beyond color', () => {
  const src = join(root, 'src/renderer/src')
  const all = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? all(p) : /\.(tsx?|css)$/.test(e.name) ? [p] : []
  })
  const rel = (f: string) => f.slice(root.length + 1).split(sep).join('/')
  const files = all(src).map((f) => ({ path: rel(f), text: readFileSync(f, 'utf8') }))
  const everything = files.map((f) => f.text).join('\n')

  /** Violations per file. A file with none is left out. */
  function measure(): Record<string, Hit[]> {
    const defined = new Set(declared(everything))
    const out: Record<string, Hit[]> = {}
    for (const f of files) {
      const hits: Hit[] = []
      if (f.path.endsWith('.css') && !f.path.endsWith('/tokens.css')) hits.push(...cssHits(f.text))
      if (f.path.endsWith('.css')) hits.push(...roleHits(f.text, { tokens: f.path.endsWith('/tokens.css') }))
      if (f.path.endsWith('.tsx')) hits.push(...tsxHits(f.path, f.text))
      hits.push(...unknownVarHits(blank(f.text), defined))
      if (f.path.endsWith('/tokens.css')) hits.push(...unusedTokenHits(f.text, everything))
      if (hits.length) out[f.path] = hits
    }
    return out
  }

  it('no file has a literal type, layer or motion value, a literal inline style, a raw checkbox, an unknown var() or an unused token', () => {
    const lines = Object.entries(measure()).map(([f, hits]) => `${f}\n${hits.map((h) => `    :${h.line} ${h.kind} ${h.text}`).join('\n')}`)
    // One string, so the runner prints every file in full instead of "[ …(2) ]".
    expect(lines.join('\n'), 'use a token, a class, or add the value to tokens.css').toBe('')
  })

  it('tokens.css itself is the only place a value is spelled out: every other file passes through the checks above', () => {
    expect(files.some((f) => f.path.endsWith('/tokens.css'))).toBe(true)
    expect(measure()['src/renderer/src/tokens.css']?.filter((h) => h.kind !== 'unusedToken' && h.kind !== 'unknownVar') ?? []).toEqual([])
  })
})

describe('each design token check fails on an injected violation', () => {
  const kinds = (hits: Hit[]) => hits.map((h) => h.kind)
  it('a literal font size, in font-size or in the font shorthand', () => {
    expect(kinds(cssHits('.a { font-size: 13px; }'))).toEqual(['fontSize'])
    expect(kinds(cssHits('.a { font: 11.5px var(--mono); }'))).toEqual(['fontSize'])
    expect(cssHits('.a { font-size: var(--fs-ui); font: var(--fs-code)/20px var(--mono); font-size: inherit; }')).toEqual([])
  })
  it('a literal weight', () => {
    expect(kinds(cssHits('.a { font-weight: 500; }'))).toEqual(['fontWeight'])
    expect(kinds(cssHits('.a { font: 600 var(--fs-ui) var(--font); }'))).toEqual(['fontWeight'])
    expect(cssHits('.a { font-weight: var(--fw-medium); }')).toEqual([])
  })
  it('a unitless line height, and not a px one', () => {
    expect(kinds(cssHits('.a { line-height: 1.5; }'))).toEqual(['lineHeight'])
    expect(kinds(cssHits('.a { font: var(--fs-meta)/1.6 var(--mono); }'))).toEqual(['lineHeight'])
    expect(cssHits('.a { line-height: 20px; font: var(--fs-code)/20px var(--mono); line-height: var(--lh); }')).toEqual([])
  })
  it('a z-index of two digits or more, and not one that orders siblings', () => {
    expect(kinds(cssHits('.a { z-index: 65; }'))).toEqual(['zIndex'])
    expect(cssHits('.a { z-index: 2; } .b { z-index: var(--z-modal); }')).toEqual([])
  })
  it('a literal duration, delay or curve', () => {
    expect(kinds(cssHits('.a { transition: opacity 0.12s; }'))).toEqual(['duration'])
    expect(kinds(cssHits('.a { animation: spin 1.2s linear infinite; }'))).toEqual(['duration'])
    expect(kinds(cssHits('.a { transition-delay: 80ms; }'))).toEqual(['duration'])
    expect(kinds(cssHits('.a { transition: opacity var(--dur-fast) cubic-bezier(0.4, 0, 1, 1); }'))).toEqual(['curve'])
    expect(cssHits('.a { transition: opacity var(--dur-fast) var(--ease-out); animation-duration: 0.001ms; transition-duration: 0s; }')).toEqual([])
  })
  it('a value inside a comment is not a violation, and its line number holds', () => {
    expect(cssHits('/* font-size: 13px; 120ms */\n.a { font-size: 13px; }')).toEqual([{ kind: 'fontSize', line: 2, text: '.a { font-size: 13px; }' }])
  })
  it('a literal type, color or spacing in an inline style', () => {
    const kindsOf = (code: string) => kinds(tsxHits('src/renderer/src/screens/A.tsx', code))
    expect(kindsOf('<div style={{ fontSize: 12 }} />')).toEqual(['inlineStyle'])
    expect(kindsOf("<div style={{ color: 'var(--muted)', gap: 6 }} />")).toEqual(['inlineStyle'])
    expect(kindsOf("<div style={{ padding: '4px 8px' }} />")).toEqual(['inlineStyle'])
    expect(kindsOf("<div style={{\n  marginTop: 10\n}} />")).toEqual(['inlineStyle'])
    expect(kindsOf("<div style={{ color: 'var(--muted)', width: 120, transform: `translateX(${x}px)` }} />")).toEqual([])
  })
  it('a raw checkbox outside ui/', () => {
    expect(kinds(tsxHits('src/renderer/src/screens/A.tsx', '<input type="checkbox" checked={on} onChange={() => set(!on)} />'))).toEqual(['checkbox'])
    expect(kinds(tsxHits('src/renderer/src/screens/A.tsx', '<input\n  onChange={(e) => set(e.target.checked)}\n  type="checkbox"\n/>'))).toEqual(['checkbox'])
    expect(tsxHits('src/renderer/src/ui/controls.tsx', '<input type="checkbox" />')).toEqual([])
    expect(tsxHits('src/renderer/src/screens/A.tsx', '<input type="text" />')).toEqual([])
  })
  it('a token used outside its role, a literal radius, a shadow, a stray .btn height or a focus ring that is not --focus', () => {
    const kindsOf = (css: string) => kinds(roleHits(css))
    expect(kindsOf('.a { border: 1px solid var(--pill-line); border-radius: var(--r); }')).toEqual(['pillLine'])
    expect(roleHits('.a { border: 1px solid var(--pill-line); border-radius: var(--r-pill); }')).toEqual([])
    expect(kindsOf('.a { height: 8px; background: var(--line-2); }')).toEqual(['lineBackground'])
    expect(kindsOf('.a { background: var(--panel-line); }')).toEqual(['lineBackground'])
    expect(roleHits('.a { height: 1px; background: var(--line-2); } .b { border-top: 1px solid var(--line-2); }')).toEqual([])
    expect(kindsOf('.a { color: var(--faint); } .b svg { color: var(--faint); } .c:disabled { color: var(--faint); }')).toEqual(['faintText'])
    expect(kindsOf('.a { color: var(--add); } .a-error { color: var(--del); }')).toEqual(['addDel'])
    expect(kindsOf('.a { border-radius: 6px; } .b { border-radius: var(--r-sm) 0 0 calc(var(--r-sm) - 1px); } .c { border-radius: 50%; }')).toEqual(['radius'])
    expect(kindsOf('.a { box-shadow: 0 1px 2px red; } .b { box-shadow: none; }')).toEqual(['shadow'])
    expect(kindsOf('.btn.x { height: 30px; } .btn.y { height: 24px; } .btn.z { height: 28px; }')).toEqual(['btnHeight'])
    expect(kindsOf('.a:focus-visible { outline: none; }\n.b:focus-visible { outline: 2px solid var(--ink); }\n.c:focus-visible { outline: 2px solid var(--focus); }\n.rm-link:focus-visible { outline-style: none; }\n.d:focus-visible { outline-style: none; }')).toEqual(['focusRing', 'focusRing', 'focusRing'])
  })
  it('a var() that names no token', () => {
    const defined = new Set(['--ink'])
    expect(kinds(unknownVarHits('.a { color: var(--ink); background: var(--inkk); }', defined))).toEqual(['unknownVar'])
    expect(unknownVarHits('.a { color: var(--ink); }', defined)).toEqual([])
  })
  it('a token nothing uses', () => {
    const tokens = ':root { --used: 1px; --orphan: 2px; --term-red: #f00; }'
    expect(unusedTokenHits(tokens, '.a { margin: var(--used); }').map((h) => h.text)).toEqual(['--orphan'])
    expect(kinds(unusedTokenHits(':root { --a: 1px; --b: 2px; }', ''))).toEqual(['unusedToken', 'unusedToken'])
    expect(unusedTokenHits(tokens, '.a { margin: var(--used) var(--orphan); }')).toEqual([])
    expect(unusedTokenHits(':root { --a: 1px; }', "setProperty('--a', '2px')")).toEqual([])
  })
})
