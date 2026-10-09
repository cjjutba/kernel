import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// KERNEL-146: a click-through of Ask Rowan's Open chat in the real app, on a fixture, with the window hidden. It builds the app into
// out/ and launches Electron, so it is off by default, where it could collide with a `pnpm shots --no-build` run or another build.
// It runs on a Mac only, where Kernel runs:
//   KERNEL_E2E=1 pnpm test test/quickAskOpenChat.test.ts
describe.skipIf(!process.env.KERNEL_E2E || process.platform !== 'darwin')('Ask Rowan, Open chat', () => {
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

  /** Titles of the selected chat tabs. aria-selected is the state a person sees as the underlined tab. */
  const selected = (page: Page) => page.getByRole('tablist', { name: 'Chats and files' }).getByRole('tab').evaluateAll((tabs) => tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent ?? ''))
  const openChat = (page: Page) => page.getByRole('dialog', { name: 'Ask Rowan' }).getByRole('button', { name: /^Open (full )?chat$/ }).click()

  it('lands on the chat the question went to, from another workspace', async () => {
    const page = await launch('QuickAskOpenChat')
    // Start in invoice-table: the Lead's workspace is not on screen.
    await page.getByRole('tab', { name: /Invoice table/ }).waitFor()
    expect(await selected(page)).toEqual([expect.stringContaining('Invoice table')])
    await openChat(page)
    // The Lead's workspace has two chats, and the second is the one the question went to.
    await page.getByRole('tab', { name: /Status question/ }).waitFor()
    await expect.poll(() => selected(page)).toEqual([expect.stringContaining('Status question')])
  }, 60_000)

  it('leaves the tab alone when the Lead cannot be opened', async () => {
    const page = await launch('QuickAskLeadGone')
    await page.getByRole('tab', { name: /Invoice table/ }).waitFor()
    await openChat(page)
    await page.getByText(/Could not open/).first().waitFor()
    // Still in invoice-table. A tab id from another workspace would leave no tab selected.
    expect(await selected(page)).toEqual([expect.stringContaining('Invoice table')])
  }, 60_000)
})
