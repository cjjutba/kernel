import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error plain ESM helper shared with scripts/check-render.mjs
import { compareToRender, MAX_DIFF_RATIO, MAX_HEIGHT_DELTA } from '../../scripts/visual.mjs'
import { expect, isMobile, test } from './fixtures'

const renders = join(import.meta.dirname, '..', '..', '..', 'design', 'site', 'renders')
const out = join(import.meta.dirname, '..', '..', 'test-results', 'compare')

for (const [name, path] of [
  ['landing', '/'],
  ['changelog', '/changelog']
]) {
  test(`${name} matches the design render at 1440`, async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo), 'the renders are 1440 px wide')
    await page.goto(path!)
    await page.evaluate(async () => {
      await document.fonts.ready
      for (const img of document.images) {
        img.loading = 'eager'
        await img.decode().catch(() => {})
      }
    })
    // The star count is live, so it is painted out on both sides.
    const star = await page.getByRole('link', { name: /^Star Kernel/ }).boundingBox()
    const masks = star ? [{ x: star.x - 72, y: star.y - 4, width: star.width + 80, height: star.height + 8 }] : []
    const result = compareToRender(await page.screenshot({ fullPage: true }), join(renders, `${name}-1440.png`), masks)

    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, `${name}-render-side.png`), result.sideBySidePng)
    writeFileSync(join(out, `${name}-render-diff.png`), result.diffPng)
    await testInfo.attach(`${name} side by side (render left)`, { body: result.sideBySidePng, contentType: 'image/png' })
    await testInfo.attach(`${name} diff`, { body: result.diffPng, contentType: 'image/png' })

    expect(Math.abs(result.heightDelta), 'page height drift from the render, in px').toBeLessThanOrEqual(MAX_HEIGHT_DELTA)
    expect(result.ratio, 'share of pixels that differ from the render').toBeLessThanOrEqual(MAX_DIFF_RATIO)
  })
}
