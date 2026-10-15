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

// WorkspaceJustSent: a send arrives while the chat is open, which is what anchors the message at the top (KERNEL-803).
async function sendMessage(page: Page, app: ElectronApplication) {
  await page.waitForTimeout(300)
  await app.evaluate(({ BrowserWindow }, item) => BrowserWindow.getAllWindows()[0]?.webContents.send('kernel:event', { type: 'chat.item', chatId: 'chat-invoice-table', item }), { kind: 'user', id: 'js-u', ts: Date.now() - 2000, parts: [{ type: 'text', text: 'Now add a CSV export for the filtered rows.' }] })
  await page.waitForTimeout(1200)
}

// WorkspaceJustSentDone: the send, a short reply and the end of the turn arrive, and the message stays at the top (KERNEL-837).
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

// WorkspaceNewChatJustSent: the first message is typed on New chat and sent, and the chat that opens anchors it like any send (KERNEL-825).
async function sendFromNewChat(page: Page) {
  await page.waitForTimeout(300)
  await page.getByRole('textbox').first().fill('Add a CSV export for the filtered invoice rows.')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
}

// WorkspaceLeaveAndReturn: a send and its short reply, then another tab and back. The message must sit where it did, and the padding is back before the view is (leaving and coming back).
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

// WorkspacePlanApproveDraft has text in the box, so pressing Approve asks "Approve without your changes?" in the strip (KERNEL-833). The question is local to the strip.
async function askApprove(page: Page) {
  await page.getByRole('button', { name: /^Approve/ }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(700)
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

// LeadPrsNarrow is the PRs tab with the panel at its narrowest, 320px (KERNEL-757). Home on the panel's handle takes it there.
async function panelAtNarrowest(page: Page) {
  const handle = page.getByRole('separator', { name: 'Resize panel' })
  await handle.focus()
  await page.keyboard.press('Home')
  await handle.blur()
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


// NewChatRoomPicker, NewChatMode, NewChatBranch and NewChatPlus are New chat with the room menu, the + menu or one of its Run in and Branch pickers open (KERNEL-786).
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
// NewChatKeyboard drives the room picker and the + menu's Run in row with the keyboard only and throws when a step does not do what it should: a picker opens on Enter,
// Escape closes it and gives the focus back to its button, Enter on a row picks it, and the room pick moves the breadcrumb and the route.
async function driveWhereByKeyboard(page: Page) {
  const key = (k: string) => page.keyboard.press(k)
  const room = () => page.getByRole('button', { name: /^Room:/ })
  const must = async (ok: boolean, what: string) => { if (!ok) throw new Error(`NewChatKeyboard: ${what}`) }
  const crumb = () => page.locator('.ws-crumb, header').first().innerText()
  const before = await room().getAttribute('aria-label')

  await room().focus(); await key('Enter')
  await page.getByRole('menuitemradio', { name: /Client B/ }).first().waitFor()
  await key('Escape')
  await must(await page.getByRole('menuitemradio', { name: /Client B/ }).count() === 0, 'Escape did not close the room picker')
  await must(await room().evaluate((el) => el === document.activeElement), 'Escape did not return focus to the room button')

  await key('Enter')
  await page.getByRole('menuitemradio', { name: /Client B/ }).first().waitFor()
  // Arrows walk the rows from the top, so the focus lands on Client B within a few presses.
  for (let i = 0; i < 6 && !(await page.getByRole('menuitemradio', { name: /Client B/ }).first().evaluate((el) => el === document.activeElement)); i++) await key('ArrowDown')
  await must(await page.getByRole('menuitemradio', { name: /Client B/ }).first().evaluate((el) => el === document.activeElement), 'ArrowDown did not reach Client B')
  await key('Enter')
  await page.waitForTimeout(200)
  await must((await room().getAttribute('aria-label')) !== before, 'Enter did not pick the room')
  await must((await crumb()).includes('Client B'), 'the breadcrumb did not follow the room pick')

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
// NewChatEffortMenu and NewChatPermissionMenu are New chat with the effort or the permission menu open.
async function openEffortMenu(page: Page) {
  await openWhere(page, /^Effort:/, /High/)
}
async function openPermissionMenu(page: Page) {
  await openWhere(page, /^Permission mode:/, /Accept edits/)
}
async function pickBuildHere(page: Page) {
  await page.getByRole('button', { name: 'Build here' }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}
async function openBranchMenu(page: Page) {
  await openPlusPicker(page, /^Branch/, /invoice-table/)
  // The row with a workspace shows Open workspace while it is the active one, as on hover or focus.
  await page.getByRole('menuitemradio', { name: /t-12-invoice-schema/ }).focus()
  await page.waitForTimeout(300)
}
async function pickBranchChip(page: Page) {
  await openPlusPicker(page, /^Branch/, /invoice-table/)
  await page.getByRole('menuitemradio', { name: /t-14-invoice-table/ }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// LeadNoChatsBranch is New chat with Kernel with the + menu's Branch picker open, main checked. The menu is the composer's own, so open it and wait for the
// remote's branches, which the menu reads when it opens.
async function openBaseBranch(page: Page) {
  await openPlusPicker(page, /^Branch/, /invoice-table/)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsAddAccountApiKey is the Add account sheet on its API key step with a name and a key typed. The sheet and what is typed in it are local to the page (KERNEL-524).
async function typeApiKey(page: Page) {
  await pickAddAccount(page, 'API key', 0)
  await page.locator('#acct-label').fill('Work key')
  await page.locator('#acct-key').fill('sk-ant-api03-5f1c9d27a0b84e63')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// Add account's menu lists Subscription and API key under Claude Code, then under Codex (KERNEL-680). `nth` 0 is Claude Code's, 1 Codex's.
async function pickAddAccount(page: Page, kind: 'Subscription' | 'API key', nth: 0 | 1) {
  await page.getByRole('button', { name: 'Add account' }).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${kind}`) }).nth(nth).click()
}

// The Add account sheets (KERNEL-561): the sheet is opened from the page's menu, and Browser is the sheet after Sign in. Both are local to the page.
async function openAddAccount(page: Page, nth: 0 | 1, signIn?: string) {
  await pickAddAccount(page, 'Subscription', nth)
  if (signIn) {
    await page.getByRole('button', { name: signIn }).click()
    await page.getByText('Finish signing in in your browser.').waitFor()
  }
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsAddAccountDuplicate is the sheet after Sign in with Claude, once the engine has refused an account Kernel already has (KERNEL-619).
async function addDuplicate(page: Page) {
  await pickAddAccount(page, 'Subscription', 0)
  await page.getByRole('button', { name: 'Sign in with Claude' }).click()
  await page.getByText('That account is already in Kernel').waitFor()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsAccountsMenu is Personal's menu open, SettingsAccountsRename its name turned into a field and SettingsAccountsRemove its Remove
// asking first. The menu, the field and the dialog are local to the page, so click them open.
async function personalMenu(page: Page, item?: string) {
  await page.getByRole('button', { name: 'More for Personal' }).first().click()
  if (item) await page.getByRole('menuitem', { name: item }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SettingsAccountsAlsoCli is Work's details open, where the Sign-in source line is. The open state is local to the page.
async function openDetails(page: Page, account: string) {
  await page.getByRole('button', { name: new RegExp(account) }).and(page.locator('.ac-disc')).first().click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SearchSwitchAccount is the palette with "switch" typed. The query is local to the palette.
async function typeSwitch(page: Page) {
  await page.getByRole('combobox', { name: 'Type a command or search' }).fill('switch')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

// SearchArchived is the palette with "archived" typed, which lists the archived workspaces.
async function typeArchived(page: Page) {
  await page.getByRole('combobox', { name: 'Type a command or search' }).fill('archived')
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

// UsageFooterNarrow is the window at 900px wide, where the footer's inline accounts fold into the "more" chip (KERNEL-697).
async function narrowWindow(page: Page, app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h), { w: 900, h: HEIGHT })
  await page.waitForTimeout(400)
}

// NewChatSwitchNarrow pins the chat column to 460px, which the window's minimum width never reaches on its own, to show the Hand off | Build here switch as two icons.
// NewChatNarrow and ComposerModesNarrow are the box with the window at 600px: the chat column is about 600px, where the permission name and the Hand off label give way to their icons.
const windowAt = (w: number) => async (page: Page, app: ElectronApplication) => {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h), { w, h: HEIGHT })
  await page.waitForTimeout(400)
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
  // A read that never finishes in time for the shot, so the placeholders are what shows.
  await page.evaluate(() => { FileReader.prototype.readAsDataURL = function () { /* never loads */ } })
  await page.locator('.cmp-input').evaluate((box) => {
    const dt = new DataTransfer()
    for (const n of ['invoice-table.png', 'staging-log.txt', 'Screenshot 2026-10-14 at 21.21.42.png']) dt.items.add(new File(['x'], n, { type: n.endsWith('.png') ? 'image/png' : 'text/plain' }))
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(300)
}

// The model picker's states that take a click: the legacy models folded under their row, the stars and the Favorites tab, and the dimmed provider's tooltip.
async function openLegacyModels(page: Page) {
  await page.getByRole('button', { name: /Legacy models/ }).click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
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
async function hoverLockedProvider(page: Page) {
  await page.getByRole('tab', { name: 'Codex' }).hover()
  await page.waitForTimeout(900)
}

const interactions: Record<string, (page: Page, app: ElectronApplication) => Promise<void>> = {
  ComposerDragOver: dragOverPane,
  WorkspaceModelPickerCodex: openLegacyModels,
  WorkspaceModelPickerKeys: async (page) => { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(300) },
  WorkspaceModelPickerFavorites: starModels,
  WorkspaceModelPickerLocked: hoverLockedProvider,
  ComposerAttaching: dropWhileReading,
  ConfirmOverrule: openOverrule,
  UsageFooterNarrow: narrowWindow,
  AuditSidebarWide: async (page) => { const h = page.getByRole('separator', { name: 'Resize sidebar' }); await h.focus(); await page.keyboard.press('End'); await h.blur(); await page.waitForTimeout(300) },
  AccountSwitching: async (page) => { await page.locator('.ft-other').first().click(); await page.waitForTimeout(200) },
  GroupedRowStatus: (page) => hoverRow(page, 'Client portal login'),
  RoomSetupTeam: openReviewer,
  PanelCompare: openCompare,
  LeadNoChatsBranch: openBaseBranch,
  NewChatRoomPicker: (page) => openWhere(page, /^Room:/, /Client B/),
  NewChatMode: (page) => openPlusPicker(page, /^Run in/, /Local/).then(() => page.mouse.move(0, 0)).then(() => page.waitForTimeout(300)),
  NewChatKeyboard: driveWhereByKeyboard,
  NewChatBranch: openBranchMenu,
  NewChatBranchChip: pickBranchChip,
  NewChatPlus: (page) => openWhere(page, 'Add context'),
  NewChatLinkIssue: async (page) => { await page.getByRole('button', { name: 'Add context' }).click(); await page.getByRole('menuitem', { name: /Link issue/ }).click(); await page.getByRole('listbox').waitFor(); await page.mouse.move(0, 0); await page.waitForTimeout(400) },
  NewChatEffortMenu: openEffortMenu,
  NewChatNarrow: windowAt(600),
  NewChatSwitchNarrow: async (page) => { await page.locator('.ws-main').evaluate((el) => { el.style.width = '460px'; el.style.justifySelf = 'start' }); await page.waitForTimeout(400) },
  ComposerModesNarrow: windowAt(600),
  NewChatPermissionMenu: openPermissionMenu,
  NewChatBuildHere: pickBuildHere,
  PanelFilter: filterChanges,
  SettingsAddAccountApiKey: typeApiKey,
  SettingsAddAccount: (page) => openAddAccount(page, 0),
  SettingsAddAccountBrowser: (page) => openAddAccount(page, 0, 'Sign in with Claude'),
  SettingsAddAccountCodex: (page) => openAddAccount(page, 1),
  SettingsAddAccountCodexBrowser: (page) => openAddAccount(page, 1, 'Sign in with ChatGPT'),
  SettingsAddAccountDuplicate: addDuplicate,
  SettingsAccountsAlsoCli: (page) => openDetails(page, 'Work'),
  SettingsAccountsRename: (page) => personalMenu(page, 'Rename'),
  SettingsAccountsMenu: (page) => personalMenu(page),
  SettingsAccountsRemove: (page) => personalMenu(page, 'Remove'),
  SearchSwitchAccount: typeSwitch,
  SearchArchived: typeArchived,
  GroupedChatArchive: hoverChatRow,
  HeaderBranchTooltip: hoverTitle,
  TurnFilesHover: hoverAndFocusRows,
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
  AuditQuestionPicked: async (page) => { await page.getByRole('radio', { name: 'Yes, invoice-009.pdf' }).click(); await page.mouse.move(0, 0) },
  AuditQuestionAnswerMotion: async (page) => { await page.getByRole('radio', { name: 'Yes, invoice-009.pdf' }).click({ force: true }); await page.locator('.tcard').getByRole('button', { name: 'Send', exact: true }).focus() },
  AuditRailJumpMotion: async (page) => { await page.getByRole('button', { name: 'Jump to message' }).focus() },
  WorkspacePlanApproveDraft: askApprove,
  WorkspaceQuestionSteps: stepToSecondQuestion,
  WorkspaceQuestionOther: typeOtherAnswer,
  LeadOpenItemsOpen: async (page) => { await page.getByRole('button', { name: /3 open/ }).click(); await page.waitForTimeout(200) },
  WorkspaceRowsOpen: (page) => openRows(page, ['Thought', 'Run unit tests', 'Edited']),
  WorkspaceRowsFolded: (page) => openRows(page, ['Thought', 'Edited']),
  WorkspaceTurnFoldedOpen: openEveryRow,
  WorkspaceTurnFoldedCopy: async (page) => {
    await page.locator('.trow-btn', { hasText: 'I will build the table first' }).focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.waitForTimeout(300)
  },
  WorkspaceStepCardBash: openEveryRow,
  WorkspaceStepCardMcp: openEveryRow,
  WorkspaceStepCardCodexDiff: openEveryRow,
  WorkspaceStepCardWrite: openEveryRow,
  WorkspaceDiffImageInlineOpen: async (page) => {
    await page.getByRole('button', { name: 'Open public/logo.png' }).click()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
  },
  WorkspaceReadImageTab: (page) => clickReadImage(page, 'image.png'),
  WorkspaceReadImageMissing: (page) => clickReadImage(page, 'image-2.png'),
  WorkspaceJustSent: sendMessage,
  WorkspaceJustSentLong: sendMessage,
  WorkspaceJustSentDone: sendAndFinish,
  WorkspaceNewChatJustSent: sendFromNewChat,
  WorkspaceLeaveAndReturn: leaveAndReturn,
  WorkspaceScrolledUp: scrollUp,
  ChatRestoredSpot: scrollUp,
  SettingsPRsSaving: (page) => leaveSizeLimit(page, '600'),
  SettingsPRsSaved: (page) => leaveSizeLimit(page, '600'),
  SettingsPRsSavedLight: (page) => leaveSizeLimit(page, '600'),
  SettingsPRsClamped: (page) => leaveSizeLimit(page, '999999'),
  SettingsRoomPrsSaved: async (page) => { await page.getByRole('switch', { name: 'UX review' }).click(); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  SettingsAccountsMoves: (page) => scrollToSection(page, 'Chats and accounts'),
  SettingsTeamOrigins: (page) => scrollToSection(page, 'In this repo'),
  SettingsTeamOwnAgents: (page) => scrollToSection(page, 'In this repo'),
  ChatRail: async (page) => { await readFromMessage(page, 'Change of method for the conflict'); await page.mouse.move(0, 0); await page.waitForTimeout(300) },
  ChatRailOpen: async (page) => { await readFromMessage(page, 'Change of method for the conflict'); await openRail(page, 'Reword that in plain words') },
  ChatRailLead: (page) => openRail(page, 'Kai, opened PR #162')
}

// Motion (KERNEL-831). A fixture's `motion` is an action and a length. CSS animations and transitions are paused as they start and
// stepped by time with Animation.currentTime, so a frame doesn't depend on how fast the capture runs. A smooth scroll is the
// compositor's, which can't be stepped: it runs in real time, and a frame in which a scroll offset moved is labelled "sampled".
const FPS = 30
type MotionAction = { click: string } | { press: string[] }
type Motion = { action: MotionAction; ms: number; area?: string }
interface Frame { n: number; ms: number; sampled: boolean; file: string }

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

async function runMotionAction(page: Page, action: MotionAction) {
  if ('click' in action) await page.getByRole('button', { name: action.click, exact: true }).click()
  else for (const key of action.press) await page.keyboard.press(key)
}

// The contact sheet is a page of its own in a hidden window of the same app: the frames in a grid, each with its number and time.
async function contactSheet(app: ElectronApplication, dir: string, name: string, frames: Frame[], size: { w: number; h: number }, out: string) {
  const cols = Math.min(4, Math.max(1, Math.round(1800 / size.w)))
  const cellW = Math.min(size.w, Math.floor(1800 / cols))
  const cells = frames.map((f) => `<figure><img src="${f.file}" width="${cellW}"><figcaption><b>${f.n}</b> ${f.ms} ms${f.sampled ? ' <i>sampled</i>' : ''}</figcaption></figure>`).join('')
  writeFileSync(join(dir, 'sheet.html'), `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;background:#fff;color:#111;font:13px/1.3 ui-monospace,Menlo,monospace}
    h1{font:600 14px/1 ui-monospace,Menlo,monospace;margin:0 0 12px}
    main{display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:12px;width:max-content}
    figure{margin:0}img{display:block;border:1px solid #ccc}figcaption{padding-top:4px}i{color:#a60}
  </style><h1>${name} motion: ${frames.length} frames, ${FPS} per second</h1><main>${cells}</main>`)
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
    await runMotionAction(page, motion.action)
    await page.waitForTimeout(150)
    const area = motion.area ? await page.locator(motion.area).first().boundingBox() : null
    const pad = 24
    const clip = area ? { x: Math.max(0, area.x - pad), y: Math.max(0, area.y - 120), width: Math.min(WIDTH, area.width + pad * 2), height: Math.min(HEIGHT, area.height + 120 + pad) } : { x: 0, y: 0, width: WIDTH, height: HEIGHT }
    const frames: Frame[] = []
    for (let i = 0; i * 1000 / FPS <= motion.ms; i++) {
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
    const made = spawnSync(ffmpeg, ['-y', '-v', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%03d.png'), '-vf', 'scale=min(iw\\,960):-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', gif])
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
    // Screens load their own data on mount (loadRoom, loadWorkspace, changes). Give those calls a moment to land.
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
