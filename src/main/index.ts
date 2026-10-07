import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bus } from './bus'
import { Kernel } from './kernel'
import { fixtureHandlers } from './fixtures'
import { exec } from './services/exec'
import type { Channel } from '@shared/ipc'

const here = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null

// Fixture mode serves one screen's data with no kernel (D-021). Its own userData keeps Electron's
// cache and storage out of the real profile, so a fixture run can't collide with a running Kernel.
const fixtureName = process.env.KERNEL_FIXTURES
if (fixtureName) {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-fixture-'))
  app.setPath('userData', dir)
  app.on('quit', () => rmSync(dir, { recursive: true, force: true }))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#08090a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 13, y: 15 },
    show: false,
    webPreferences: { preload: join(here, '../preload/index.mjs'), sandbox: false, contextIsolation: true }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(here, '../renderer/index.html'))
}

/** A failed boot leaves nothing for IPC to talk to, so say why and quit instead of showing a broken window. */
function bootFailed(err: unknown) {
  console.error('[kernel] boot failed', err)
  dialog.showErrorBox('Kernel could not start', err instanceof Error ? err.stack ?? err.message : String(err))
  app.quit()
}

app.whenReady().then(async () => {
  const known = fixtureName ? (await import('../../fixtures')).fixtures : {}
  const fixture = fixtureName ? known[fixtureName] : undefined
  if (fixtureName && !fixture) {
    console.error(`[kernel] no fixture named ${fixtureName}. Known: ${Object.keys(known).join(', ')}`)
    return app.exit(1)
  }
  let handlers: Record<string, (req: unknown) => Promise<unknown>>
  let started: Promise<void> = Promise.resolve()
  if (fixture) handlers = fixtureHandlers(fixture) as typeof handlers
  else {
    const kernel = new Kernel({ dataDir: app.getPath('userData') })
    app.on('before-quit', () => { void kernel.stop() })
    // The window opens while the kernel boots. Calls made before start() finishes wait for it.
    started = kernel.start()
    started.catch(bootFailed)
    handlers = kernel.handlers() as typeof handlers
  }
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.handle(channel, async (_e, req) => { await started; return fn(req) })
  ipcMain.handle('system.pickFolder' satisfies Channel, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('system.openExternal' satisfies Channel, async (_e, { url }) => { await shell.openExternal(url); return { ok: true } })
  ipcMain.handle('system.fixture' satisfies Channel, async () => (fixture ? { ui: fixture.ui, push: fixture.push } : null))
  ipcMain.handle('system.openInEditor' satisfies Channel, async (_e, { path }) => { const r = await exec('code', [path]); if (r.code !== 0) await shell.openPath(path); return { ok: true } })
  bus.on('push', (event) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('kernel:event', event) })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(bootFailed)

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
