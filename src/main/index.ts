import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bus } from './bus'
import { Kernel } from './kernel'
import { fixtureHandlers } from './fixtures'
import { exec } from './services/exec'
import { probeNetwork } from './services/health'
import type { Channel } from '@shared/ipc'

const here = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null

// Fixture mode serves one screen's data with no kernel (D-021). Its own userData keeps Electron's
// cache and storage out of the real profile, so a fixture run can't collide with a running Kernel.
// The shots harness passes a folder per launch and deletes it; manual runs reuse one temp folder.
const fixtureName = process.env.KERNEL_FIXTURES
if (fixtureName) app.setPath('userData', process.env.KERNEL_FIXTURE_DATA ?? join(tmpdir(), 'kernel-fixtures'))

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
  // The default menu would close the window on Cmd+W. Kernel closes the open tab instead, so the page hears about it.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.meta && !input.shift && !input.alt && !input.control && input.key.toLowerCase() === 'w') {
      e.preventDefault()
      void win?.webContents.executeJavaScript("window.dispatchEvent(new Event('kernel:close-tab'))")
    }
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
    const kernel = new Kernel({
      dataDir: app.getPath('userData'),
      starterDir: join(app.getAppPath(), 'docs', 'starter-agents'),
      inBackground: () => !BrowserWindow.getAllWindows().some((w) => w.isFocused()),
      probeNetwork: () => probeNetwork(),
      showNotification: (n, { silent }) => {
        if (!Notification.isSupported()) return
        const banner = new Notification({ title: n.heading ?? n.title, body: n.sub, silent })
        banner.on('click', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus() } })
        banner.show()
      }
    })
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
