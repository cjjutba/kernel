// Renders canvas pages to the 1440x900 PNGs in design/screens, in headless Chrome. The canvas runtime only exists on claude.ai,
// so this expands each page's sc-if, sc-for and {{ }} from its own renderVals(), in the page's first state.
//
//   python3 design/canvas/source/build.py                 rebuild design/canvas/project from the templates
//   node design/canvas/source/render.mjs Home Team        render those pages to design/screens
//   node design/canvas/source/render.mjs --out /tmp/x Home
//
// Text rasterizes a little differently from the PNGs made on claude.ai, so render only the pages whose markup changed.
// CHROME_PATH picks the browser; the default is Google Chrome in /Applications.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '..')
const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const out = outAt >= 0 ? args[outAt + 1] : join(root, 'design', 'screens')
const names = args.filter((a, i) => a !== '--out' && i !== outAt + 1)
if (!names.length) throw new Error('Name the pages to render, for example: node design/canvas/source/render.mjs Home Team')
mkdirSync(out, { recursive: true })

function expand() {
  class DCLogic { constructor(props) { this.props = props || {}; this.state = {} } setState(s) { Object.assign(this.state, s) } }
  const script = document.querySelector('script[data-dc-script]')
  let vals = {}
  if (script) {
    const Component = new Function('DCLogic', script.textContent + '\nreturn Component;')(DCLogic)
    const c = new Component(JSON.parse(script.dataset.props || '{}'))
    vals = c.renderVals ? c.renderVals() : {}
  }
  const ev = (expr, scope) => new Function(...Object.keys(scope), `return (${expr})`)(...Object.values(scope))
  const one = (s, scope) => ev(s.match(/\{\{\s*([\s\S]*?)\s*\}\}/)[1], scope)
  const interp = (s, scope) => s.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_, e) => { const v = ev(e, scope); return typeof v === 'function' ? '' : String(v ?? '') })
  const walk = (node, scope) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) { if (c.nodeValue.includes('{{')) c.nodeValue = interp(c.nodeValue, scope); continue }
      if (c.nodeType !== 1) continue
      const tag = c.tagName.toLowerCase()
      if (tag === 'sc-if') { if (!one(c.getAttribute('value'), scope)) { c.remove(); continue } walk(c, scope); c.replaceWith(...c.childNodes); continue }
      if (tag === 'sc-for') {
        const items = []
        for (const item of one(c.getAttribute('list'), scope) || []) { const k = c.cloneNode(true); walk(k, { ...scope, [c.getAttribute('as')]: item }); items.push(...k.childNodes) }
        c.replaceWith(...items)
        continue
      }
      for (const a of [...c.attributes]) if (a.value.includes('{{')) { if (a.name.startsWith('on')) c.removeAttribute(a.name); else c.setAttribute(a.name, interp(a.value, scope)) }
      walk(c, scope)
    }
  }
  walk(document.querySelector('x-dc') || document.body, vals)
  document.body.style.background = '#000'
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
// support.js is the claude.ai runtime; the pages ask for it but render without it here.
await context.route('**/support.js', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }))
for (const name of names) {
  const page = await context.newPage()
  await page.goto('file://' + join(root, 'design', 'canvas', 'project', `${name}.dc.html`))
  await page.evaluate(expand)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(150)
  await page.locator('x-dc > div').first().screenshot({ path: join(out, `${name}.png`), animations: 'disabled' })
  await page.close()
  console.log(join(out, `${name}.png`))
}
await browser.close()
