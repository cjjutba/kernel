import { app, BrowserWindow, dialog, ipcMain, Notification, powerMonitor, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron'
import { writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import * as pty from 'node-pty'
import electronUpdater from 'electron-updater'
import { bus } from './bus'
import { Kernel } from './kernel'
import { fixtureHandlers, fixturePush } from './fixtures'
import { exec } from './services/exec'
import { Updater } from './updater'
import { isInstalledCopy, loginItemSettings } from './loginItem'
import { probeNetwork } from './services/health'
import { refreshPath } from './services/shellPath'
import { insideRoots, isAppUrl } from './windowGuard'
import type { Channel, KernelApi } from '@shared/ipc'
import type { Room, Workspace } from '@shared/types'
import { isWebUrl } from '@shared/previewUrl'

const here = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null

// The fuses turn ELECTRON_RUN_AS_NODE off in the packaged app, so scripts/release.sh checks the native modules through
// this argument instead: load both the way the app does, print ok and quit, before any window, lock or database.
// node-pty loads its addon with the imports above, so a broken one fails before this runs; better-sqlite3 loads its
// addon on the first Database.
const smokeTest = process.argv.includes('--kernel-smoke-test')
if (smokeTest) {
  try {
    new Database(':memory:').close()
    if (typeof pty.spawn !== 'function') throw new Error('node-pty has no spawn')
    // Synchronous, so the line is out before app.exit ends the process.
    writeSync(1, 'ok\n')
    app.exit(0)
  } catch (err) {
    console.error('[kernel] smoke test failed', err)
    app.exit(1)
  }
}

// Only the dev server sets ELECTRON_RENDERER_URL. A packaged app ignores it, so nothing in the environment can point
// the window, and the bridge, at another page (KERNEL-208).
const rendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
const appUrl = rendererUrl ?? pathToFileURL(join(here, '../renderer/index.html')).href

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

// Two copies would share kernel.db, and the second one's start expires the first one's pending approvals. A second
// launch (open -n, or a dev build next to the installed app) hands over to the running copy and quits. Fixture runs
// have no database and a userData of their own, so they skip the lock.
const primary = !smokeTest && (!!fixtureName || app.requestSingleInstanceLock())
if (!primary) app.quit()
app.on('second-instance', () => focusWindow())

/** Brings the window forward, or opens one if it was closed. A headless run stays hidden. */
function focusWindow() {
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) { if (app.isReady()) createWindow(); return }
  if (headless) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

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
  // The window only ever shows the app. A dropped HTML file, a link or a redirect would otherwise load in it, and
  // a foreign page in this window gets the bridge.
  const stay = (e: { url: string; preventDefault(): void }) => { if (!isAppUrl(e.url, appUrl)) e.preventDefault() }
  win.webContents.on('will-navigate', stay)
  win.webContents.on('will-redirect', stay)
  // A link with target="_blank" never opens a window. A web page goes to the browser, and anything else, like a file: link
  // in an agent's message, goes nowhere (KERNEL-246).
  win.webContents.setWindowOpenHandler(({ url }) => { if (isWebUrl(url)) void shell.openExternal(url); return { action: 'deny' } })
  if (rendererUrl) void win.loadURL(rendererUrl)
  else void win.loadFile(join(here, '../renderer/index.html'))
}

/** Every bridge call comes through here. Only the app's own page may call, never a page that got into the window. */
function handle(channel: string, fn: (e: IpcMainInvokeEvent, req: any) => Promise<unknown>) {
  ipcMain.handle(channel, (e, req) => {
    const from = e.senderFrame?.url
    if (!isAppUrl(from, appUrl)) throw new Error(`Kernel refused ${channel} from ${from || 'a closed page'}`)
    return fn(e, req)
  })
}

/** A failed boot leaves nothing for IPC to talk to, so say why and quit instead of showing a broken window. */
function bootFailed(err: unknown) {
  console.error('[kernel] boot failed', err)
  dialog.showErrorBox('Kernel could not start', err instanceof Error ? err.stack ?? err.message : String(err))
  app.quit()
}

app.whenReady().then(async () => {
  if (!primary) return
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
      // Variables are kept with the Keychain. Where it can't be used, Kernel saves none rather than plain text (KERNEL-247).
      cipher: safeStorage.isEncryptionAvailable()
        ? { encrypt: (text) => safeStorage.encryptString(text).toString('base64'), decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')) }
        : undefined,
      version: app.getVersion(),
      updater,
      // Only the installed copy touches the login item, so a dev run or a dist/ build never registers or removes it.
      onSettings: (s) => { const login = loginItemSettings(installed, s); if (login) app.setLoginItemSettings(login) },
      showNotification: (n, { silent }) => {
        if (!Notification.isSupported()) return
        const banner = new Notification({ title: n.heading ?? n.title, body: n.sub, silent })
        banner.on('click', () => focusWindow())
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
  // The page asks for nothing: clipboard writes back the copy buttons, and every other request is refused.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) => done(permission === 'clipboard-sanitized-write' && isAppUrl(details.requestingUrl, appUrl)))
  for (const [channel, fn] of Object.entries(handlers)) handle(channel, async (_e, req) => { await started; return fn(req) })
  handle('system.pickFolder' satisfies Channel, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('system.pickImage' satisfies Channel, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] })
    return r.canceled ? null : r.filePaths[0]
  })
  // Only web pages: a URL a run script printed or a room's settings name must not open a file or another app (KERNEL-246).
  handle('system.openExternal' satisfies Channel, async (_e, { url }: KernelApi['system.openExternal']['req']) => {
    if (typeof url !== 'string' || !isWebUrl(url)) throw new Error('Kernel only opens http and https links')
    await shell.openExternal(url)
    return { ok: true }
  })
  handle('system.fixture' satisfies Channel, async () => (fixture ? { ui: { ...fixture.ui, ...fixtureTheme() }, push: fixturePush(fixture) } : null))
  handle('system.trafficLights' satisfies Channel, async (e, { at }: KernelApi['system.trafficLights']['req']) => { BrowserWindow.fromWebContents(e.sender)?.setWindowButtonPosition(LIGHTS[at]); return { ok: true } })
  // Never shell.openPath: on a tracked run.command or .terminal file it runs the file, and checkouts carry no quarantine
  // flag. Without the code command the file is shown in Finder instead.
  handle('system.openInEditor' satisfies Channel, async (_e, { path }: KernelApi['system.openInEditor']['req']) => {
    await started
    const rooms = (await handlers['rooms.list'](undefined)) as Room[]
    const workspaces = (await handlers['workspaces.list']({})) as Workspace[]
    if (!insideRoots(path, [...rooms, ...workspaces].map((x) => x.path))) throw new Error('Kernel only opens files inside a room or workspace.')
    const r = await exec('code', [path])
    if (r.code !== 0) shell.showItemInFolder(path)
    return { ok: true }
  })
  bus.on('push', (event) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('kernel:event', event) })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(bootFailed)

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
