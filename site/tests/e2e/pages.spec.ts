import { DOWNLOAD_URL } from '@/lib/links'
import { expect, isMobile, test } from './fixtures'

for (const path of ['/', '/changelog']) {
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

  test(`${path}: footer shows the wordmark and the large wordmark`, async ({ page }) => {
    await page.goto(path)
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByRole('img', { name: 'Kernel' })).toBeVisible()
    await expect(footer.locator('[aria-hidden="true"]').filter({ hasText: 'ernel' }).last()).toBeVisible()
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

test('release notes, the hero pill and the nav go to /changelog', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Release notes' })).toHaveAttribute('href', '/changelog')
  const footerChangelog = page.getByRole('contentinfo').getByRole('link', { name: 'Changelog' })
  await expect(footerChangelog).toHaveAttribute('href', '/changelog')
  if (!isMobile(testInfo)) {
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Changelog' })).toHaveAttribute(
      'href',
      '/changelog'
    )
  }
  await page.getByRole('link', { name: /Kernel 0\.1 is here/ }).click()
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

for (const from of ['/', '/changelog']) {
  test(`nav anchors scroll to their sections from ${from}`, async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo), 'the nav links are hidden on narrow screens')
    const nav = page.getByRole('navigation', { name: 'Main' })
    for (const [label, id] of [
      ['Features', 'features'],
      ['How it works', 'how'],
      ['Privacy', 'privacy'],
      ['FAQ', 'faq']
    ]) {
      await page.goto(from)
      await nav.getByRole('link', { name: label }).click()
      await expect(page).toHaveURL(`/#${id}`)
      await expect(page.locator(`#${id}`)).toBeInViewport()
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
  await expect(star).toHaveAccessibleName('Star Kernel on GitHub, 1,234 stars')
  await expect(star).toContainText('1.2k')
})
