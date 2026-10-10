import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// KERNEL-199: a click-through of Settings and workspace switches in the real app, on a fixture, with the window hidden. It builds the app into
// out/ and launches Electron, so it is off by default, where it could collide with a `pnpm shots --no-build` run or another build.
// It runs on a Mac only, where Kernel runs:
//   KERNEL_E2E=1 pnpm test test/navMemory.test.ts
describe.skipIf(!process.env.KERNEL_E2E || process.platform !== 'darwin')('Back to where you were (KERNEL-199)', () => {
  let app: ElectronApplication | undefined
  let data: string | undefined

  beforeAll(() => {
    const build = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { stdio: 'pipe', encoding: 'utf8' })
    expect(build.status, build.stdout + build.stderr).toBe(0)
  }, 120_000)

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    if (data) rmSync(data, { recursive: true, force: true })
    app = undefined
  })

  async function launch(fixture: string): Promise<Page> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ELECTRON_RENDERER_URL') env[k] = v
    data = mkdtempSync(join(tmpdir(), 'kernel-fixture-'))
    Object.assign(env, { KERNEL_FIXTURES: fixture, KERNEL_HEADLESS: '1', KERNEL_FIXTURE_DATA: data })
    app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env })
    const page = await app.firstWindow()
    await page.waitForSelector('html[data-fixture="ready"]', { state: 'attached', timeout: 15_000 })
    return page
  }

  /** Titles of the selected chat and file tabs. aria-selected is the state a person sees as the underlined tab. */
  const selected = (page: Page) => page.getByRole('tablist', { name: 'Chats and files' }).getByRole('tab').evaluateAll((tabs) => tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent ?? ''))
  const tabs = (page: Page) => page.getByRole('tablist', { name: 'Chats and files' }).getByRole('tab')
  const settings = (page: Page) => page.getByRole('navigation', { name: 'Settings' })
  const onPage = (page: Page, name: string) => expect.poll(() => settings(page).getByRole('button', { name }).getAttribute('aria-current')).toBe('page')

  it('Back to app and Esc return to the chat Settings was opened from', async () => {
    const page = await launch('NavMemory')
    await tabs(page).filter({ hasText: 'Third chat' }).click()
    await expect.poll(() => selected(page)).toEqual([expect.stringContaining('Third chat')])

    // ⌘, then another page, then Back to app.
    await page.keyboard.press('Meta+,')
    await settings(page).waitFor()
    await settings(page).getByRole('button', { name: 'Models and effort' }).click()
    await onPage(page, 'Models and effort')
    await settings(page).getByRole('button', { name: 'Back to app' }).click()
    await expect.poll(() => selected(page)).toEqual([expect.stringContaining('Third chat')])

    // ⌘, reopens the page it was on, and Esc leaves. A text field keeps its own Esc.
    await page.keyboard.press('Meta+,')
    await onPage(page, 'Models and effort')
    const search = settings(page).getByRole('textbox', { name: 'Search settings' })
    await search.fill('mod')
    await page.keyboard.press('Escape')
    await expect.poll(() => search.inputValue()).toBe('')
    await settings(page).waitFor()
    await page.keyboard.press('Escape')
    await settings(page).waitFor({ state: 'detached' })
    await expect.poll(() => selected(page)).toEqual([expect.stringContaining('Third chat')])
  }, 60_000)

  it('keeps the chat after visiting another workspace', async () => {
    const page = await launch('NavMemory')
    await tabs(page).filter({ hasText: 'Second chat' }).click()
    await page.getByRole('navigation').getByRole('button', { name: /invoice-table/i }).first().click()
    await page.getByRole('tab', { name: /Invoice table/ }).waitFor()
    // ⌘⇧L opens the Lead's workspace on the tab it showed, not its first chat.
    await page.keyboard.press('Meta+Shift+L')
    await expect.poll(() => selected(page)).toEqual([expect.stringContaining('Second chat')])
  }, 60_000)
})
