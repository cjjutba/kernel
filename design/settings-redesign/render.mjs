// Renders the settings canvas to PNGs: design/settings-redesign/canvas/<Board>.dc.html -> design/settings-redesign/<Board>.png (KERNEL-680).
// Like design/redesign/render.mjs, each board becomes plain HTML from its default props, but this one also fills <sc-for> lists and
// expands <dc-import> boards with their attributes as props, since the settings boards are built from shared page components.
// Usage: node design/settings-redesign/render.mjs [Board ...]   (no names renders every board on the Calm and All settings pages;
// the First pass page is superseded and has no PNG)
// Uses Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH or CHROME), with reduced motion.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = fileURLToPath(new URL('.', import.meta.url))
const canvas = join(here, 'canvas')
const source = (name) => readFileSync(join(canvas, `${name}.dc.html`), 'utf8')

/** The values a board's template reads, from its script, its declared defaults and the props it was given. */
function valuesOf(src, given) {
  const script = src.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>([\s\S]*?)<\/script>/)
  const decl = JSON.parse(script[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'"))
  const props = {}
  for (const [k, v] of Object.entries(decl)) if (!k.startsWith('$') && v && 'default' in v) props[k] = v.default
  class DCLogic { constructor(p) { this.props = p; this.state = {} } setState() {} }
  const Component = new Function('DCLogic', `${script[2]}; return Component`)(DCLogic)
  return { script: script[0], vals: new Component({ ...props, ...given }).renderVals() }
}

const lookup = (scope, expr) => {
  const e = expr.trim()
  if (e === 'true' || e === 'false') return e === 'true'
  if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e)
  return e.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope)
}

/** The end of the element that opens at `from`, counting nested elements of the same tag. */
function closeOf(html, tag, from) {
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g')
  re.lastIndex = from + 1
  let depth = 1
  for (let m; (m = re.exec(html));) {
    depth += m[0].startsWith('</') ? -1 : 1
    if (depth === 0) return { inner: m.index, end: m.index + m[0].length }
  }
  throw new Error(`unclosed <${tag}>`)
}

/** Fills one template with `scope`: lists, branches, then holes. Event handlers go, since the PNG is a still. */
function fill(html, scope) {
  let out = ''
  let at = 0
  const open = /<sc-(for|if)\b([^>]*)>/g
  for (let m; (m = open.exec(html));) {
    if (m.index < at) continue
    const tag = `sc-${m[1]}`
    const { inner, end } = closeOf(html, tag, m.index)
    out += holes(html.slice(at, m.index), scope)
    const body = html.slice(m.index + m[0].length, inner)
    const attr = (name) => (m[2].match(new RegExp(`${name}="\\{\\{([^}]*)\\}\\}"`)) ?? m[2].match(new RegExp(`${name}="([^"]*)"`)))?.[1]
    if (m[1] === 'if') { if (lookup(scope, attr('value'))) out += fill(body, scope) }
    else {
      const name = attr('as')
      for (const item of lookup(scope, attr('list')) ?? []) out += fill(body, { ...scope, [name]: item })
    }
    at = end
    open.lastIndex = end
  }
  return out + holes(html.slice(at), scope)
}
const holes = (html, scope) => html
  .replace(/\s+on[A-Z]\w*="\{\{[^}]*\}\}"/g, '')
  .replace(/\{\{([^}]*)\}\}/g, (_, expr) => { const v = lookup(scope, expr); return v == null || typeof v === 'function' ? '' : String(v) })

/** A board as plain HTML, with every imported board filled in place with its attributes as props. */
function render(name, given = {}) {
  const src = source(name)
  const { script, vals } = valuesOf(src, given)
  const body = src.match(/<x-dc>([\s\S]*)<\/x-dc>/)[1]
  const filled = fill(body, vals).replace(/<dc-import name="(\w+)"([^>]*)><\/dc-import>/g, (_, child, attrs) => {
    const props = Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].filter(([, k]) => !k.startsWith('hint-')).map(([, k, v]) => [k, v === 'true' ? true : v === 'false' ? false : v]))
    return render(child, props).replace(/<\/?helmet>/g, '')
  })
  return filled.replace(script, '')
}

const boards = JSON.parse(readFileSync(join(canvas, 'canvas.json'), 'utf8')).boards
const names = process.argv.slice(2)
const files = readdirSync(canvas).filter((f) => f.endsWith('.dc.html') && ['calm', 'all'].includes(boards[f]?.page)).map((f) => f.replace('.dc.html', '')).filter((n) => !names.length || names.includes(n))
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--force-prefers-reduced-motion'] })
for (const name of files) {
  const box = boards[`${name}.dc.html`]
  const page = await browser.newPage({ viewport: { width: box.w, height: box.h }, reducedMotion: 'reduce' })
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${render(name).replace(/<\/?helmet>/g, '')}</body></html>`, { waitUntil: 'load' })
  await page.screenshot({ path: join(here, `${name}.png`) })
  await page.close()
  console.log(`${name}.png`)
}
await browser.close()
