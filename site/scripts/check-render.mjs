// Full-page check against design/site/renders: node scripts/check-render.mjs <landing|changelog>
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { compareToRender, MAX_DIFF_RATIO, MAX_HEIGHT_DELTA } from './visual.mjs'

const name = process.argv[2] ?? 'landing'
const base = process.env.SITE_URL ?? 'http://localhost:3000'
const render = fileURLToPath(new URL(`../../design/site/renders/${name}-1440.png`, import.meta.url))
const out = fileURLToPath(new URL('../test-results/compare/', import.meta.url))
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(`${base}${name === 'landing' ? '/' : `/${name}`}`, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
await page.evaluate(async () => {
  for (const img of document.images) {
    img.loading = 'eager'
    await img.decode().catch(() => {})
  }
})
const star = await page.locator('a[aria-label^="Star Kernel"]').boundingBox()
const shot = await page.screenshot({ fullPage: true })
await browser.close()

const masks = star ? [{ x: star.x - 72, y: star.y - 4, width: star.width + 80, height: star.height + 8 }] : []
const r = compareToRender(shot, render, masks)
writeFileSync(`${out}${name}-render-diff.png`, r.diffPng)
writeFileSync(`${out}${name}-render-side.png`, r.sideBySidePng)
const ok = Math.abs(r.heightDelta) <= MAX_HEIGHT_DELTA && r.ratio <= MAX_DIFF_RATIO
console.log(`${name}: height delta ${r.heightDelta}px, diff ${(r.ratio * 100).toFixed(2)}% ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
