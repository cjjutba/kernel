// Brings the landing page demo up to date: `pnpm demo:refresh` (KERNEL-900). Runs on the release branch.
//
//   1. type-checks demo/
//   2. rebuilds it into site/public/demo
//   3. retakes site/public/images/lead-plan.png, the image the site shows until the demo loads, from the built demo's opening state
//   4. lists the clips in site/public/clips whose scene sources changed since the clip was last committed
//
// Re-recording a clip is a person's call (it takes minutes and needs ffmpeg), so step 4 only prints the commands.
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const root = join(import.meta.dirname, '..')
const built = join(root, 'site/public/demo')
const clipsDir = join(root, 'site/public/clips')
const image = join(root, 'site/public/images/lead-plan.png')
const ORIGIN = 'http://localhost:4361'
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
// What a clip shows: the renderer and everything the demo's stand-ins import. README.md and clips.ts (the recorder, which
// holds every clip's script) don't change what a scene looks like.
const SOURCES = ['demo', 'src/renderer', 'src/shared', 'src/main', 'fixtures']
const NOT_SOURCES = [':!demo/README.md', ':!demo/clips.ts', ':!demo/tsconfig.json']

const pnpm = (...args: string[]) => execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' })
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

async function retakeFallbackImage() {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  demo: ${e.message}`))
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      const file = join(built, path === '/' ? 'index.html' : path)
      if (!existsSync(file)) return route.fulfill({ status: 404 })
      await route.fulfill({ body: readFileSync(file), contentType: MIME[extname(file)] ?? 'application/octet-stream' })
    })
    await page.goto(`${ORIGIN}/index.html`)
    await page.locator('#root > *').first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    // The visitor's hint (demo/guide.ts) is a direct child of body. The still shows the window without it.
    await page.addStyleTag({ content: 'body > [role=status] { display: none !important }' })
    await page.waitForTimeout(1500)
    writeFileSync(image, await page.screenshot())
  } finally {
    await browser.close()
  }
}

/** Clips whose sources have a commit newer than the clip's own last commit. */
function staleClips() {
  const names = readdirSync(clipsDir).filter((f) => f.endsWith('.mp4')).map((f) => f.slice(0, -4)).sort()
  const stale: { name: string; commits: string[] }[] = []
  for (const name of names) {
    const last = git('log', '-1', '--format=%H', '--', `site/public/clips/${name}.mp4`)
    if (!last) continue // never committed, so there is nothing to compare with
    const commits = git('log', '--format=%h %s', `${last}..HEAD`, '--', ...SOURCES, ...NOT_SOURCES).split('\n').filter(Boolean)
    if (commits.length) stale.push({ name, commits })
  }
  return { names, stale }
}

pnpm('exec', 'tsc', '--noEmit', '-p', 'demo/tsconfig.json')
pnpm('demo:build')
await retakeFallbackImage()
console.log('\nsite/public/images/lead-plan.png retaken from the built demo.')

const { names, stale } = staleClips()
if (!stale.length) console.log(`\nAll ${names.length} clips are newer than their scene sources.`)
else {
  console.log(`\n${stale.length} of ${names.length} clips are older than a change to what they show:\n`)
  for (const { name, commits } of stale) {
    console.log(`  ${name}: ${commits.length} commit${commits.length === 1 ? '' : 's'} since it was recorded (latest: ${commits[0]})`)
    console.log(`    pnpm demo:clips ${name}`)
  }
  console.log('\nRe-recording is your call. The commits show what changed; many touch screens a clip never visits.')
}
