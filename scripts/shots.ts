// Screenshot harness (KERNEL-7). Runs on plain Node with built-in type stripping, so only erasable TypeScript here.
//
//   pnpm shots Workspace Main          build, then capture shots/<Screen>.png for each fixture
//   pnpm shots --all                   every fixture
//   pnpm shots --no-build Main         reuse the last build
//   pnpm shots --theme light Main      capture in the light theme, saved as shots/<Screen>.light.png
//   pnpm shots WorkspacePlanApprove --motion   run the fixture's `motion` action, save shots/<Screen>-motion.png (contact sheet) and -motion.gif

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = join(root, 'shots')
const WIDTH = 1440
const HEIGHT = 900

// pnpm passes a `--` through (`pnpm shots -- Main`), so drop it.
const args = process.argv.slice(2).filter((a) => a !== '--')
const flags = new Set(args.filter((a) => a.startsWith('--')))
const themeAt = args.indexOf('--theme')
const theme = themeAt >= 0 ? args[themeAt + 1] : undefined
if (theme !== undefined && theme !== 'light' && theme !== 'dark') throw new Error('--theme takes light or dark')
const suffix = theme === 'light' ? '.light' : ''
const names = args.filter((a, i) => !a.startsWith('--') && (themeAt < 0 || i !== themeAt + 1))
// Plain Node cannot import fixtures/index.ts (extensionless imports), so read the keys: one `  Name:` line per fixture.
const fixtureNames = () => new Set(readdirSync(join(root, 'fixtures')).filter((f) => f.endsWith('.ts')).flatMap((f) => [...readFileSync(join(root, 'fixtures', f), 'utf8').matchAll(/^ {2}([A-Z]\w+):/gm)].map((m) => m[1])))
const allFixtures = () => [...fixtureNames()].sort()
// A fixture with motion declares it on its own line (`Name: { ...scene(..), motion: { ... } },`), so `--motion --all` can pick them without launching every screen.
const motionFixtures = () => readdirSync(join(root, 'fixtures')).filter((f) => f.endsWith('.ts')).flatMap((f) => [...readFileSync(join(root, 'fixtures', f), 'utf8').matchAll(/^ {2}([A-Z]\w+):.*\bmotion: \{/gm)].map((m) => m[1])).sort()

// Screens that need a click to reach the state in the shot, such as a chat row opened in place. That state is local to the
// component, so a fixture can't set it.
async function openRows(page: Page, rows: string[]) {
  for (const row of rows) await page.locator('.trow-btn', { hasText: row }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// Every step row that can open, in order, so a fixture's shot doesn't depend on the words a row says.
async function openEveryRow(page: Page) {
  const rows = page.locator('.trow-btn:not(:disabled)')
  const n = await rows.count()
  for (let i = 0; i < n; i++) await rows.nth(i).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// A hover preview open: the pointer on the named control. Focus stays out, so a preview shows from the pointer only.
async function hoverPreview(page: Page, target: ReturnType<Page['locator']>) {
  await target.first().hover()
  await page.waitForTimeout(300)
}

// WorkspaceScrolledUp is a long chat read from higher up. The scroll position is the transcript's own, so wheel it up like a reader would.
async function scrollUp(page: Page) {
  await page.locator('.ws-scroll').hover()
  await page.mouse.wheel(0, -600)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// KERNEL-952 scroll baselines. A tall plan is read from its task list before the round trip; a revised plan and a turn's end arrive on a chat read from higher up.
async function scrollToTasks(page: Page) {
  await page.waitForTimeout(1500)
  await page.locator('.ws-scroll').evaluate((box) => {
    const tasks = [...box.querySelectorAll('*')].filter((e) => /T-15a/.test(e.textContent ?? '')).pop()
    if (tasks) box.scrollTop += tasks.getBoundingClientRect().top - box.getBoundingClientRect().top - 16
  })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
async function reducedMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(300)
}
async function copyImage(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 100
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#888'
    ctx.fillRect(0, 0, 160, 100)
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
  await focusComposer(page)
}
async function toEnd(page: Page) {
  await page.waitForTimeout(1500)
  await page.locator('.ws-scroll').evaluate((box) => { box.scrollTop = box.scrollHeight })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(1500)
}

// ChatNewMessages: the chat is read from higher up while two replies, a teammate's message and some steps arrive. Only the three messages are counted (KERNEL-922).
async function scrollUpAndReceive(page: Page, app: ElectronApplication) {
  await scrollUp(page)
  const push = (item: object) => app.evaluate(({ BrowserWindow }, i) => BrowserWindow.getAllWindows()[0]?.webContents.send('kernel:event', { type: 'chat.item', chatId: 'chat-invoice-table', item: i }), item)
  await push({ kind: 'tool', id: 'nm-t1', ts: Date.now(), toolUseId: 'toolu_nm1', name: 'Bash', label: 'Ran tests', detail: 'pnpm test', status: 'done', durationMs: 100 })
  await push({ kind: 'text', id: 'nm-r1', ts: Date.now(), text: 'The export is wired to the table menu.' })
  await push({ kind: 'tool', id: 'nm-t2', ts: Date.now(), toolUseId: 'toolu_nm2', name: 'Bash', label: 'Ran lint', detail: 'pnpm lint', status: 'done', durationMs: 100 })
  await push({ kind: 'text', id: 'nm-r2', ts: Date.now(), text: 'Tests pass for the CSV rows.' })
  await push({ kind: 'text', id: 'nm-r3', ts: Date.now(), text: 'One more thing: the header row is included.' })
  await page.waitForTimeout(500)
}

// WorkspaceJustSent: a send arrives while the chat is open, and the view stays at its end (KERNEL-891).
async function sendMessage(page: Page, app: ElectronApplication) {
  await page.waitForTimeout(300)
  await app.evaluate(({ BrowserWindow }, item) => BrowserWindow.getAllWindows()[0]?.webContents.send('kernel:event', { type: 'chat.item', chatId: 'chat-invoice-table', item }), { kind: 'user', id: 'js-u', ts: Date.now() - 2000, parts: [{ type: 'text', text: 'Now add a CSV export for the filtered rows.' }] })
  await page.waitForTimeout(1200)
}

// WorkspaceJustSentDone: the send, a short reply and the end of the turn arrive, and the view stays at its end (KERNEL-891).
async function sendAndFinish(page: Page, app: ElectronApplication) {
  const push = (event: object) => app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0]?.webContents.send('kernel:event', e), event)
  await page.waitForTimeout(300)
  await push({ type: 'chat.running', chatId: 'chat-invoice-table', running: true })
  await push({ type: 'chat.item', chatId: 'chat-invoice-table', item: { kind: 'user', id: 'jd-u', ts: Date.now() - 2000, parts: [{ type: 'text', text: 'Now add a CSV export for the filtered rows.' }] } })
  await page.waitForTimeout(1500)
  await push({ type: 'chat.item', chatId: 'chat-invoice-table', item: { kind: 'text', id: 'jd-r', ts: Date.now(), text: 'Done. The filtered rows export as CSV from the table menu.' } })
  await push({ type: 'chat.running', chatId: 'chat-invoice-table', running: false })
  await page.waitForTimeout(1200)
}

// WorkspaceNewChatJustSent: the first message is typed on New chat and sent, and the chat that opens shows it at the top (KERNEL-891).
async function sendFromNewChat(page: Page) {
  await page.waitForTimeout(300)
  await page.getByRole('textbox').first().fill('Add a CSV export for the filtered invoice rows.')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
}

// WorkspaceLeaveAndReturn: a send and its short reply, then another tab and back. The chat must open at its end, where it was left (KERNEL-765).
async function leaveAndReturn(page: Page, app: ElectronApplication) {
  const push = (event: object) => app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0]?.webContents.send('kernel:event', e), event)
  await page.waitForTimeout(300)
  await push({ type: 'chat.running', chatId: 'chat-invoice-table', running: true })
  await push({ type: 'chat.item', chatId: 'chat-invoice-table', item: { kind: 'user', id: 'lr-u', ts: Date.now() - 2000, parts: [{ type: 'text', text: 'Now add a CSV export for the filtered rows.' }] } })
  await page.waitForTimeout(1500)
  await push({ type: 'chat.item', chatId: 'chat-invoice-table', item: { kind: 'text', id: 'lr-r', ts: Date.now(), text: 'Done. The filtered rows export as CSV from the table menu.' } })
  await push({ type: 'chat.running', chatId: 'chat-invoice-table', running: false })
  await page.waitForTimeout(800)
  await page.getByRole('tab', { name: 'Empty state copy' }).click()
  await page.waitForTimeout(500)
  await page.getByRole('tab').first().click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(800)
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

// WorkspaceQuestionSteps is drawn on question 1 of 3 with its pick kept: a single-select pick moves on, so the pager goes back to it; the step is local to the card.
async function stepToSecondQuestion(page: Page) {
  await page.getByRole('radio', { name: 'File it as its own issue' }).click()
  await page.getByRole('button', { name: 'Show question 1' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// WorkspaceKernelNoteOpen is the Kernel note opened to its full text, which is local to the note.
async function openKernelNote(page: Page) {
  await page.locator('.knote').first().click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// WorkspaceQuestion is drawn with option 1 picked, which is local to the card, so Send is ready.
async function pickFirstOption(page: Page) {
  await page.getByRole('radio', { name: 'File it as its own issue' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// WorkspacePlanApproveDraft has text in the box, so pressing Approve asks "Approve without your changes?" in the strip (KERNEL-833). The question is local to the strip.
async function askApprove(page: Page) {
  await page.getByRole('button', { name: /^Approve/ }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(700)
}

// WorkspaceQuestionStates is option 1 picked, option 3 focused from the keyboard and option 2 hovered (KERNEL-676).
async function questionStates(page: Page) {
  await page.getByRole('radio', { name: 'File it as its own issue' }).click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.getByRole('radio', { name: /Leave it/ }).hover()
  await page.waitForTimeout(300)
}

// WorkspaceQuestionOther is drawn on question 3 with the first two answered and a Something else answer typed.
async function typeOtherAnswer(page: Page) {
  await page.getByRole('radio', { name: 'File it as its own issue' }).click()
  await page.getByRole('radio', { name: 'The release candidate from Friday' }).click()
  await page.getByRole('radio', { name: 'Something else' }).click()
  await page.getByRole('textbox', { name: 'Your answer' }).fill('Only moved shots, plus the review screen')
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

async function blurFocus(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.waitForTimeout(200)
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

// The list shots (KERNEL-871) focus the first row and press Down once, so the ring is a keyboard ring on the second row.
async function focusListRow(page: Page) {
  await page.locator('[data-list-row]').first().focus()
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
}

// HeaderBranchTooltip is the header with the open chat tab hovered, long enough for the tooltip to open, which names the branch (KERNEL-413, Redesign 09).
async function hoverTitle(page: Page) {
  await page.getByRole('tab', { selected: true }).first().hover()
  await page.locator('.tooltip').waitFor()
  await page.waitForTimeout(300)
}

// PanelResize is the handle between the right panel's panes with the pointer on it, long enough for the glow to arrive (KERNEL-513).
async function hoverSplitHandle(page: Page) {
  await page.getByRole('separator', { name: 'Resize bottom panel' }).hover()
  await page.waitForTimeout(400)
}

// PanelTabsOverflow is the right panel at its narrowest, 320px, where the tab strips run out of space (KERNEL-514). Home on the panel's handle takes it there, as it does from the keyboard.
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

// LeadPrsNarrow is the PRs tab with the panel at its narrowest, 320px (KERNEL-757). Home on the panel's handle takes it there.
async function panelAtNarrowest(page: Page) {
  const handle = page.getByRole('separator', { name: 'Resize panel' })
  await handle.focus()
  await page.keyboard.press('Home')
  await handle.blur()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(400)
}

// PanelFilter is Changes with the filter open and "journey" typed. Both are local to the tab, so open the field from the search button and type, as a person would (KERNEL-515).
async function filterIn(page: Page, button: string, text: string) {
  await page.getByRole('button', { name: button }).click()
  if (text) await page.getByRole('textbox', { name: button }).fill(text)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
const filterChanges = (page: Page) => filterIn(page, 'Filter changed files', 'journey')

// The compare menu (Pen 9.17, 9.21): open from the toolbar's "Against main", then one of its pages or picks. Whether it is open is local to the tab.
async function openCompare(page: Page, then?: (page: Page) => Promise<void>) {
  await page.getByRole('button', { name: 'Compare changes' }).click()
  await page.getByRole('menu', { name: 'Compare changes' }).waitFor()
  await then?.(page)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(400)
}
const compareBranches = (page: Page) => openCompare(page, async (p) => { await p.getByRole('menuitem', { name: /^Target branch/ }).click(); await p.getByRole('menu', { name: 'Target branch' }).waitFor() })
const compareCommits = (page: Page) => openCompare(page, async (p) => { await p.getByRole('menuitem', { name: 'Commits' }).click(); await p.getByRole('menuitemradio').first().waitFor() })
const compareUncommitted = (page: Page) => openCompare(page, (p) => p.getByRole('menuitemradio', { name: /^Uncommitted changes/ }).click())
const compareOneCommit = (page: Page) => openCompare(page, async (p) => { await p.getByRole('menuitem', { name: 'Commits' }).click(); await p.getByRole('menuitemradio').first().click() })

// The panel's own states that take a click (Pen 9.21): the Files filter with its scope, and what a filter with no match says.
const filesFilter = (page: Page) => filterIn(page, 'Filter files', '')
const filesNoMatch = (page: Page) => filterIn(page, 'Filter files', 'zebra')
const changesNoMatch = (page: Page) => filterIn(page, 'Filter changed files', 'zebra')

// WorkspaceSharedPanel is the Session rail with its Shared files row opened, which lists every file Teng shared. The row is local to the rail.
async function openSharedList(page: Page) {
  await page.getByRole('button', { name: /^Shared files/ }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// BottomPanelRunMenu is the Run split's menu, below its chevron.
async function openRunMenu(page: Page) {
  await page.getByRole('button', { name: 'Run scripts', exact: true }).click()
  await page.getByRole('menu', { name: 'Run scripts' }).waitFor()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// TabRename is the open chat tab turned into its field by a double click.
async function renameTab(page: Page) {
  await page.getByRole('tab', { selected: true }).first().dblclick()
  const field = page.getByRole('textbox', { name: 'Tab name' })
  await field.fill('Review fixes')
  await page.waitForTimeout(300)
}

// FileViewSendToAgent is a file with its last lines selected, which brings up Send to agent. The selection is the page's own, so make it as a drag would.
async function selectLines(page: Page) {
  const view = page.getByRole('region', { name: /^Contents of / })
  await view.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(200)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.code-line .src')]
    const from = rows[rows.length - 4]
    const to = rows[rows.length - 2]
    const range = document.createRange()
    range.setStart(from.firstChild ?? from, 0)
    range.setEnd(to.firstChild ?? to, (to.textContent ?? '').length)
    const sel = document.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await page.getByRole('button', { name: 'Send to agent' }).waitFor()
  await page.waitForTimeout(300)
}

// FileLinkSecret and FileLinkMissing are a link in the reply pressed: a file that may hold secrets asks first, and one that is gone says so in a toast.
const pressLink = (name: string, wait: 'dialog' | 'toast') => async (page: Page) => {
  await page.getByRole('button', { name }).click()
  if (wait === 'dialog') await page.getByRole('alertdialog').or(page.getByRole('dialog')).first().waitFor()
  else await page.waitForTimeout(600)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// NewChatProjectPicker, NewChatMode, NewChatBranch and NewChatPlus are New chat with the project menu, the + menu or one of its Run in and Branch pickers open (KERNEL-786).
// NewChatLocal has Local picked, which shows the chip beside +. NewChatBranchChip picks a branch from the + menu and shows its chip.
async function openWhere(page: Page, name: string | RegExp, item?: string | RegExp) {
  await page.getByRole('button', { name }).click()
  if (item) await page.getByRole('menuitemradio', { name: item }).first().waitFor()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
// Opens the + menu and one of its rows, Run in or Branch, then waits for that picker's rows.
async function openPlusPicker(page: Page, row: RegExp, ready: RegExp) {
  await page.getByRole('button', { name: 'Add context' }).click()
  await page.getByRole('menuitem', { name: row }).click()
  await page.getByRole('menuitemradio', { name: ready }).first().waitFor()
}
// NewChatKeyboard drives the project picker and the + menu's Run in row with the keyboard only and throws when a step does not do what it should: a picker opens on Enter,
// Escape closes it and gives the focus back to its button, Enter on a row picks it, and the project pick moves the breadcrumb and the route.
async function driveWhereByKeyboard(page: Page) {
  const key = (k: string) => page.keyboard.press(k)
  const project = () => page.getByRole('button', { name: /^Project:/ })
  const must = async (ok: boolean, what: string) => { if (!ok) throw new Error(`NewChatKeyboard: ${what}`) }
  const crumb = () => page.locator('.ws-crumb, header').first().innerText()
  const before = await project().getAttribute('aria-label')

  await project().focus(); await key('Enter')
  await page.getByRole('menuitemradio', { name: /Client B/ }).first().waitFor()
  await key('Escape')
  await must(await page.getByRole('menuitemradio', { name: /Client B/ }).count() === 0, 'Escape did not close the project picker')
  await must(await project().evaluate((el) => el === document.activeElement), 'Escape did not return focus to the project button')

  await key('Enter')
  await page.getByRole('menuitemradio', { name: /Client B/ }).first().waitFor()
  // Arrows walk the rows from the top, so the focus lands on Client B within a few presses.
  for (let i = 0; i < 6 && !(await page.getByRole('menuitemradio', { name: /Client B/ }).first().evaluate((el) => el === document.activeElement)); i++) await key('ArrowDown')
  await must(await page.getByRole('menuitemradio', { name: /Client B/ }).first().evaluate((el) => el === document.activeElement), 'ArrowDown did not reach Client B')
  await key('Enter')
  await page.waitForTimeout(200)
  await must((await project().getAttribute('aria-label')) !== before, 'Enter did not pick the project')
  await must((await crumb()).includes('Client B'), 'the breadcrumb did not follow the project pick')

  // The + button opens its menu on Enter, ArrowDown walks to Run in, Enter opens the picker and Enter on Local picks it. Focus comes back to +, and the chip says Local.
  const plus = page.getByRole('button', { name: 'Add context' })
  const focused = (loc: ReturnType<Page['getByRole']>) => loc.evaluate((el) => el === document.activeElement)
  await plus.focus(); await key('Enter')
  const runIn = page.getByRole('menuitem', { name: /^Run in/ })
  await runIn.waitFor()
  for (let i = 0; i < 8 && !(await focused(runIn)); i++) await key('ArrowDown')
  await must(await focused(runIn), 'ArrowDown did not reach Run in')
  await key('Enter')
  const local = page.getByRole('menuitemradio', { name: /Local/ }).first()
  await local.waitFor()
  for (let i = 0; i < 4 && !(await focused(local)); i++) await key('ArrowDown')
  await key('Enter')
  await page.waitForTimeout(200)
  await must(await page.getByRole('button', { name: /^Run in Local/ }).count() === 1, 'Enter did not pick Local, so there is no chip')
  await must(await focused(plus), 'the + button did not get the focus back')

  await page.getByRole('textbox').first().click()
  await page.keyboard.type('Check the invoice export')
  // Cmd+Enter sends: the send button turns to its busy label while Kernel answers.
  await key('Meta+Enter')
  await page.getByRole('button', { name: /Sending|Checking/ }).waitFor({ timeout: 2000 }).catch(() => must(false, 'Cmd+Enter did not send'))
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
// NewChatBuildHere is New chat with Build here picked on the Hand off | Build here switch (KERNEL-805).
// NewChatPermissionMenu is New chat with the permission menu open.
async function openPermissionMenu(page: Page) {
  await openWhere(page, /^Permission mode:/, /Accept edits/)
}
async function pickBuildHere(page: Page) {
  await page.getByRole('button', { name: 'Build here' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
async function openBranchMenu(page: Page) {
  await page.getByRole('button', { name: 'Build here' }).click()
  await openPlusPicker(page, /^Branch/, /invoice-table/)
  // The row with a workspace shows Open workspace while it is the active one, as on hover or focus.
  await page.getByRole('menuitemradio', { name: /t-12-invoice-schema/ }).focus()
  await page.waitForTimeout(300)
}
async function pickBranchChip(page: Page) {
  await page.getByRole('button', { name: 'Build here' }).click()
  await openPlusPicker(page, /^Branch/, /invoice-table/)
  await page.getByRole('menuitemradio', { name: /t-14-invoice-table/ }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// LeadNoChatsBranch is New chat with Kernel with the + menu's Branch picker open, main checked. The menu is the composer's own, so open it and wait for the
// remote's branches, which the menu reads when it opens.
async function openBaseBranch(page: Page) {
  await page.getByRole('button', { name: 'Build here' }).click()
  await openPlusPicker(page, /^Branch/, /invoice-table/)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// The Add an account dialog (Redesign 15, Pen 15.5): the page's Add account row opens three cards, and Continue opens the step the pick needs. The dialog and the pick are local to the page.
async function openAddAccount(page: Page, opts: { pick?: string; next?: string | true } = {}) {
  await page.getByRole('button', { name: 'Add account' }).click()
  await page.getByRole('dialog', { name: 'Add an account' }).waitFor()
  if (opts.pick) await page.getByRole('radio', { name: new RegExp(opts.pick) }).click()
  if (opts.next) {
    await page.getByRole('button', { name: 'Continue' }).click()
    if (typeof opts.next === 'string') await page.getByText(opts.next).waitFor()
  }
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
// SettingsAddAccountApiKey is the dialog on its API key step with a key typed.
async function typeApiKey(page: Page) {
  await openAddAccount(page, { pick: 'API key', next: true })
  await page.locator('#acct-key').fill('sk-ant-api03-5f1c9d27a0b84e634f2a')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsAccountsMenu is 2nd account's menu open, SettingsAccountsRename its name turned into a field and SettingsAccountsRemove its Remove
// asking first. The menu, the field and the dialog are local to the page, so click them open.
async function secondMenu(page: Page, item?: string) {
  await page.getByRole('button', { name: 'More for 2nd account' }).first().click()
  if (item) await page.getByRole('menuitem', { name: item }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsAccountsAdvanced is the folded Advanced section opened. The fold is local to the page.
async function openAdvanced(page: Page) {
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.waitForTimeout(300)
}

// The palette with a scope tab pressed, or words typed. Both are local to the palette (KERNEL-1098).
async function pickScope(page: Page, name: string) {
  await page.getByRole('tablist', { name: 'Search in' }).getByRole('tab', { name, exact: true }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
async function typeInPalette(page: Page, text: string) {
  await page.getByRole('combobox', { name: 'Type a command or search' }).fill(text)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// IssuesTrackerNoRemote and IssuesTrackerSignedOut are the Work header with the pointer on the dimmed GitHub side, long enough for its tooltip, which says why it is off (KERNEL-1098).
async function hoverTracker(page: Page) {
  await page.getByRole('radio', { name: /^GitHub, unavailable/ }).hover()
  await page.locator('.tooltip').waitFor()
  await page.waitForTimeout(300)
}

// SearchSwitchAccount is the palette with "account" typed. The query is local to the palette.
async function typeSwitch(page: Page) {
  await page.getByRole('combobox', { name: 'Type a command or search' }).fill('account')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SearchArchived is the palette with "datatable" typed, which finds one archived workspace and nothing else (Pen 12.7).
async function typeArchived(page: Page) {
  await page.getByRole('combobox', { name: 'Type a command or search' }).fill('datatable')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// GroupedRowStatus is drawn with the pointer on the Client portal login row, once its card has opened (KERNEL-630).
async function hoverRow(page: Page, row: string) {
  await page.locator('.chat-row', { hasText: row }).hover()
  await page.locator('.hover-card').waitFor()
  await page.waitForTimeout(300)
}

async function hoverLeadSwitch(page: Page) {
  await page.locator('.cmp-switch-side').last().hover()
  await page.waitForTimeout(800)
}

async function hoverFileChip(page: Page) {
  await page.locator('.cmp-chip[data-tip]').first().hover()
  await page.waitForTimeout(800)
}

// WorkspaceHistoryButtonsNarrow is the sidebar at its 200px minimum, where Hide sidebar, Back and Forward have the least project (KERNEL-643).
async function narrowSidebar(page: Page) {
  const handle = page.getByRole('separator', { name: 'Resize sidebar' })
  await handle.focus()
  await page.keyboard.press('Home')
  await handle.blur()
  await page.waitForTimeout(300)
}

// UsageFooter is the Usage button with the pointer on it, long enough for the hover card to open (Pen 14.1, KERNEL-1101).
async function hoverUsage(page: Page) {
  await page.getByRole('button', { name: /^Usage\./ }).hover()
  await page.waitForTimeout(900)
}

// NewChatSwitchNarrow pins the chat column to 460px, which the window's minimum width never reaches on its own, to show the Hand off | Build here switch as two icons.
// NewChatNarrow and ComposerModesNarrow are the box with the window at 600px: the chat column is about 600px, where the permission name and the Hand off label give way to their icons.
const windowAt = (w: number) => async (page: Page, app: ElectronApplication) => {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h), { w, h: HEIGHT })
  await page.waitForTimeout(400)
}

// SettingsPRsInstructions is Create PR's sheet with a space added at the end of its text and left, so the footer says Saved (Redesign 15).
async function editInstructions(page: Page) {
  await page.getByRole('button', { name: 'Edit the Create PR instructions' }).click()
  const field = page.getByRole('textbox', { name: 'Create PR' })
  await field.press('Control+End')
  await field.pressSequentially(' ')
  await field.evaluate((el) => el.blur())
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsBigTerminalPreset is Add command with a name and a command typed (Redesign 15).
async function addCommand(page: Page) {
  await page.getByRole('button', { name: 'Add command' }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill('Dev server logs')
  await page.getByRole('textbox', { name: 'Command' }).fill('tail -f logs/dev.log')
  await page.waitForTimeout(300)
}

// A long Settings page drawn at its full length (Redesign 15): the window grows to the height of the page, so nothing on it is cut and the shot is as long as the page. `then` runs first.
const fullLength = (then?: (page: Page, app: ElectronApplication) => Promise<void>) => async (page: Page, app: ElectronApplication) => {
  await then?.(page, app)
  const h = await page.locator('.set-page').evaluate((el) => (el as HTMLElement).scrollHeight)
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h), { w: WIDTH, h: Math.max(HEIGHT, h + 80) })
  await page.waitForTimeout(500)
}

// SettingsPRsSaving, Saved and Clamped are Size limit typed and left (KERNEL-721). The note is local to the field. Saving holds main's answer back.
async function leaveSizeLimit(page: Page, text: string) {
  const field = page.getByRole('textbox', { name: 'Size limit' })
  await field.fill(text)
  await field.evaluate((el) => el.blur())
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

async function openOverrule(page: Page) {
  await page.getByRole('button', { name: 'Overrule' }).click()
  await page.getByRole('alertdialog').waitFor()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// Files over the chat pane (KERNEL-815). The overlay and the placeholders are local to the composer, so the shot starts the drag and the drop itself.
async function dragOverPane(page: Page) {
  await page.locator('.ws-main').evaluate((pane) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'invoice-table.png', { type: 'image/png' }))
    pane.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
  })
  await page.waitForTimeout(300)
}
async function dropWhileReading(page: Page) {
  // An image read that never finishes in time for the shot, so the token shows as it lands with Attaching, before the read fills it in.
  await page.evaluate(() => { FileReader.prototype.readAsDataURL = function () { /* never loads */ } })
  await page.locator('.cmp-input').evaluate((box) => {
    const dt = new DataTransfer()
    for (const n of ['Review.png']) dt.items.add(new File(['x'], n, { type: 'image/png' }))
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(300)
}

// The model picker's states that take a click: the legacy models flyout, the stars and the Favorites tab, and the dimmed provider's tooltip.
async function openLegacyModels(page: Page) {
  await page.getByRole('button', { name: /Legacy models/ }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
// Settings, Models (KERNEL-988, KERNEL-1056): the Kernel row's Claude or Codex cell opens a picker for that provider.
async function openRolePicker(page: Page, provider = 'Claude Code', legacy = false, row = 'Kernel') {
  await page.getByRole('button', { name: new RegExp(`^${row} ${provider} model`) }).click()
  if (legacy) await page.getByRole('button', { name: /Legacy models/ }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
// KERNEL-995: the Backend row's count opens the agents popover, a row's chip opens its picker, and the Effort and Compact at rows open their flyouts.
async function openRoleAgents(page: Page, row = 'Backend') {
  await page.getByRole('row', { name: row, exact: true }).getByRole('button', { name: /, on / }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
async function openRoleEffort(page: Page, row: string) {
  await page.getByRole('row', { name: row }).getByRole('button', { name: new RegExp(`^${row} Claude Code model`) }).click()
  await page.getByRole('radio', { name: 'High', exact: true }).hover()
  await page.waitForTimeout(500)
}
async function starModels(page: Page) {
  for (const name of ['Opus 5.5', 'Haiku 5.5']) {
    const row = page.getByRole('option', { name: new RegExp(name) })
    await row.hover()
    await row.locator('xpath=following-sibling::button').click()
  }
  await page.getByRole('tab', { name: 'Favorites' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
async function openEffortFlyout(page: Page) {
  await page.getByRole('radio', { name: 'High', exact: true }).hover()
  await page.waitForTimeout(500)
}
async function hoverLockedProvider(page: Page) {
  await page.getByRole('tab', { name: 'Codex' }).hover()
  await page.waitForTimeout(900)
}

const interactions: Record<string, (page: Page, app: ElectronApplication) => Promise<void>> = {
  ProjectSetupDetails: async (page) => { await page.getByRole('button', { name: 'Details' }).click(); await page.waitForTimeout(300) },
  ConnectRepoNoMatch: async (page) => { await page.getByPlaceholder('Search').fill('kernel-docs'); await page.waitForTimeout(500) },
  ConnectRepoCloning: async (page) => { await page.getByRole('radio').first().click(); await page.getByRole('button', { name: /^Clone repo/ }).click(); await page.waitForTimeout(300) },
  ComposerDragOver: dragOverPane,
  // Part 8 (KERNEL-1095): a box with a draft shows the caret, and a menu over the word being typed reads the caret, so the shots focus the box.
  ChatComposer: focusComposer,
  // A popover opened without a pointer takes the focus ring on its first control, which a person who clicked doesn't see.
  WorkspaceContextRingNear: async (page) => { await page.locator('.ctx-ring').hover(); await page.waitForTimeout(900) },
  WorkspaceContextPopover: blurFocus,
  WorkspaceContextPopoverFull: blurFocus,
  ContextPopoverEmpty: blurFocus,
  // Part 10 (KERNEL-1097): the pull request menus open without a pointer, so the first item doesn't wear a ring, and Continue says what it does on hover.
  WorkspacePRMenu: blurFocus,
  CreatePrMenu: blurFocus,
  ContinueAfterMerge: async (page) => { await page.getByRole('button', { name: 'Continue', exact: true }).hover(); await page.waitForTimeout(900) },
  WorkspaceReplyMenu: async (page) => { await page.getByRole('menuitem', { name: 'Fork into new tab' }).hover(); await page.waitForTimeout(300) },
  WorkspaceRevertMenu: async (page) => { await page.getByRole('menuitem', { name: 'Revert files to here' }).hover(); await page.waitForTimeout(300) },
  ComposerPlusMenu: async (page) => { await page.getByRole('menuitem', { name: /Add attachment/ }).hover(); await page.waitForTimeout(300) },
  WorkspaceMention: focusComposer,
  ComposerMentionFolders: focusComposer,
  ComposerMentionReference: focusComposer,
  WorkspaceSlash: focusComposer,
  WorkspaceIssueChip: focusComposer,
  WorkspacePaste: focusComposer,
  WorkspacePasteWrap: focusComposer,
  WorkspacePasteAfter: focusComposer,
  ComposerChipKinds: focusComposer,
  ComposerFileMixed: focusComposer,
  ComposerFilePdf: focusComposer,
  ComposerFileCap: focusComposer,
  ComposerFileUnreadable: focusComposer,
  WorkspaceModelPickerLegacy: openLegacyModels,
  SettingsModels: fullLength(),
  SettingsModelsPicker: (page) => openRolePicker(page),
  SettingsModelsPickerCodex: (page) => openRolePicker(page, 'Codex', false, 'Frontend'),
  // The picker opens on a legacy pick with the Legacy models group already open.
  SettingsModelsPickerLegacy: (page) => openRolePicker(page, undefined, false, 'Backend'),
  SettingsModelsAgents: (page) => openRoleAgents(page),
  SettingsModelsAgentsNone: (page) => openRoleAgents(page, 'QA'),
  SettingsModelsFallback: (page) => scrollToSection(page, 'At a limit'),
  SettingsModelsAgentTeams: (page) => scrollToSection(page, 'Teamwork'),
  SettingsAgentSaveScope: async (page) => { await page.getByLabel('Description').fill('Builds UI and checks each screen.'); await page.getByRole('button', { name: /^Save changes/ }).click(); await page.getByRole('dialog', { name: 'Save changes to Christian' }).waitFor(); await page.mouse.move(0, 0); await page.waitForTimeout(400) },
  SettingsModelsPickerEffort: (page) => openRoleEffort(page, 'Kernel'),
  SettingsModelsPickerEffortCodex: async (page) => {
    await page.getByRole('button', { name: /^Frontend Codex model/ }).click()
    await page.getByRole('radio', { name: 'High', exact: true }).hover()
    await page.waitForTimeout(500)
  },
  SettingsModelsPickerBoth: async (page) => { await openRolePicker(page); await page.getByRole('tab', { name: 'Codex' }).click(); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  SettingsModelsPickerCompact: async (page) => { await openRolePicker(page, undefined, false, 'QA'); await page.getByPlaceholder('Search models').fill('hai'); await page.waitForTimeout(300) },
  NewAgentDrafting: async (page) => { await page.getByRole('button', { name: 'Draft with Kernel' }).click(); await page.getByRole('button', { name: 'Drafting' }).waitFor() },
  NewAgentPicker: async (page) => { await page.getByRole('button', { name: /^Model, / }).click(); await page.getByRole('dialog').last().waitFor() },
  SettingsAgentEditPicker: async (page) => { await page.getByRole('button', { name: /^Model and effort, / }).click() },
  SettingsModelsPickerCodexRole: async (page) => { await openRolePicker(page, undefined, false, 'Frontend'); await page.getByRole('tab', { name: 'Codex' }).click(); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  SettingsModelsNarrow: windowAt(720),
  WorkspaceModelPickerKeys: async (page) => { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(300) },
  WorkspaceModelPickerFavorites: starModels,
  WorkspaceModelPickerEffort: openEffortFlyout,
  WorkspaceModelPickerLocked: hoverLockedProvider,
  ComposerAttaching: dropWhileReading,
  ComposerFileTip: hoverFileChip,
  NewChatSwitchTip: hoverLeadSwitch,
  ConfirmOverrule: openOverrule,
  UsageFooter: hoverUsage,
  AuditSidebarWide: async (page) => { const h = page.getByRole('separator', { name: 'Resize sidebar' }); await h.focus(); await page.keyboard.press('End'); await h.blur(); await page.waitForTimeout(300) },
  GroupedRowStatus: (page) => hoverRow(page, 'Client portal login'),
  PanelCompare: (page) => openCompare(page),
  CompareMenu: (page) => openCompare(page),
  CompareBranches: compareBranches,
  CompareCommits: compareCommits,
  CompareNothingUncommitted: compareUncommitted,
  CompareCommitNoFiles: compareOneCommit,
  FilesToolbar: filesFilter,
  FilesFilterNoMatch: filesNoMatch,
  ChangesFilterNoMatch: changesNoMatch,
  WorkspaceSharedPanel: openSharedList,
  BottomPanelRunMenu: openRunMenu,
  TabRename: renameTab,
  FileViewSendToAgent: selectLines,
  FileLinkSecret: pressLink('Open .env.local', 'dialog'),
  FileLinkMissing: pressLink('Open src/fixtures.ts', 'toast'),
  LeadNoChatsBranch: openBaseBranch,
  NewChatProjectPicker: (page) => openWhere(page, /^Project:/, /Client B/),
  NewChatMode: (page) => openPlusPicker(page, /^Run in/, /Local/).then(() => page.mouse.move(0, 0)).then(() => page.waitForTimeout(300)),
  NewChatKeyboard: driveWhereByKeyboard,
  NewChatBranch: openBranchMenu,
  NewChatBranchChip: pickBranchChip,
  NewChatPlus: (page) => openWhere(page, 'Add context'),
  NewChatLinkIssue: async (page) => { await page.getByRole('button', { name: 'Add context' }).click(); await page.getByRole('menuitem', { name: /Link issue/ }).click(); await page.getByRole('listbox').waitFor(); await page.mouse.move(0, 0); await page.waitForTimeout(400) },
  NewChatNarrow: windowAt(600),
  NewChatSwitchNarrow: async (page) => { await page.locator('.ws-main').evaluate((el) => { el.style.width = '460px'; el.style.justifySelf = 'start' }); await page.waitForTimeout(400) },
  ComposerModesNarrow: windowAt(600),
  NewChatPermissionMenu: openPermissionMenu,
  NewChatBuildHere: pickBuildHere,
  PanelFilter: filterChanges,
  SettingsAccounts: fullLength(),
  SettingsAddAccountApiKey: typeApiKey,
  SettingsAddAccount: (page) => openAddAccount(page),
  SettingsAddAccountBrowser: (page) => openAddAccount(page, { next: 'Finish signing in to Claude in your browser' }),
  SettingsAddAccountCodex: (page) => openAddAccount(page),
  SettingsAddAccountCodexBrowser: (page) => openAddAccount(page, { next: 'Finish signing in to ChatGPT in your browser' }),
  SettingsAddAccountDuplicate: (page) => openAddAccount(page, { next: 'That account is already in Kernel.' }),
  SettingsAccountsRename: (page) => secondMenu(page, 'Rename'),
  SettingsAccountsMenu: (page) => secondMenu(page),
  SettingsAccountsRemove: (page) => secondMenu(page, 'Remove'),
  SettingsAccountsAdvanced: fullLength(openAdvanced),
  SettingsAccountsFallback: (page) => scrollToSection(page, 'Limits'),
  SettingsAccountsFallbackDisabled: (page) => scrollToSection(page, 'Limits'),
  SearchSwitchAccount: typeSwitch,
  SearchQuery: (page) => typeInPalette(page, 'invoice'),
  SearchNoMatches: (page) => typeInPalette(page, 'flux capacitor'),
  SearchScope: async (page) => { await pickScope(page, 'Shared'); await typeInPalette(page, 'invoice') },
  SearchShared: (page) => pickScope(page, 'Shared'),
  SearchArchived: typeArchived,
  GroupedChatArchive: hoverChatRow,
  HeaderBranchTooltip: hoverTitle,
  TurnFilesHover: hoverAndFocusRows,
  InboxRowFocused: focusListRow,
  InboxPlanDoc: async (page) => { await page.getByText('Plan ready: Export invoices as PDF').click(); await page.waitForTimeout(300) },
  IssuesRowFocused: focusListRow,
  InboxFilter: async (page) => { await page.keyboard.press('/'); await page.getByRole('searchbox', { name: 'Filter the inbox' }).fill('wants'); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  IssuesFilters: async (page) => { await page.getByRole('searchbox', { name: 'Search issues' }).fill('invoice'); await page.mouse.move(0, 0); await page.waitForTimeout(600) },
  IssuesFilteredEmpty: async (page) => { await page.getByRole('searchbox', { name: 'Search issues' }).fill('flux capacitor'); await page.mouse.move(0, 0); await page.waitForTimeout(600) },
  IssuesTrackerNoRemote: hoverTracker,
  IssuesTrackerSignedOut: hoverTracker,
  PullRequestsFilters: async (page) => { await page.getByRole('searchbox', { name: 'Filter pull requests' }).fill('invoice'); await page.mouse.move(0, 0); await page.waitForTimeout(400) },
  IssuesNoWork1280: windowAt(1280),
  ProjectsRowFocused: focusListRow,
  PullRequestsRowFocused: focusListRow,
  HistoryRowFocused: focusListRow,
  PanelResize: hoverSplitHandle,
  WorkspaceHistoryButtonsNarrow: narrowSidebar,
  PanelTabsOverflow: narrowPanel,
  LeadPrsNarrow: panelAtNarrowest,
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
  // UX audit motion runs: scroll up first so the button shows, and pick the first answer so Send is enabled.
  AuditScrollToBottomMotion: scrollUp,
  AuditQuestionPicked: async (page) => { await page.getByRole('radio', { name: 'File it as its own issue' }).click(); await page.mouse.move(0, 0) },
  AuditQuestionAnswerMotion: async (page) => { await page.getByRole('radio', { name: 'File it as its own issue' }).click({ force: true }); await page.locator('.tcard').getByRole('button', { name: 'Send', exact: true }).focus() },
  AuditRailJumpMotion: async (page) => { await page.getByRole('button', { name: 'Jump to message' }).focus() },
  AuditRailJumpSendMotion: async (page) => { await page.getByRole('button', { name: 'Jump to message' }).focus() },
  AuditGroupCollapseMotion: async (page) => { await page.locator('.fold-head').first().focus() },
  AuditGroupOpenMotion: async (page) => { await page.waitForTimeout(800); await page.locator('.fold-head').first().focus() },
  WorkspacePlanApproveDraft: askApprove,
  WorkspaceLeadStepOpen: async (page) => { await page.locator('.fold-head').first().click(); await page.locator('.step .trow-btn:not(:disabled)').first().click(); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  WorkspaceLeadStepsOpen: async (page) => { for (const g of await page.locator('.fold-head').all()) await g.click(); await openEveryRow(page) },
  WorkspaceQuestionSteps: stepToSecondQuestion,
  WorkspaceQuestionOther: typeOtherAnswer,
  LeadOpenItemsOpen: async (page) => { await page.getByRole('button', { name: /3 open/ }).click(); await page.waitForTimeout(200) },
  SettingsProjectPrsDefault: (page) => scrollToSection(page, 'Rules'),
  SettingsProjectPrsShared: (page) => scrollToSection(page, 'Rules'),
  SettingsProjectPrsDetails: async (page) => { await page.getByRole('button', { name: 'Show details of the code review' }).click(); await page.mouse.move(0, 0); await page.waitForTimeout(200) },
  WorkspaceRowsOpen: (page) => openRows(page, ['Ran step 6', 'Checked types']),
  WorkspaceTurnFoldedOpen: openEveryRow,
  WorkspaceTurnRunning: (page) => openRows(page, ['Ran steps 1 to 5']),
  WorkspaceToolCalls: (page) => openRows(page, ['test/journey.test.ts', 'Checked types']),
  WorkspaceHunks: (page) => openRows(page, ['test/journey.test.ts']),
  AuditLongOutput: openEveryRow,
  WorkspaceStepCardBash: openEveryRow,
  WorkspaceStepCardMcp: openEveryRow,
  WorkspaceStepCardCodexDiff: openEveryRow,
  WorkspaceStepCardWrite: openEveryRow,
  WorkspaceDiffImageInlineOpen: async (page) => {
    await page.getByRole('button', { name: 'Open public/logo.png' }).click()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
  },
  TeamUpdateNotReviewedTip: async (page) => { await page.locator('.tucard-ev', { hasText: 'Not reviewed' }).first().hover(); await page.waitForTimeout(900) },
  // KERNEL-1068: the breakdown opened from the keyboard, over the rows after the plan card.
  WorkspacePlanFinishedFollowed: async (page) => { await page.locator('.plan-attn-n').focus(); await page.waitForTimeout(300) },
  WorkspacePlanFinishedLong: async (page) => { await page.locator('.plan-attn-n').focus(); await page.waitForTimeout(300) },
  WorkspaceReadImagePreview: (page) => openRows(page, ['ReviewRc.png']),
  WorkspacePasteImagePreview: (page) => hoverPreview(page, page.getByRole('button', { name: 'Open ReviewRc.png' })),
  WorkspacePasteTextPreview: (page) => hoverPreview(page, page.getByRole('button', { name: 'Open pasted_text_1.txt' })),
  WorkspaceIssuePreview: (page) => hoverPreview(page, page.getByRole('button', { name: /^Open issue KERNEL-1084/ })),
  WorkspaceReadImageTab: async (page) => { await openRows(page, ['ReviewRc.png']); await page.getByRole('button', { name: 'Open in a tab' }).click(); await page.mouse.move(0, 0); await page.waitForTimeout(400) },
  WorkspaceReadImageMissing: (page) => openRows(page, ['ReviewRc.png']),
  WorkspaceJustSentLong: sendMessage,
  WorkspaceJustSentDone: sendAndFinish,
  WorkspaceNewChatJustSent: sendFromNewChat,
  WorkspaceLeaveAndReturn: leaveAndReturn,
  WorkspaceScrolledUp: scrollUp,
  WorkspaceChatSwitchWorkingMotion: async (page) => { await page.getByRole('tab', { name: 'Snapshot tests' }).click(); await page.waitForTimeout(500); await page.getByRole('tab', { name: 'Empty state copy' }).click(); await page.mouse.move(0, 0); await page.waitForTimeout(500) },
  WorkspaceChatSwitchSavedSpotMotion: async (page) => { await scrollUp(page); await page.getByRole('tab', { name: 'Empty state copy' }).click(); await page.mouse.move(0, 0); await page.waitForTimeout(500) },
  ChatRestoredSpot: scrollUp,
  ChatNewMessages: scrollUpAndReceive,
  WorkspaceScrollTallPlanRoundTripMotion: scrollToTasks,
  WorkspacePlanRoundTrip: toEnd,
  WorkspaceScrollPlanRoundTripMotion: toEnd,
  WorkspaceScrollRevisedPlanMotion: async (page) => { await toEnd(page); await scrollUp(page) },
  WorkspaceScrollComposerImageMotion: copyImage,
  WorkspaceScrollComposerLinesMotion: (page) => focusComposer(page),
  WorkspaceScrollComposerQueueMotion: (page) => focusComposer(page),
  WorkspaceScrollTurnFoldMotion: scrollUp,
  WorkspaceScrollPlanRoundTripReducedMotion: async (page) => { await reducedMotion(page); await toEnd(page) },
  SettingsGit: fullLength(),
  SettingsPRs: fullLength(),
  SettingsPRsInstructions: editInstructions,
  SettingsBigTerminalPreset: addCommand,
  SettingsPRsSaving: (page) => leaveSizeLimit(page, '600'),
  SettingsPRsSaved: (page) => leaveSizeLimit(page, '600'),
  SettingsPRsSavedLight: (page) => leaveSizeLimit(page, '600'),
  SettingsPRsClamped: (page) => leaveSizeLimit(page, '999999'),
  SettingsIntegrationsLinearToken: async (page) => { await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.getByLabel('Linear API token').fill('lin_api_abcdefghijkl'); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  SettingsMcpSetUp: async (page) => { await page.getByRole('button', { name: /^Sign in to Linear/ }).click(); await page.getByRole('dialog', { name: 'Set up Linear' }).waitFor(); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  SettingsProjectScripts: fullLength(),
  SettingsProjectScriptsRuns: (page) => scrollToSection(page, 'Run scripts'),
  SettingsPreviewUrlForm: async (page) => { await page.getByRole('button', { name: 'Add preview URL', exact: true }).click(); await page.getByRole('dialog', { name: 'Add preview URL' }).waitFor(); await page.getByRole('textbox', { name: 'Name' }).fill('Storybook'); await page.getByRole('textbox', { name: 'Address' }).fill('http://localhost:$((KERNEL_PORT + 1))'); await page.waitForTimeout(300) },
  SettingsProjectEnvironment: fullLength(),
  SettingsProjectSetupFiles: (page) => scrollToSection(page, 'Files to copy'),
  SettingsProjectSetupProduction: (page) => scrollToSection(page, 'Files to copy'),
  SettingsEnvironmentAdd: async (page) => { await page.getByRole('button', { name: 'Add env file', exact: true }).click(); await page.getByRole('textbox', { name: 'File' }).fill('.env.local'); await page.waitForTimeout(300) },
  SettingsProjectAgents: fullLength(),
  SettingsProjectAgentsRetired: fullLength(async (page) => { await page.getByRole('button', { name: /^Retired/ }).click() }),
  SettingsSkillsFailed: (page) => scrollToSection(page, 'Skills'),
  SettingsSkillsLoading: (page) => scrollToSection(page, 'Skills'),
  SettingsProjectPermissionsMode: async (page) => { await scrollToSection(page, 'Permissions'); await page.keyboard.press('Escape'); await page.getByRole('button', { name: /Use app default/ }).click(); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  SettingsRunScriptAdd: async (page) => { await page.getByRole('button', { name: 'Add run script', exact: true }).click(); await page.getByRole('dialog', { name: 'Add a run script' }).waitFor(); await page.getByRole('textbox', { name: 'Name' }).fill('storybook'); await page.getByRole('textbox', { name: 'Command' }).fill('pnpm storybook dev --port $KERNEL_PORT'); await page.waitForTimeout(300) },
  SettingsProjectPrsSaved: async (page) => { await page.getByRole('switch', { name: 'UX review' }).click(); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  SettingsAccountsMoves: (page) => scrollToSection(page, 'Chats and accounts'),
  SettingsTeamOrigins: (page) => scrollToSection(page, 'In this repo'),
  SettingsTeamOwnAgents: (page) => scrollToSection(page, 'In this repo'),
  // 8.6 and 8.13 (KERNEL-1095): the pointer on a mark shows its message beside the rail, and the list opens from the keyboard with the pointer on one of its rows.
  ChatRail: async (page) => { await readFromMessage(page, 'Post both shots on KERNEL-232'); await page.locator('.rail-m').nth(8).hover(); await page.waitForTimeout(300) },
  ChatRailOpen: async (page) => { await readFromMessage(page, 'Post both shots on KERNEL-232'); await page.locator('.rail-btn').focus(); await page.getByRole('option', { name: 'Post both shots on KERNEL-232 as well, so the Lead sees it.', exact: true }).hover(); await page.waitForTimeout(300) },
  ChatRailLead: (page) => openRail(page, 'Christian, opened PR #162')
}

// Motion (KERNEL-831). A fixture's `motion` is an action and a length. CSS animations and transitions are paused as they start and
// stepped by time with Animation.currentTime, so a frame doesn't depend on how fast the capture runs. A smooth scroll is the
// compositor's, which can't be stepped: it runs in real time, and a frame in which a scroll offset moved is labelled "sampled".
const FPS = 30
type MotionAction = { click: string } | { press: string[] } | { hold: string } | { push: unknown[] } | { steps: { label: string; events: unknown[] }[] }
type Motion = { action: MotionAction; ms: number; area?: string }
interface Frame { n: number; ms: number; sampled: boolean; file: string; label?: string }

// Pauses every animation the moment it appears, so none runs before its first stepped frame. One that was already running (a
// loop, a strip still opening) is settled first the way `animations: 'disabled'` does: a finite one finishes, a loop restarts.
async function freezeAnimations(page: Page) {
  await page.evaluate(() => {
    type Tracked = { birth: number | null; done: boolean }
    const tracked = new Map<Animation, Tracked>()
    const w = window as unknown as { __motion: { tracked: Map<Animation, Tracked>; scroll: Map<Element, number> } }
    w.__motion = { tracked, scroll: new Map() }
    // Timers run on the stepped clock too, or a fold that ends on a timeout (decideFold) would end in real time, long before its stepped frames (KERNEL-839).
    const vt = { now: 0, id: 1_000_000, queue: new Map<number, { at: number; run: () => void }>() }
    ;(window as unknown as { __vt: typeof vt }).__vt = vt
    window.setTimeout = ((fn: TimerHandler, ms = 0, ...args: unknown[]) => {
      const id = ++vt.id
      vt.queue.set(id, { at: vt.now + Number(ms), run: () => (typeof fn === 'function' ? fn(...args) : undefined) })
      return id
    }) as typeof window.setTimeout
    window.clearTimeout = ((id?: number) => { if (id !== undefined) vt.queue.delete(id) }) as typeof window.clearTimeout
    const take = () => {
      for (const a of document.getAnimations()) {
        if (tracked.has(a)) continue
        a.pause()
        tracked.set(a, { birth: null, done: false })
      }
    }
    for (const a of document.getAnimations()) {
      const end = a.effect?.getComputedTiming().endTime
      if (typeof end === 'number' && Number.isFinite(end)) { a.finish(); tracked.set(a, { birth: 0, done: true }) }
      else { a.currentTime = 0; a.pause(); tracked.set(a, { birth: 0, done: false }) }
    }
    const loop = () => { take(); requestAnimationFrame(loop) }
    loop()
  })
}

// Moves virtual time to `t`: animations found since the last step start now, each is set to its age, and one that has run its length
// finishes, which fires its animationend and transitionend as a real run would. Then two frames for what those events render, and
// again until nothing new appears. Returns whether a scroll offset moved since the last call.
async function stepTo(page: Page, t: number): Promise<boolean> {
  return page.evaluate(async (now) => {
    type Tracked = { birth: number | null; done: boolean }
    const m = (window as unknown as { __motion: { tracked: Map<Animation, Tracked>; scroll: Map<Element, number> } }).__motion
    const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const vt = (window as unknown as { __vt: { now: number; queue: Map<number, { at: number; run: () => void }> } }).__vt
    vt.now = now
    for (let pass = 0; pass < 4; pass++) {
      let found = false
      for (const [id, t] of [...vt.queue].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && vt.queue.delete(id)) { t.run(); found = true }
      for (const a of document.getAnimations()) if (!m.tracked.has(a)) { a.pause(); m.tracked.set(a, { birth: null, done: false }) }
      for (const [a, s] of m.tracked) {
        if (s.done) continue
        if (s.birth === null) { s.birth = now; found = true }
        const age = now - s.birth
        const end = a.effect?.getComputedTiming().endTime
        if (typeof end === 'number' && Number.isFinite(end) && age >= end) { a.finish(); s.done = true; found = true }
        else a.currentTime = age
      }
      await frames()
      if (!found && document.getAnimations().every((a) => m.tracked.has(a))) break
    }
    let moved = false
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight <= el.clientHeight) continue
      const before = m.scroll.get(el)
      if (before !== undefined && before !== el.scrollTop) moved = true
      m.scroll.set(el, el.scrollTop)
    }
    return moved
  }, t)
}

async function runMotionAction(page: Page, action: MotionAction, app: ElectronApplication) {
  if ('steps' in action) return
  if ('push' in action) await app.evaluate((_, events) => (globalThis as { kernelFixturePush?: (e: unknown[]) => void }).kernelFixturePush?.(events), action.push)
  else if ('click' in action) await page.getByRole('button', { name: action.click, exact: true }).or(page.getByRole('tab', { name: action.click })).click()
  else if ('hold' in action) { await page.getByRole('button', { name: action.hold, exact: true }).first().hover(); await page.mouse.down() }
  else for (const key of action.press) {
    if (key.startsWith('click:')) await page.getByRole('button', { name: key.slice(6), exact: true }).or(page.getByRole('tab', { name: key.slice(6) })).click()
    else await page.keyboard.press(key)
  }
}

// The contact sheet is a page of its own in a hidden window of the same app: the frames in a grid, each with its number and time.
async function contactSheet(app: ElectronApplication, dir: string, name: string, frames: Frame[], size: { w: number; h: number }, out: string) {
  const cols = Math.min(4, Math.max(1, Math.round(1800 / size.w)))
  const cellW = Math.min(size.w, Math.floor(1800 / cols))
  const cells = frames.map((f) => `<figure><img src="${f.file}" width="${cellW}"><figcaption><b>${f.n}</b> ${f.label ?? `${f.ms} ms`}${f.sampled ? ' <i>sampled</i>' : ''}</figcaption></figure>`).join('')
  writeFileSync(join(dir, 'sheet.html'), `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;background:#fff;color:#111;font:13px/1.3 ui-monospace,Menlo,monospace}
    h1{font:600 14px/1 ui-monospace,Menlo,monospace;margin:0 0 12px}
    main{display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:12px;width:max-content}
    figure{margin:0}img{display:block;border:1px solid #ccc}figcaption{padding-top:4px}i{color:#a60}
  </style><h1>${name} motion: ${frames.length} frames, ${frames[0]?.label ? 'one per step' : `${FPS} per second`}</h1><main>${cells}</main>`)
  const opened = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, file) => { void new BrowserWindow({ show: false, width: 1900, height: 1000 }).loadFile(file) }, join(dir, 'sheet.html'))
  const sheet = await opened
  await sheet.waitForLoadState('load')
  await sheet.waitForFunction(() => [...document.images].every((i) => i.complete))
  await sheet.setViewportSize({ width: 1900, height: 1000 }).catch(() => undefined)
  await sheet.screenshot({ path: out, fullPage: true })
}

function ffmpegPath(): string | undefined {
  for (const bin of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) if (spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0) return bin
  return undefined
}

async function captureMotion(page: Page, app: ElectronApplication, name: string, motion: Motion) {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-motion-'))
  try {
    await freezeAnimations(page)
    // Frame 0 is the instant the action lands. Its async answers (a push from main, a render) arrive while animations are held.
    await page.evaluate(() => {
      const w = window as unknown as { __live: string[] }
      w.__live = []
      const t0 = performance.now()
      const tick = () => {
        const v = document.querySelector('.ws-scroll')
        const row = v ? `${Math.round(v.scrollTop)}/${Math.round(v.scrollHeight - v.clientHeight)}${v.hasAttribute('data-opening') ? ' opening' : ''} anim${document.getAnimations().length}` : 'none'
        if (w.__live[w.__live.length - 1]?.split('@')[0] !== row) w.__live.push(`${row}@${Math.round(performance.now() - t0)}`)
        if (performance.now() - t0 < 900) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const steps = 'steps' in motion.action ? motion.action.steps : undefined
    if (!steps) await runMotionAction(page, motion.action, app)
    await page.waitForTimeout(150)
    console.log(`${name} live scrollTop/range (ms): ${(await page.evaluate(() => (window as unknown as { __live: string[] }).__live)).join(' ')}`)
    const area = motion.area ? await page.locator(motion.area).first().boundingBox() : null
    const pad = 24
    const clip = area ? { x: Math.max(0, area.x - pad), y: Math.max(0, area.y - 120), width: Math.min(WIDTH, area.width + pad * 2), height: Math.min(HEIGHT, area.height + 120 + pad) } : { x: 0, y: 0, width: WIDTH, height: HEIGHT }
    const frames: Frame[] = []
    if (steps) {
      // One frame for the screen as it opens, then one after each group of events, once what the group made React draw has settled.
      for (let i = 0; i <= steps.length; i++) {
        if (i > 0) { await app.evaluate((_, events) => (globalThis as { kernelFixturePush?: (e: unknown[]) => void }).kernelFixturePush?.(events), steps[i - 1].events); await page.waitForTimeout(250) }
        const file = `f${String(i).padStart(3, '0')}.png`
        await page.screenshot({ path: join(dir, file), clip, caret: 'hide' })
        frames.push({ n: i, ms: 0, sampled: false, file, label: i === 0 ? 'as it opens' : steps[i - 1].label })
      }
    } else for (let i = 0; i * 1000 / FPS <= motion.ms; i++) {
      const ms = Math.round(i * 1000 / FPS)
      const sampled = await stepTo(page, ms)
      const file = `f${String(i).padStart(3, '0')}.png`
      await page.screenshot({ path: join(dir, file), clip, caret: 'hide' })
      frames.push({ n: i, ms, sampled: i > 0 && sampled, file })
    }
    const sheetPath = join(shotsDir, `${name}-motion.png`)
    await contactSheet(app, dir, name, frames, { w: clip.width, h: clip.height }, sheetPath)
    console.log(`shots/${name}-motion.png (${frames.length} frames${frames.some((f) => f.sampled) ? `, ${frames.filter((f) => f.sampled).length} sampled` : ''})`)
    const ffmpeg = ffmpegPath()
    if (!ffmpeg) { console.log(`shots/${name}-motion.gif skipped: ffmpeg not found (brew install ffmpeg). The contact sheet is saved.`); return }
    const gif = join(shotsDir, `${name}-motion.gif`)
    const made = spawnSync(ffmpeg, ['-y', '-v', 'error', '-framerate', steps ? '1' : String(FPS), '-i', join(dir, 'f%03d.png'), '-vf', 'scale=min(iw\\,960):-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', gif])
    if (made.status === 0 && existsSync(gif)) console.log(`shots/${name}-motion.gif`)
    else console.log(`shots/${name}-motion.gif failed: ${made.stderr?.toString().trim().split('\n')[0] ?? 'ffmpeg exited'}. The contact sheet is saved.`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function capture(name: string): Promise<boolean> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ELECTRON_RENDERER_URL') env[k] = v
  env.KERNEL_FIXTURES = name
  if (name === 'SettingsPRsSaving') env.KERNEL_SLOW_SETTINGS = '1'
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
    // Screens load their own data on mount (loadProject, loadWorkspace, changes). Give those calls a moment to land.
    await page.waitForTimeout(500)
    await interactions[name]?.(page, app)
    await lazyLoaded()
    if (flags.has('--motion')) {
      const motion = (await app.evaluate(() => (globalThis as { kernelFixtureMotion?: unknown }).kernelFixtureMotion)) as Motion | undefined
      if (!motion) throw new Error('this fixture has no motion to capture. Add `motion: { action, ms }` to it')
      await captureMotion(page, app, name, motion)
      return true
    }
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
  const list = flags.has('--all') ? (flags.has('--motion') ? motionFixtures() : allFixtures()) : names
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

await shots()
