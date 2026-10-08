import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './fixtures'

for (const path of ['/', '/changelog']) {
  test(`${path} has no axe violations`, async ({ page }) => {
    await page.goto(path)
    // The step mockups are pictures of the app's UI, hidden from assistive tech. Their small labels copy the
    // app's own colors, and text that is part of a picture is exempt from WCAG 1.4.3.
    const results = await new AxeBuilder({ page }).exclude('#how [aria-hidden="true"]').analyze()
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
  })
}
