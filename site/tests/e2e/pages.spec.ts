import { DOWNLOAD_URL } from '@/lib/links'
import { expect, isMobile, test } from './fixtures'

for (const path of ['/', '/changelog', '/pricing', '/docs', '/docs/permissions']) {
  test(`${path} loads`, async ({ page }) => {
    const res = await page.goto(path)
    expect(res?.status()).toBe(200)
    await expect(page.locator('h1')).toHaveCount(1)
  })

  test(`${path}: every download link gets the DMG directly`, async ({ page }) => {
    await page.goto(path)
    const links = page.getByRole('link', { name: /^Download/ })
    expect(await links.count()).toBeGreaterThan(0)
    for (const href of await links.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
      expect(href).toBe(DOWNLOAD_URL)
    }
  })

  test(`${path}: footer shows the wordmark`, async ({ page }) => {
    await page.goto(path)
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByRole('link', { name: 'Kernel', exact: true })).toHaveText('Kernel')
  })

  test(`${path}: no horizontal scroll`, async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo), 'narrow screens only')
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(path)
      const overflow = await page.evaluate(() => {
        const wide = [...document.querySelectorAll('body *')].filter((e) => {
          if (e.closest('[aria-hidden="true"], .sr-only')) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && (r.right > innerWidth + 0.5 || r.left < -0.5)
        })
        return { scrollWidth: document.documentElement.scrollWidth, wide: wide.map((e) => e.outerHTML.slice(0, 80)) }
      })
      expect(overflow.scrollWidth).toBeLessThanOrEqual(width)
      expect(overflow.wide).toEqual([])
    }
  })
}

test('the hero pill, the footer and the nav go to /changelog', async ({ page }, testInfo) => {
  await page.goto('/')
  const footerChangelog = page.getByRole('contentinfo').getByRole('link', { name: 'Changelog' })
  await expect(footerChangelog).toHaveAttribute('href', '/changelog')
  if (!isMobile(testInfo)) {
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Changelog' })).toHaveAttribute(
      'href',
      '/changelog'
    )
  }
  await page.getByRole('link', { name: 'Kernel 0.2 is here' }).click()
  await expect(page).toHaveURL('/changelog')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("What's new in Kernel")
})

test('the hero names no specific agent', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#top')).not.toContainText('Claude')
})

test('the final call to action has no icon above its heading', async ({ page }) => {
  await page.goto('/')
  const cta = page.locator('section[aria-labelledby="final-title"]')
  await expect(cta.locator('img')).toHaveCount(0)
  const firstVisible = cta.locator('h2, svg, img').first()
  await expect(firstVisible).toHaveText('Put your agents to work.')
})

for (const from of ['/', '/changelog', '/docs/install']) {
  test(`the nav goes to Docs, Pricing and Changelog from ${from}`, async ({ page }, testInfo) => {
    for (const [label, path] of [
      ['Docs', '/docs'],
      ['Pricing', '/pricing'],
      ['Changelog', '/changelog']
    ] as const) {
      await page.goto(from)
      // On narrow screens the links sit in the menu.
      if (isMobile(testInfo)) await page.locator('header summary[aria-label="Menu"]').click()
      await page.getByRole('navigation', { name: 'Main' }).filter({ visible: true }).getByRole('link', { name: label }).click()
      await expect(page).toHaveURL(path)
      await expect(page.locator('h1')).toBeVisible()
    }
  })
}

test('the changelog marks its nav link as the current page', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'the nav links are hidden on narrow screens')
  await page.goto('/changelog')
  await expect(page.getByRole('link', { name: 'Changelog', exact: true }).first()).toHaveAttribute('aria-current', 'page')
})

test('the star count shows from the stub GitHub API', async ({ page }, testInfo) => {
  await page.goto('/')
  const star = page.getByRole('link', { name: /^Star Kernel on GitHub/ })
  if (isMobile(testInfo)) {
    await expect(star).toBeHidden()
    return
  }
  await expect(star).toHaveAccessibleName('Star Kernel on GitHub, 1.2k stars')
  await expect(star).toContainText('1.2k')
})

test('a release shows only once GitHub has published it', async ({ page }) => {
  // The stub's latest release is v0.2.0, so 0.2.1's file is merged but not yet published (KERNEL-412).
  await page.goto('/changelog')
  const entries = page.getByRole('article')
  await expect(entries.first()).toContainText('0.2.0')
  await expect(entries.first()).toContainText('Latest')
  await expect(page.getByRole('heading', { name: 'Kernel 0.2.1' })).toHaveCount(0)
  await expect(page.getByText('This is where it all starts.')).toHaveCount(0)
})
