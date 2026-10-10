// Screenshot harness (KERNEL-7). Runs on plain Node with built-in type stripping, so only erasable TypeScript here.
//
//   pnpm shots Workspace Main          build, then capture shots/<Screen>.png for each fixture
//   pnpm shots --all                   every fixture with a PNG in design/screens
//   pnpm shots --no-build Main         reuse the last build
//   pnpm shots --theme light Main      capture in the light theme, saved as shots/<Screen>.light.png
//   pnpm shots:compare Workspace       shot left, design right, in shots/compare/<Screen>.png

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type Page } from 'playwright-core'
import pngjs from 'pngjs'

const { PNG } = pngjs
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const designDir = join(root, 'design/screens')
const shotsDir = join(root, 'shots')
const WIDTH = 1440
const HEIGHT = 900
const GAP = 16

// pnpm passes a `--` through (`pnpm shots -- Main`), so drop it.
const args = process.argv.slice(2).filter((a) => a !== '--')
const flags = new Set(args.filter((a) => a.startsWith('--')))
const themeAt = args.indexOf('--theme')
const theme = themeAt >= 0 ? args[themeAt + 1] : undefined
if (theme !== undefined && theme !== 'light' && theme !== 'dark') throw new Error('--theme takes light or dark')
const suffix = theme === 'light' ? '.light' : ''
const names = args.filter((a, i) => !a.startsWith('--') && a !== 'compare' && (themeAt < 0 || i !== themeAt + 1))
const allDesigns = () => readdirSync(designDir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort()
// Plain Node cannot import fixtures/index.ts (extensionless imports), so read the keys: one `  Name:` line per fixture.
const fixtureNames = () => new Set(readdirSync(join(root, 'fixtures')).filter((f) => f.endsWith('.ts')).flatMap((f) => [...readFileSync(join(root, 'fixtures', f), 'utf8').matchAll(/^ {2}([A-Z]\w+):/gm)].map((m) => m[1])))
const withFixture = () => allDesigns().filter((n) => fixtureNames().has(n))

// Screens that need a click to reach the state in the shot, such as a chat row opened in place. That state is local to the
// component, so a fixture can't set it.
async function openRows(page: Page, rows: string[]) {
  for (const row of rows) await page.locator('.trow-btn', { hasText: row }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

const interactions: Record<string, (page: Page) => Promise<void>> = {
  WorkspaceRowsOpen: (page) => openRows(page, ['Thinking', 'Run unit tests', 'Edit table.tsx']),
  WorkspaceRowsFolded: (page) => openRows(page, ['Thinking', 'Message', 'Edit table.tsx'])
}

async function capture(name: string): Promise<boolean> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ELECTRON_RENDERER_URL') env[k] = v
  env.KERNEL_FIXTURES = name
  env.KERNEL_HEADLESS = '1'
  if (theme) env.KERNEL_FIXTURE_THEME = theme
  // Electron's own cache and storage for this launch. Deleted after close, since Chromium writes to it until exit.
  const data = mkdtempSync(join(tmpdir(), 'kernel-fixture-'))
  env.KERNEL_FIXTURE_DATA = data
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], cwd: root, env })
  let logs = ''
  app.process().stderr?.on('data', (d: Buffer) => { logs += d.toString() })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h), { w: WIDTH, h: HEIGHT })
    await page.waitForSelector('html[data-fixture="ready"]', { state: 'attached', timeout: 15_000 })
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    // Screens load their own data on mount (loadRoom, loadWorkspace, changes). Give those calls a moment to land.
    await page.waitForTimeout(500)
    await interactions[name]?.(page)
    await page.screenshot({ path: join(shotsDir, `${name}${suffix}.png`) })
    console.log(`shots/${name}${suffix}.png`)
    return true
  } catch (err) {
    console.error(`${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    if (logs.includes('no fixture named')) console.error(logs.trim())
    return false
  } finally {
    await app.close().catch(() => undefined)
    rmSync(data, { recursive: true, force: true })
  }
}

async function shots() {
  const list = flags.has('--all') ? withFixture() : names
  if (!list.length) throw new Error('Name at least one screen, for example: pnpm shots Workspace Main')
  if (!flags.has('--no-build')) {
    const build = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { cwd: root, stdio: 'inherit' })
    if (build.status !== 0) process.exit(build.status ?? 1)
  }
  mkdirSync(shotsDir, { recursive: true })
  let failed = 0
  for (const name of list) if (!(await capture(name))) failed++
  if (failed) { console.error(`${failed} of ${list.length} screens failed`); process.exit(1) }
}

/** Copy `src` into `dst` at x, y. Both are RGBA. */
function blit(src: InstanceType<typeof PNG>, dst: InstanceType<typeof PNG>, x: number, y: number) {
  for (let row = 0; row < src.height; row++) {
    const from = row * src.width * 4
    src.data.copy(dst.data, ((y + row) * dst.width + x) * 4, from, from + src.width * 4)
  }
}

function compare() {
  const list = flags.has('--all') ? allDesigns().filter((n) => existsSync(join(shotsDir, `${n}.png`))) : names
  if (!list.length) throw new Error('Name at least one screen, for example: pnpm shots:compare Workspace')
  mkdirSync(join(shotsDir, 'compare'), { recursive: true })
  let failed = 0
  for (const name of list) {
    const shotFile = join(shotsDir, `${name}.png`)
    const designFile = join(designDir, `${name}.png`)
    if (!existsSync(shotFile)) { console.error(`${name}: no shot yet. Run pnpm shots ${name}`); failed++; continue }
    if (!existsSync(designFile)) { console.error(`${name}: no design/screens/${name}.png`); failed++; continue }
    const shot = PNG.sync.read(readFileSync(shotFile))
    const design = PNG.sync.read(readFileSync(designFile))
    const w = Math.max(shot.width, design.width)
    const h = Math.max(shot.height, design.height)
    if (shot.width !== design.width || shot.height !== design.height)
      console.warn(`${name}: shot is ${shot.width}x${shot.height}, design is ${design.width}x${design.height}. Padding both to ${w}x${h}.`)
    const out = new PNG({ width: w * 2 + GAP, height: h })
    for (let i = 0; i < out.data.length; i += 4) out.data.writeUInt32BE(0x808080ff, i)
    blit(shot, out, 0, 0)
    blit(design, out, w + GAP, 0)
    writeFileSync(join(shotsDir, 'compare', `${name}.png`), PNG.sync.write(out))
    console.log(`shots/compare/${name}.png (shot left, design right)`)
  }
  if (failed) process.exit(1)
}

if (args[0] === 'compare') compare()
else await shots()
