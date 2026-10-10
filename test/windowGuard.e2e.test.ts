import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// KERNEL-208: the window keeps to the app's own page, and the bridge answers only that page. It builds the app into out/
// and launches Electron on a fixture with the window hidden, so it is off by default, like the other click-throughs:
//   KERNEL_E2E=1 pnpm test test/windowGuard.e2e.test.ts
describe.skipIf(!process.env.KERNEL_E2E || process.platform !== 'darwin')('the window and the bridge', () => {
  let app: ElectronApplication
  let page: Page
  let data: string

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { stdio: 'pipe', encoding: 'utf8' })
    expect(build.status, build.stdout + build.stderr).toBe(0)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ELECTRON_RENDERER_URL') env[k] = v
    data = mkdtempSync(join(tmpdir(), 'kernel-fixture-'))
    Object.assign(env, { KERNEL_FIXTURES: 'QuickAskOpenChat', KERNEL_HEADLESS: '1', KERNEL_FIXTURE_DATA: data })
    app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env })
    page = await app.firstWindow()
    await page.waitForSelector('html[data-fixture="ready"]', { state: 'attached', timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await app?.close().catch(() => undefined)
    if (data) rmSync(data, { recursive: true, force: true })
  })

  const invoke = (channel: string, req?: unknown) => page.evaluate(([c, r]) => (window as any).kernel.invoke(c, r).then(() => 'ok', (e: Error) => e.message), [channel, req] as const)

  it('stays on the app when the page tries to load a dropped HTML file', async () => {
    const before = page.url()
    const dropped = join(data, 'dropped.html')
    writeFileSync(dropped, '<p>not Kernel</p>')
    await page.evaluate((url) => { location.href = url }, pathToFileURL(dropped).href)
    await page.waitForTimeout(500)
    expect(page.url()).toBe(before)
    expect(await invoke('rooms.list')).toBe('ok')
  })

  it('hands only http and https links to the browser', async () => {
    // Record what would open instead of opening a browser.
    await app.evaluate(({ shell }) => { const opened: string[] = ((globalThis as any).opened = []); shell.openExternal = async (url: string) => { opened.push(url) } })
    await page.evaluate(() => { window.open('file:///Applications/Calculator.app'); window.open('javascript:alert(1)'); window.open('https://example.com/a') })
    expect(await invoke('system.openExternal', { url: 'file:///Applications/Calculator.app' })).toContain('only opens http and https links')
    expect(await invoke('system.openExternal', { url: 'javascript:alert(1)' })).toContain('only opens http and https links')
    expect(await invoke('system.openExternal', { url: 'https://example.com/b' })).toBe('ok')
    expect(await invoke('system.openExternal', { url: 'http://localhost:4312/' })).toBe('ok')
    await expect.poll(() => app.evaluate(() => (globalThis as any).opened)).toEqual(['https://example.com/a', 'https://example.com/b', 'http://localhost:4312/'])
    expect(app.windows()).toHaveLength(1)
  })

  it('refuses to open a file outside every room and workspace in the editor', async () => {
    expect(await invoke('system.openInEditor', { path: '/System/Applications/Calculator.app' })).toContain('inside a room or workspace')
    expect(await invoke('system.openInEditor', { path: 'relative/run.command' })).toContain('inside a room or workspace')
  })

  it('refuses every call from a page that is not the app', async () => {
    // A load started from the main process skips will-navigate, which is how a page that got in some other way looks.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.loadURL('data:text/html,<p>not Kernel</p>'))
    expect(await invoke('rooms.list')).toContain('refused rooms.list')
    expect(await invoke('system.pickFolder')).toContain('refused system.pickFolder')
    expect(await invoke('system.pickImage')).toContain('refused system.pickImage')
    expect(await invoke('rooms.setIcon', { roomId: 'r', icon: { kind: 'image', path: '/etc/hosts' } })).toContain('refused rooms.setIcon')
  })
})
