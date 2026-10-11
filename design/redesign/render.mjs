// Renders the redesign canvas to PNGs: design/redesign/canvas/<Screen>.dc.html -> design/redesign/<Screen>.png at 1440x900.
// Each artboard becomes plain HTML: template values and <sc-if> blocks are filled from its default props, then headless
// Chrome screenshots it. Usage: node design/redesign/render.mjs [Screen ...]   (no names renders every artboard)
// Set CHROME to the browser binary when it isn't the default macOS Google Chrome.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const canvas = join(here, 'canvas')
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const tmp = mkdtempSync(join(tmpdir(), 'kernel-redesign-'))

/** One artboard as plain HTML, with its holes and branches resolved from the declared defaults. */
function toHtml(src) {
  let html = src
  const script = html.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>([\s\S]*?)<\/script>/)
  const decl = JSON.parse(script[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'"))
  const props = {}
  for (const [k, v] of Object.entries(decl)) if (!k.startsWith('$') && v && 'default' in v) props[k] = v.default
  class DCLogic { constructor(p) { this.props = p; this.state = {} } setState() {} }
  const Component = new Function('DCLogic', `${script[2]}; return Component`)(DCLogic)
  const vals = new Component(props).renderVals()
  const lookup = (expr) => expr === 'true' ? true : expr === 'false' ? false : expr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), vals)
  const inner = /<sc-if value="\{\{\s*([\w.]+)\s*\}\}"[^>]*>((?:(?!<sc-if)[\s\S])*?)<\/sc-if>/
  while (inner.test(html)) html = html.replace(inner, (_, expr, body) => (lookup(expr) ? body : ''))
  html = html.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, expr) => String(lookup(expr) ?? ''))
  return html.replace(script[0], '').replace('<script src="./support.js"></script>', '').replace(/<\/?x-dc>/g, '').replace(/<\/?helmet>/g, '')
}

const names = process.argv.slice(2)
const files = readdirSync(canvas).filter((f) => f.endsWith('.dc.html')).filter((f) => !names.length || names.includes(f.replace('.dc.html', '')))
for (const file of files) {
  const name = file.replace('.dc.html', '')
  const page = join(tmp, `${name}.html`)
  writeFileSync(page, toHtml(readFileSync(join(canvas, file), 'utf8')))
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1440,900', '--virtual-time-budget=4000', `--screenshot=${join(here, `${name}.png`)}`, `file://${page}`], { stdio: 'ignore' })
  console.log(`${name}.png`)
}
