import { app, BrowserWindow, dialog, ipcMain, Notification, powerMonitor, shell } from 'electron'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronUpdater from 'electron-updater'
import { bus } from './bus'
import { Kernel } from './kernel'
import { fixtureHandlers, fixturePush } from './fixtures'
import { exec } from './services/exec'
import { Updater } from './updater'
import { isInstalledCopy, loginItemSettings } from './loginItem'
import { probeNetwork } from './services/health'
import { refreshPath } from './services/shellPath'
import type { Channel, KernelApi } from '@shared/ipc'
import { isWebUrl } from '@shared/previewUrl'

const here = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null

// Fixture mode serves one screen's data with no kernel (D-021). Its own userData keeps Electron's
// cache and storage out of the real profile, so a fixture run can't collide with a running Kernel.
// The shots harness passes a folder per launch and deletes it; manual runs reuse one temp folder.
const fixtureName = process.env.KERNEL_FIXTURES
/** `pnpm shots --theme light` forces a theme on any fixture. */
const fixtureTheme = () => (process.env.KERNEL_FIXTURE_THEME === 'light' || process.env.KERNEL_FIXTURE_THEME === 'dark' ? { theme: process.env.KERNEL_FIXTURE_THEME } : {})
if (fixtureName) app.setPath('userData', process.env.KERNEL_FIXTURE_DATA ?? join(tmpdir(), 'kernel-fixtures'))
// Scripted runs (the shots harness, Playwright drives) set KERNEL_HEADLESS=1. The window still renders but never
// shows, and the app gets no Dock icon and never takes focus, so it can run while someone types in another app.
const headless = process.env.KERNEL_HEADLESS === '1'
if (headless) app.setActivationPolicy('accessory')

/** Traffic lights over the sidebar's 42px top strip, or centered in the screen header row (y 9 to 53) while the sidebar is hidden. */
const LIGHTS = { sidebar: { x: 13, y: 15 }, header: { x: 20, y: 25 } }

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    // Small enough to tile half of a laptop screen. Below 1024 and 900 the right panel and sidebar fold (D-080).
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#08090a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: LIGHTS.sidebar,
    show: false,
    // A hidden page counts as in the background, and Chromium would slow its timers and frames.
    webPreferences: { preload: join(here, '../preload/index.mjs'), sandbox: false, contextIsolation: true, backgroundThrottling: !headless }
  })
  // The default menu would close the window on Cmd+W. Kernel closes the open tab instead, so the page hears about it.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.meta && !input.shift && !input.alt && !input.control && input.key.toLowerCase() === 'w') {
      e.preventDefault()
      void win?.webContents.executeJavaScript("window.dispatchEvent(new Event('kernel:close-tab'))")
    }
  })
  if (!headless) win.once('ready-to-show', () => win?.show())
  // A link with target="_blank" never opens a window. A web page goes to the browser, and anything else, like a file: link
  // in an agent's message, goes nowhere (KERNEL-246).
  win.webContents.setWindowOpenHandler(({ url }) => { if (isWebUrl(url)) void shell.openExternal(url); return { action: 'deny' } })
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
  // A packaged app takes its icon from build/icon.icns. Dev runs would show Electron's, so set the same mark here.
  if (!app.isPackaged && !headless) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'))
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
    // Only a packaged, signed app can update itself. Dev runs report no update. scripts/release.sh writes the version's
    // notes into the build for What's new (KERNEL-154).
    const updater = app.isPackaged
      ? new Updater({
          current: app.getVersion(),
          dataDir: app.getPath('userData'),
          engine: electronUpdater.autoUpdater,
          notesFile: join(app.getAppPath(), 'out', 'release-notes', `${app.getVersion()}.md`)
        })
      : undefined
    const installed = isInstalledCopy({ packaged: app.isPackaged, inApplicationsFolder: app.isPackaged && app.isInApplicationsFolder(), exePath: app.getPath('exe'), home: app.getPath('home') })
    const kernel = new Kernel({
      dataDir: app.getPath('userData'),
      starterDir: join(app.getAppPath(), 'docs', 'starter-agents'),
      inBackground: () => !BrowserWindow.getAllWindows().some((w) => w.isFocused()),
      probeNetwork: () => probeNetwork(),
      refreshPath,
      version: app.getVersion(),
      updater,
      // Only the installed copy touches the login item, so a dev run or a dist/ build never registers or removes it.
      onSettings: (s) => { const login = loginItemSettings(installed, s); if (login) app.setLoginItemSettings(login) },
      showNotification: (n, { silent }) => {
        if (!Notification.isSupported()) return
        const banner = new Notification({ title: n.heading ?? n.title, body: n.sub, silent })
        banner.on('click', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus() } })
        banner.show()
      }
    })
    app.on('before-quit', () => { updater?.stop(); void kernel.stop() })
    // The window opens while the kernel boots. Calls made before start() finishes wait for it.
    // PATH comes first so sessions and git calls made during start() find Homebrew and npm tools.
    started = refreshPath().then(() => kernel.start())
    started.catch(bootFailed)
    void started.then(() => updater?.start(), () => undefined)
    // Timers run late by however long the Mac slept, so a usage limit that reset meanwhile is checked on wake.
    powerMonitor.on('resume', () => void started.then(() => kernel.checkLimits(), () => undefined))
    handlers = kernel.handlers() as typeof handlers
  }
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.handle(channel, async (_e, req) => { await started; return fn(req) })
  ipcMain.handle('system.pickFolder' satisfies Channel, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('system.pickImage' satisfies Channel, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] })
    return r.canceled ? null : r.filePaths[0]
  })
  // Only web pages: a URL a run script printed or a room's settings name must not open a file or another app (KERNEL-246).
  ipcMain.handle('system.openExternal' satisfies Channel, async (_e, { url }) => {
    if (typeof url !== 'string' || !isWebUrl(url)) throw new Error('Kernel only opens http and https links')
    await shell.openExternal(url)
    return { ok: true }
  })
  ipcMain.handle('system.fixture' satisfies Channel, async () => (fixture ? { ui: { ...fixture.ui, ...fixtureTheme() }, push: fixturePush(fixture) } : null))
  ipcMain.handle('system.trafficLights' satisfies Channel, async (e, { at }: KernelApi['system.trafficLights']['req']) => { BrowserWindow.fromWebContents(e.sender)?.setWindowButtonPosition(LIGHTS[at]); return { ok: true } })
  ipcMain.handle('system.openInEditor' satisfies Channel, async (_e, { path }) => { const r = await exec('code', [path]); if (r.code !== 0) await shell.openPath(path); return { ok: true } })
  bus.on('push', (event) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('kernel:event', event) })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(bootFailed)

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
