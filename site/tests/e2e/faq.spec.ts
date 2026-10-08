import { expect, test } from './fixtures'

test('the first question is open and a closed one opens on click', async ({ page }) => {
  await page.goto('/')
  const rows = page.locator('#faq details')
  await expect(rows).toHaveCount(7)
  await expect(rows.first()).toHaveAttribute('open', '')
  const second = rows.nth(1)
  await expect(second).not.toHaveAttribute('open')
  await second.locator('summary').click()
  await expect(second).toHaveAttribute('open', '')
  await expect(second).toContainText('Claude Code today.')
})
