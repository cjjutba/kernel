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

// A Read image row clicked: the first one loads and opens its image in a tab, the one for the deleted file opens to its path (KERNEL-671).
async function clickReadImage(page: Page, name: string) {
  await page.locator('.trow-btn', { hasText: 'Read image' }).filter({ hasText: name }).first().click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(400)
}

// WorkspaceScrolledUp is a long chat read from higher up. The scroll position is the transcript's own, so wheel it up like a reader would.
async function scrollUp(page: Page) {
  await page.locator('.ws-scroll').hover()
  await page.mouse.wheel(0, -600)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

async function scrollToSection(page: Page, title: string) {
  await page.locator('.set-scroll').evaluate((el, t) => {
    const h = [...el.querySelectorAll('h2, h3')].find((x) => x.textContent?.trim() === t)
    if (h) el.scrollTop += h.getBoundingClientRect().top - el.getBoundingClientRect().top - 24
  }, title)
  await page.waitForTimeout(300)
}

// ChatRail and ChatRailOpen are a long chat read from its 14th message, which sits 16px under the tab row, where a jump to it lands (KERNEL-599). The scroll position is the transcript's own, and rows far
// above measure a frame after they show, so aim again until the message stays put.
async function readFromMessage(page: Page, text: string) {
  const box = page.locator('.ws-scroll')
  const message = (await page.locator('.msg-user', { hasText: text }).elementHandle())!
  for (let i = 0; i < 4; i++) {
    await box.evaluate((el, m) => { el.scrollTop += m.getBoundingClientRect().top - el.getBoundingClientRect().top - 16 }, message)
    await page.waitForTimeout(200)
  }
}

// The list is open on hover, with the pointer on one of its rows. The pointer moves from the rail onto the row, as it would to reach it.
async function openRail(page: Page, row: string) {
  await page.getByRole('button', { name: 'Jump to message' }).hover()
  await page.getByRole('option', { name: row, exact: true }).hover()
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

// WorkspaceKernelNoteOpen is the Kernel note opened to its full text, which is local to the note.
async function openKernelNote(page: Page) {
  await page.locator('.knote').click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// WorkspaceQuestion is drawn with option 1 picked, which is local to the card, so Send is ready.
async function pickFirstOption(page: Page) {
  await page.getByRole('radio', { name: 'Yes, invoice-009.pdf' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// WorkspaceQuestionStates is option 1 picked, option 3 focused from the keyboard and option 2 hovered (KERNEL-676).
async function questionStates(page: Page) {
  await page.getByRole('radio', { name: 'Yes, invoice-009.pdf' }).click()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.getByRole('radio', { name: /Add the client name/ }).hover()
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

// WorkspaceSharedImageZoom is the image at 200%. The zoom is local to the tab and starts at Fit, so press Zoom in as a person would: 100, 150, 200 (KERNEL-598).
async function zoomImage(page: Page) {
  const zoomIn = page.getByRole('button', { name: 'Zoom in' })
  await zoomIn.click()
  await zoomIn.click()
  await page.getByRole('button', { name: '200%, fit to window' }).waitFor()
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
  const picture = page.locator('.shared-zoom > img')
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

// TurnFilesHover is the card with wiring.ts hovered and Home.tsx focused from the keyboard: focus lands on the first row and Down moves it to the fourth,
// which is what makes the ring a keyboard ring (KERNEL-586).
async function hoverAndFocusRows(page: Page) {
  await page.locator('.tf-r').first().focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await page.locator('.tf-r').nth(1).hover()
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

// PanelTabsOverflow is the right panel at its narrowest, 320px, where the tab strips run out of room (KERNEL-514). Home on the panel's handle takes it there, as it does from the keyboard.
// The bottom strip has only Setup, Run and Terminal, which fit, so the canvas's two extra terminals are added here as stand-ins and the strip scrolled a little, to draw both arrows.
async function narrowPanel(page: Page) {
  const handle = page.getByRole('separator', { name: 'Resize panel' })
  await handle.focus()
  await page.keyboard.press('Home')
  await handle.blur()
  await page.getByRole('tablist', { name: 'Scripts' }).evaluate((list) => {
    const terminal = list.lastElementChild!
    for (const n of [3, 2]) { const more = terminal.cloneNode(true) as HTMLElement; more.textContent = `Terminal ${n}`; terminal.after(more) }
    list.scrollLeft = 30
  })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(400)
}

// PanelFilter is Changes with the filter open and "inbox" typed. Both are local to the tab, so open the field from the search button and type, as a person would (KERNEL-515).
async function filterChanges(page: Page) {
  await page.getByRole('button', { name: 'Filter changed files' }).click()
  await page.getByRole('textbox', { name: 'Filter changed files' }).fill('inbox')
  await page.waitForTimeout(300)
}

// PanelCompare is Changes with the ⋯ menu open. Whether it is open is local to the tab, so press the button and wait for the commit rows, which the menu reads when it opens (KERNEL-517).
async function openCompare(page: Page) {
  await page.getByRole('button', { name: 'Compare changes' }).click()
  await page.getByRole('menuitemradio', { name: /Drop Inbox rows/ }).waitFor()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// LeadNoChatsBranch is New chat with Rowan with New branch from main open. The menu is the composer's own, so press the button and wait for the
// remote's branches, which the menu reads when it opens.
async function openBaseBranch(page: Page) {
  await page.getByRole('button', { name: 'New branch from main' }).click()
  await page.getByRole('menuitemradio', { name: /origin\/invoice-table/ }).waitFor()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsAddAccountApiKey is the Add account sheet on its API key step with a name and a key typed. The sheet and what is typed in it are local to the page (KERNEL-524).
async function typeApiKey(page: Page) {
  await page.getByRole('button', { name: 'Add key' }).click()
  await page.locator('#acct-label').fill('Work key')
  await page.locator('#acct-key').fill('sk-ant-api03-5f1c9d27a0b84e63')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// The Add account sheets (KERNEL-561): the sheet is opened from the page's button, and Browser is the sheet after Sign in. Both are local to the page.
async function openAddAccount(page: Page, signIn?: string) {
  await page.getByRole('button', { name: 'Add account' }).click()
  if (signIn) {
    await page.getByRole('button', { name: signIn }).click()
    await page.getByText('Finish signing in in your browser.').waitFor()
  }
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsAddAccountDuplicate is the sheet after Sign in with Claude, once the engine has refused an account Kernel already has (KERNEL-619).
async function addDuplicate(page: Page) {
  await page.getByRole('button', { name: 'Add account' }).click()
  await page.getByRole('button', { name: 'Sign in with Claude' }).click()
  await page.getByText('That account is already in Kernel').waitFor()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsProvidersMenu is Personal's menu open, SettingsProvidersRename its name turned into a field and SettingsProvidersRemove its Remove
// asking first. The menu, the field and the dialog are local to the page, so click them open.
async function personalMenu(page: Page, item?: string) {
  await page.getByRole('button', { name: 'More for Personal' }).click()
  if (item) await page.getByRole('menuitem', { name: item }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SearchSwitchAccount is the palette with "switch" typed. The query is local to the palette.
async function typeSwitch(page: Page) {
  await page.getByRole('combobox', { name: 'Type a command or search' }).fill('switch')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// RoomSetupTeam is drawn with the Reviewer picker open. Its open state is local to the picker, so click it open.
async function openReviewer(page: Page) {
  await page.getByRole('button', { name: 'Reviewer' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// GroupedRowStatus is drawn with the pointer on the Client portal login row, once its card has opened (KERNEL-630).
async function hoverRow(page: Page, row: string) {
  await page.locator('.chat-row', { hasText: row }).hover()
  await page.locator('.hover-card').waitFor()
  await page.waitForTimeout(300)
}

// WorkspaceHistoryButtonsNarrow is the sidebar at its 200px minimum, where Hide sidebar, Back and Forward have the least room (KERNEL-643).
async function narrowSidebar(page: Page) {
  const handle = page.getByRole('separator', { name: 'Resize sidebar' })
  await handle.focus()
  await page.keyboard.press('Home')
  await handle.blur()
  await page.waitForTimeout(300)
}

const interactions: Record<string, (page: Page, app: ElectronApplication) => Promise<void>> = {
  GroupedRowStatus: (page) => hoverRow(page, 'Client portal login'),
  RoomSetupTeam: openReviewer,
  PanelCompare: openCompare,
  LeadNoChatsBranch: openBaseBranch,
  PanelFilter: filterChanges,
  SettingsAddAccountApiKey: typeApiKey,
  SettingsAddAccount: (page) => openAddAccount(page),
  SettingsAddAccountBrowser: (page) => openAddAccount(page, 'Sign in with Claude'),
  SettingsAddAccountCodex: (page) => openAddAccount(page),
  SettingsAddAccountCodexBrowser: (page) => openAddAccount(page, 'Sign in with ChatGPT'),
  SettingsAddAccountDuplicate: addDuplicate,
  SettingsProvidersRename: (page) => personalMenu(page, 'Rename'),
  SettingsProvidersMenu: (page) => personalMenu(page),
  SettingsProvidersRemove: (page) => personalMenu(page, 'Remove'),
  SearchSwitchAccount: typeSwitch,
  GroupedChatArchive: hoverChatRow,
  HeaderBranchTooltip: hoverTitle,
  TurnFilesHover: hoverAndFocusRows,
  PanelResize: hoverSplitHandle,
  WorkspaceHistoryButtonsNarrow: narrowSidebar,
  PanelTabsOverflow: narrowPanel,
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
  WorkspaceSharedImageZoom: zoomImage,
  WorkspaceSharedVersions: openVersions,
  WorkspaceKernelNoteOpen: openKernelNote,
  WorkspaceQuestion: pickFirstOption,
  WorkspaceQuestionStates: questionStates,
  WorkspaceQuestionSteps: stepToSecondQuestion,
  WorkspaceQuestionOther: typeOtherAnswer,
  WorkspaceRowsOpen: (page) => openRows(page, ['Thinking', 'Run unit tests', 'Edit table.tsx']),
  WorkspaceRowsFolded: (page) => openRows(page, ['Thinking', 'Message', 'Edit table.tsx']),
  WorkspaceReadImageTab: (page) => clickReadImage(page, 'image.png'),
  WorkspaceReadImageMissing: (page) => clickReadImage(page, 'image-2.png'),
  WorkspaceScrolledUp: scrollUp,
  SettingsTeamOrigins: (page) => scrollToSection(page, 'In this repo'),
  SettingsTeamOwnAgents: (page) => scrollToSection(page, 'In this repo'),
  ChatRail: async (page) => { await readFromMessage(page, 'Change of method for the conflict'); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  ChatRailOpen: async (page) => { await readFromMessage(page, 'Change of method for the conflict'); await openRail(page, 'Reword that in plain words') },
  ChatRailLead: (page) => openRail(page, 'Kai, opened PR #162')
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
    // Settings is a lazy chunk. App shows the boot shell with data-lazy until the chunk has loaded, and its data
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
