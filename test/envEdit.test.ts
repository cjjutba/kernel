import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// KERNEL-254: Edit on an Environment page must not read the saved value until Show is pressed. The fixture's `env.reveal` always throws
// "Fixture mode has no values to show.", so a reveal at any point shows that message under the Value field. It builds the app into out/
// and launches Electron, so it is off by default, like the other click-throughs (navMemory.test.ts). It runs on a Mac only:
//   KERNEL_E2E=1 pnpm test test/envEdit.test.ts
describe.skipIf(!process.env.KERNEL_E2E || process.platform !== 'darwin')('Edit keeps the saved value hidden (KERNEL-254)', () => {
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

  it('opens with an empty value, and Show is what asks for the saved one', async () => {
    const page = await launch('SettingsRoomEnvironment')
    await page.getByRole('button', { name: 'Edit DATABASE_URL' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit DATABASE_URL' })
    await dialog.waitFor()
    const value = dialog.getByRole('textbox', { name: 'Value' })
    expect(await value.inputValue()).toBe('')
    expect(await value.getAttribute('placeholder')).toBe('Type a new value')
    // Nothing has asked main for the value: the fixture's refusal would be on screen.
    expect(await dialog.getByRole('alert').count()).toBe(0)

    await dialog.getByRole('button', { name: 'Show the saved value' }).click()
    await expect.poll(() => dialog.getByRole('alert').textContent()).toContain('Fixture mode has no values to show.')
  }, 60_000)

  it('does not save an empty value over the saved one', async () => {
    const page = await launch('SettingsRoomEnvironment')
    await page.getByRole('button', { name: 'Edit DATABASE_URL' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit DATABASE_URL' })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => dialog.getByRole('alert').textContent()).toContain('Type the new value')
    expect(await dialog.isVisible()).toBe(true)
  }, 60_000)
})
