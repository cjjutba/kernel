// Exports build/dmg-background.svg to build/background.png (660x440) and build/background@2x.png (1320x880).
// Uses headless Chrome through playwright-core so the system font matches what a Mac renders.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const svg = readFileSync(`${root}build/dmg-background.svg`, 'utf8')
const browser = await chromium.launch({ channel: 'chrome' })
for (const [scale, file] of [[1, 'background.png'], [2, 'background@2x.png']]) {
  const page = await browser.newPage({ viewport: { width: 660, height: 440 }, deviceScaleFactor: scale })
  await page.setContent(`<body style="margin:0">${svg}</body>`)
  await page.screenshot({ path: `${root}build/${file}` })
  await page.close()
}
await browser.close()
