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
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import pngjs from 'pngjs'

const { PNG } = pngjs
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const designDir = join(root, 'design/screens')
// The redesign's PNGs (KERNEL-274) replace the ones in design/screens for the surfaces they draw, and some screens exist only there.
const redesignDir = join(root, 'design/redesign')
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

// WorkspaceScrolledUp is a long chat read from higher up. The scroll position is the transcript's own, so wheel it up like a reader would.
async function scrollUp(page: Page) {
  await page.locator('.ws-scroll').hover()
  await page.mouse.wheel(0, -600)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// WorkspaceQuestionSteps is drawn on question 2 of 3 with two rows ticked; the step is local to the card.
async function stepToSecondQuestion(page: Page) {
  await page.getByRole('radio', { name: 'Yes, invoice-009.pdf' }).click()
  await page.getByRole('checkbox', { name: 'Row actions menu' }).click()
  await page.getByRole('checkbox', { name: 'Invoice detail header' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// WorkspaceQuestion is drawn with option 1 picked, which is local to the card, so Send is ready.
async function pickFirstOption(page: Page) {
  await page.getByRole('radio', { name: 'Yes, invoice-009.pdf' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// WorkspaceQuestionOther is drawn on question 3 with the first two answered and a Something else answer typed.
async function typeOtherAnswer(page: Page) {
  await stepToSecondQuestion(page)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('radio', { name: 'Something else' }).click()
  await page.getByRole('textbox', { name: 'Your answer' }).fill('Ask me again after the review')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// WorkspaceSharedPhone is drawn at the Phone width, and WorkspaceSharedVersions with the version picker open. Both are local to the tab.
async function pickPhone(page: Page) {
  await page.getByRole('radio', { name: 'Phone' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

async function openVersions(page: Page) {
  await page.getByRole('button', { name: 'Versions' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// The typing shots draw the composer focused, which takes a real focus. Focus also settles the plan glow at full.
async function focusComposer(page: Page) {
  await page.locator('.cmp-input').focus()
  await page.waitForTimeout(300)
}

// WorkspaceSharedCrashed is the page after its renderer died. A fixture run has no live view, so main pushes the crash for the tab's key
// (workspace and file), as it would for the view's id.
async function crashPage(page: Page, app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }, viewId) => BrowserWindow.getAllWindows()[0]?.webContents.send('kernel:event', { type: 'preview', viewId, state: 'crashed' }), 'ws-invoice-table:sh-html')
  await page.getByRole('alert').waitFor()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// The comment shots are comment mode partway through a comment: Comment is pressed, a spot is clicked and the note typed. The click is
// measured from the layer's box, in the layer's own pixels as the canvas draws them. A page then shows what the pointer is over.
async function commentAt(page: Page, spot: { x: number; y: number }, note: string, over?: { x: number; y: number }) {
  await page.getByRole('button', { name: 'Comment', exact: true }).click()
  const layer = page.locator('.cm-layer')
  await layer.waitFor()
  const picture = page.locator('.shared-area > img')
  const image = (await picture.count()) ? await picture.boundingBox() : null
  const box = (await layer.boundingBox())!
  // Over an image the spot is in its picture, inside the 1px border.
  const at = image ? { x: image.x + 1 + spot.x, y: image.y + 1 + spot.y } : { x: box.x + spot.x, y: box.y + spot.y }
  await page.mouse.click(at.x, at.y)
  await page.getByRole('textbox', { name: 'Comment' }).fill(note)
  if (over) {
    await page.mouse.move(box.x + over.x, box.y + over.y)
    await page.waitForTimeout(300)
  }
}

// GroupedChatArchive is the table chat's row hovered, which shows its Archive button (KERNEL-405).
async function hoverChatRow(page: Page) {
  await page.getByRole('button', { name: 'Invoice table and empty states', exact: true }).hover()
  await page.waitForTimeout(300)
}

// NewWorkspaceFromGitHub and NewWorkspaceFromNone are the From popover on its Issues tab. The tab is local to the modal (KERNEL-471).
async function openIssuesTab(page: Page) {
  await page.getByRole('tab', { name: 'Issues' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// HeaderBranchTooltip is the header with the title hovered, long enough for the tooltip to open (KERNEL-413).
async function hoverTitle(page: Page) {
  await page.locator('.ws-title-btn').hover()
  await page.locator('.tooltip').waitFor()
  await page.waitForTimeout(300)
}

// PanelResize is the handle between the right panel's panes with the pointer on it, long enough for the glow to arrive (KERNEL-513).
async function hoverSplitHandle(page: Page) {
  await page.getByRole('separator', { name: 'Resize bottom panel' }).hover()
  await page.waitForTimeout(400)
}

const interactions: Record<string, (page: Page, app: ElectronApplication) => Promise<void>> = {
  GroupedChatArchive: hoverChatRow,
  HeaderBranchTooltip: hoverTitle,
  PanelResize: hoverSplitHandle,
  NewWorkspaceFromGitHub: openIssuesTab,
  NewWorkspaceFromNone: openIssuesTab,
  WorkspacePlanModeTyping: focusComposer,
  WorkspacePlanTyping: focusComposer,
  WorkspaceSharedComment: (page) => commentAt(page, { x: 159, y: 162 }, 'Make this button the same blue as the header.', { x: 600, y: 300 }),
  WorkspaceSharedCommentImage: (page) => commentAt(page, { x: 117, y: 70 }, 'Make this specimen bigger.'),
  WorkspaceSharedCommentArchived: (page) => commentAt(page, { x: 159, y: 162 }, 'Make this button the same blue as the header.', { x: 600, y: 300 }),
  WorkspaceSharedCommentOlder: (page) => commentAt(page, { x: 159, y: 162 }, 'Make this button the same blue as the header.', { x: 600, y: 300 }),
  WorkspaceSharedCrashed: crashPage,
  WorkspaceSharedPhone: pickPhone,
  WorkspaceSharedVersions: openVersions,
  WorkspaceQuestion: pickFirstOption,
  WorkspaceQuestionSteps: stepToSecondQuestion,
  WorkspaceQuestionOther: typeOtherAnswer,
  WorkspaceRowsOpen: (page) => openRows(page, ['Thinking', 'Run unit tests', 'Edit table.tsx']),
  WorkspaceRowsFolded: (page) => openRows(page, ['Thinking', 'Message', 'Edit table.tsx']),
  WorkspaceScrolledUp: scrollUp
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
    // Settings, Floor and Board are lazy chunks. App shows the boot shell with data-lazy until the chunk has loaded, and their data
    // loads on mount, so wait for the chunk first and for the screen's data after.
    const lazyLoaded = () => page.waitForSelector('[data-lazy="pending"]', { state: 'detached', timeout: 15_000 })
    await lazyLoaded()
    // Screens load their own data on mount (loadRoom, loadWorkspace, changes). Give those calls a moment to land.
    await page.waitForTimeout(500)
    await interactions[name]?.(page, app)
    await lazyLoaded()
    // One-off animations finish and loops (the plan glow's breath, spinners) reset, so a shot is the same on every run.
    await page.screenshot({ path: join(shotsDir, `${name}${suffix}.png`), animations: 'disabled' })
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
    const designFile = [join(designDir, `${name}.png`), join(redesignDir, `${name}.png`)].find((f) => existsSync(f)) ?? join(designDir, `${name}.png`)
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
