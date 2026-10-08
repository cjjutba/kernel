// Side-by-side screenshots of the design reference and the local site at 1440 px wide.
// Usage: node scripts/compare.mjs <landing|changelog> [name=refSelector|localSelector ...]
// With no pairs it captures the full page. Output: test-results/compare/<page>-<name>.png (reference left).
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { PNG } from 'pngjs'

const [page = 'landing', ...pairs] = process.argv.slice(2)
const base = process.env.SITE_URL ?? 'http://localhost:3000'
const refUrl = new URL(`../../design/site/reference/${page}.html`, import.meta.url).href
const localUrl = process.env.LOCAL_PATH ? base + process.env.LOCAL_PATH : `${base}${page === 'landing' ? '/' : `/${page}`}`
const outDir = fileURLToPath(new URL('../test-results/compare/', import.meta.url))
mkdirSync(outDir, { recursive: true })

const targets = pairs.length
  ? pairs.map((p) => {
      const i = p.indexOf('=')
      const [name, sels] = [p.slice(0, i), p.slice(i + 1)]
      const [ref, local = ref] = sels.split('|')
      return { name, ref, local }
    })
  : [{ name: 'full', ref: null, local: null }]

async function capture(browser, url, selector) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(url, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  const buf = selector ? await page.locator(selector).first().screenshot() : await page.screenshot({ fullPage: true })
  await page.close()
  return PNG.sync.read(buf)
}

function sideBySide(a, b) {
  const gap = 16
  const out = new PNG({ width: a.width + gap + b.width, height: Math.max(a.height, b.height) })
  out.data.fill(255)
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0)
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0)
  return out
}

const browser = await chromium.launch()
for (const t of targets) {
  const [a, b] = [await capture(browser, refUrl, t.ref), await capture(browser, localUrl, t.local)]
  const file = `${outDir}${page}-${t.name}.png`
  writeFileSync(file, PNG.sync.write(sideBySide(a, b)))
  console.log(`${t.name}: reference ${a.width}x${a.height}, local ${b.width}x${b.height} -> ${file}`)
}
await browser.close()
