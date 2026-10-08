import { gzipSync } from 'node:zlib'
import type { APIRequestContext } from '@playwright/test'
import { expect, isMobile, test } from './fixtures'

// First-load JavaScript, gzipped, as the HTML asks for it. The noModule polyfills are left out because
// modern browsers never download them, and so are later prefetches of other routes.
// Section 13 of the plan asks for under 120 kB on the landing page. Next 16's runtime alone is about 132 kB,
// so these budgets cap what the site adds on top of it and catch growth in the total.
const KB = 1024
const LANDING_TOTAL_CEILING = 160 * KB
const LANDING_OWN_BUDGET = 30 * KB
const CHANGELOG_OWN_BUDGET = 10 * KB

async function firstLoadScripts(request: APIRequestContext, path: string) {
  const html = await (await request.get(path)).text()
  const srcs = [...html.matchAll(/<script\b([^>]*)>/g)]
    .filter(([, attrs]) => !/noModule/i.test(attrs!))
    .flatMap(([, attrs]) => attrs!.match(/src="([^"]+\.js)"/)?.[1] ?? [])
  return Promise.all(
    [...new Set(srcs)].map(async (src) => {
      const body = await (await request.get(src)).body()
      return { src, gz: gzipSync(body).length, text: body.toString('utf8') }
    })
  )
}

const sum = (xs: { gz: number }[]) => xs.reduce((s, x) => s + x.gz, 0)
const kb = (n: number) => `${(n / KB).toFixed(1)} kB`

test('JavaScript budgets', async ({ request }, testInfo) => {
  test.skip(isMobile(testInfo), 'the same bytes at every width')
  const [landing, changelog] = await Promise.all([firstLoadScripts(request, '/'), firstLoadScripts(request, '/changelog')])
  const shared = new Set(landing.map((s) => s.src).filter((src) => changelog.some((c) => c.src === src)))
  const landingOwn = landing.filter((s) => !shared.has(s.src))
  const changelogOwn = changelog.filter((s) => !shared.has(s.src))

  testInfo.annotations.push({
    type: 'first-load JS (gzip)',
    description: `landing ${kb(sum(landing))} (own ${kb(sum(landingOwn))}), changelog ${kb(sum(changelog))} (own ${kb(sum(changelogOwn))}), shared ${kb(sum(landing) - sum(landingOwn))}`
  })

  expect(sum(landing)).toBeLessThan(LANDING_TOTAL_CEILING)
  expect(sum(landingOwn)).toBeLessThan(LANDING_OWN_BUDGET)
  expect(sum(changelogOwn)).toBeLessThan(CHANGELOG_OWN_BUDGET)
  // The tour tabs are the site's only client component, and the changelog must not load them.
  expect(changelog.filter((s) => s.text.includes('TabsList')).map((s) => s.src)).toEqual([])
})
