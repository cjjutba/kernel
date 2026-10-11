import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// KERNEL-288: a crash lands in the log, never in a blank window or Electron's raw dialog, and Help, Copy diagnostics copies
// the log with no token and no home path. It builds the app into out/ and launches Electron on a fixture with the window
// hidden and the log in a temp folder, so it is off by default, like the other click-throughs:
//   KERNEL_E2E=1 pnpm test test/crash.e2e.test.ts
describe.skipIf(!process.env.KERNEL_E2E || process.platform !== 'darwin')('crashes and the log', () => {
  let app: ElectronApplication
  let data: string
  let logs: string

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { stdio: 'pipe', encoding: 'utf8' })
    expect(build.status, build.stdout + build.stderr).toBe(0)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ELECTRON_RENDERER_URL') env[k] = v
    data = mkdtempSync(join(tmpdir(), 'kernel-fixture-'))
    logs = mkdtempSync(join(tmpdir(), 'kernel-logs-'))
    Object.assign(env, { KERNEL_FIXTURES: 'QuickAskOpenChat', KERNEL_HEADLESS: '1', KERNEL_FIXTURE_DATA: data, KERNEL_LOG_DIR: logs })
    app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env })
    const page = await app.firstWindow()
    await page.waitForSelector('html[data-fixture="ready"]', { state: 'attached', timeout: 15_000 })
    // Record dialogs and the clipboard instead of showing or touching the real ones.
    await app.evaluate(({ clipboard, dialog }) => {
      const g = globalThis as any
      g.dialogs = []
      g.copied = []
      dialog.showErrorBox = (title: string) => { g.dialogs.push(title) }
      clipboard.writeText = async (text: string) => { g.copied.push(text) }
    })
  }, 120_000)

  afterAll(async () => {
    await app?.close().catch(() => undefined)
    for (const d of [data, logs]) if (d) rmSync(d, { recursive: true, force: true })
  })

  const logText = () => (existsSync(join(logs, 'main.log')) ? readFileSync(join(logs, 'main.log'), 'utf8') : '')
  /** Runs a script in Kernel's window, the only one in a fixture run. */
  const inWindow = (js: string) => app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code), js)

  it('logs an error thrown in main and keeps running, with no dialog', async () => {
    await app.evaluate(() => {
      setTimeout(() => { throw new Error('thrown in main for the test') })
      void Promise.reject(new Error('rejected in main for the test'))
    })
    await expect.poll(logText, { timeout: 5000 }).toContain('[kernel] uncaught exception Error: thrown in main for the test')
    expect(logText()).toContain('[kernel] unhandled rejection Error: rejected in main for the test')
    expect(await app.evaluate(() => (globalThis as any).dialogs)).toEqual([])
    expect(await app.evaluate(({ app }) => app.isReady())).toBe(true)
  })

  it('reloads the window when its page crashes, logs it and says Kernel reloaded', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    await expect.poll(logText, { timeout: 5000 }).toMatch(/\[kernel\] the window's page is gone \((crashed|killed), exit code -?\d+\)/)
    await expect.poll(() => inWindow('document.documentElement.dataset.fixture').catch(() => null), { timeout: 15_000 }).toBe('ready')
    await expect.poll(() => inWindow('document.body.innerText').catch(() => ''), { timeout: 5000 }).toContain('Kernel reloaded')
  })

  it('copies diagnostics from Help with the log and no home path', async () => {
    await app.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu()!.items.find((i) => i.role === 'help')!
      help.submenu!.items.find((i) => i.label === 'Copy diagnostics')!.click()
    })
    await expect.poll(() => app.evaluate(() => (globalThis as any).copied.length), { timeout: 30_000 }).toBe(1)
    const text: string = await app.evaluate(() => (globalThis as any).copied[0])
    expect(text).toMatch(/^Kernel diagnostics\nKernel \S+\nmacOS \S+ \((arm64|x64)\)/)
    expect(text).toMatch(/Claude Code (v\S+|not found)\nGitHub CLI (v\S+|not found)\nHook port unknown/)
    expect(text).toContain('thrown in main for the test')
    expect(text).not.toContain(homedir())
    // The menu keeps the standard roles, so Cmd+C, Cmd+V and Cmd+Q still have their items.
    const roles: string[] = await app.evaluate(({ Menu }) => {
      const out: string[] = []
      const walk = (items: Electron.MenuItem[]) => { for (const i of items) { if (i.role) out.push(i.role); if (i.submenu) walk(i.submenu.items) } }
      walk(Menu.getApplicationMenu()!.items)
      return out
    })
    expect(roles).toEqual(expect.arrayContaining(['copy', 'paste', 'quit', 'undo', 'selectall']))
  })

  // Last, because it leaves the window without a page.
  it('stops reloading a page that keeps crashing', async () => {
    const stopped = 'the window crashed 4 times in a minute, so Kernel stopped reloading it'
    for (let i = 0; i < 4 && !logText().includes(stopped); i++) {
      await expect.poll(() => inWindow('document.documentElement.dataset.fixture').catch(() => null), { timeout: 15_000 }).toBe('ready')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
      await expect.poll(() => logText().split("the window's page is gone").length, { timeout: 5000 }).toBeGreaterThan(i + 2)
    }
    await expect.poll(logText, { timeout: 5000 }).toContain(stopped)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed())).toBe(true)
  })
})
