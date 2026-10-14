import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './fixtures'

for (const path of ['/', '/changelog']) {
  test(`${path} has no axe violations`, async ({ page }) => {
    await page.goto(path)
    // Also run the experimental rule Lighthouse uses, which checks that a link's name includes its visible text.
    // The hero demo's iframe is the Kernel app itself, built from src/renderer, so the site's audit leaves it out.
    const results = await new AxeBuilder({ page })
      .exclude('iframe')
      .options({ rules: { 'label-content-name-mismatch': { enabled: true } } })
      .analyze()
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
  })
}
