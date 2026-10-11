import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, powerMonitor, safeStorage, session, shell, type IpcMainInvokeEvent, type RenderProcessGoneDetails } from 'electron'
import { readFileSync, writeSync } from 'node:fs'
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
import { hookTokenFile } from './services/hookToken'
import { diagnostics, Log } from './services/log'
import { errorEvent } from './services/telemetrySend'
import { appMenu } from './menu'
import { BOOT_UPDATE_MS, Updater } from './updater'
import { dataDirs, moveToDev, openBy, type DataDirs } from './dataDir'
import { isInstalledCopy, loginItemSettings } from './loginItem'
import { lastFolder } from './picker'
import { QuitGuard } from './quit'
import { probeNetwork } from './services/health'
import { refreshPath } from './services/shellPath'
import { insideRoots, isAppUrl } from './windowGuard'
import { copiesIn, PreviewHost, previewFixture, registerPreviewScheme, type PreviewHandlers } from './previewHost'
import type { Channel, KernelApi } from '@shared/ipc'
import type { TelemetryEvent } from '@shared/telemetry'
import type { Room, Toast, Workspace } from '@shared/types'
import { isWebUrl } from '@shared/previewUrl'

const here = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null
/** Kernel's own window. Thumbnails draw in offscreen windows, so events, focus and dialogs go here, never to the first window. */
const mainWindow = () => (win && !win.isDestroyed() ? win : null)
let preview: PreviewHost | undefined
// Shared HTML loads from kernel-shared: in its own locked-down view (KERNEL-303). Schemes register before the app is ready.
registerPreviewScheme()

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

// The installed app keeps its data in Kernel and a dev run in Kernel Dev, so dev from main never writes data an older
// release can't read (KERNEL-408). Both share the hook entries in ~/.claude/settings.json, so only one runs at a time:
// each checks the other's lock before taking its own, and quits before it opens anything. Fixture runs and the smoke test
// keep their own folder.
const dirs = smokeTest || fixtureName ? undefined : dataDirs(app.getPath('appData'), app.isPackaged)
/** Said in a dialog once the app is ready, before Kernel quits without opening its data. */
let refusal: { message: string; detail?: string } | undefined
const otherOpen = (d: DataDirs) => ({ message: `${d.otherName} is open. Quit it, then open ${d.name} again.` })
if (dirs) {
  app.setPath('userData', dirs.own)
  if (openBy(dirs.other)) refusal = otherOpen(dirs)
}

// Two copies would share kernel.db, and the second one's start expires the first one's pending approvals. A second
// launch (open -n) hands over to the running copy and quits. Fixture runs have no database and a userData of their own,
// so they skip the lock.
const primary = !smokeTest && !refusal && (!!fixtureName || app.requestSingleInstanceLock())
if (!primary && !refusal) app.quit()
app.on('second-instance', () => focusWindow())

// A dev run's first launch moves the data over from Kernel, once it holds its own lock. The move checks Kernel's lock
// again first, so an installed app that opened in between stops it.
let moved: string | undefined
if (dirs && primary && !app.isPackaged) {
  try {
    const r = moveToDev({ from: dirs.other, to: dirs.own })
    if (r === 'moved') moved = `[kernel] moved the data from ${dirs.other} to ${dirs.own}`
    if (r === 'in-use') refusal = otherOpen(dirs)
  } catch (err) {
    console.error('[kernel] could not move the data', err)
    refusal = { message: `${dirs.name} could not move its data`, detail: `Your data is still in ${dirs.other}. ${err instanceof Error ? err.message : String(err)}` }
  }
}

// Kernel's log (KERNEL-288). Fixture runs leave it off, so screenshots and scripted runs never write to the real one. A dev
// run can point it at another folder, as test/crash.e2e.test.ts does.
const logDir = !app.isPackaged && process.env.KERNEL_LOG_DIR ? process.env.KERNEL_LOG_DIR : fixtureName ? undefined : join(app.getPath('home'), 'Library', 'Logs', 'Kernel')
/** The log and Copy diagnostics hide the home folder and the hook token, read from its file so nothing makes one early. */
const redaction = {
  home: app.getPath('home'),
  secrets: () => { try { return [readFileSync(hookTokenFile(app.getPath('userData')), 'utf8').trim()] } catch { return [] } }
}
// The smoke test and a second launch, which only hands over and quits, write nothing.
const log = logDir && primary ? new Log({ dir: logDir, ...redaction }) : undefined
log?.captureConsole()
log?.info(`[kernel] Kernel ${app.getVersion()} started on macOS ${process.getSystemVersion()}`)
if (moved) log?.info(moved)
// With no listener, Electron shows an error nothing caught in a raw dialog. Kernel logs it and keeps running: the database
// writes in transactions, and a stuck feature beats a window that quits under the user's agents.
process.on('uncaughtException', (err) => { console.error('[kernel] uncaught exception', err); bus.track(errorEvent('exception', err)) })
process.on('unhandledRejection', (reason) => { console.error('[kernel] unhandled rejection', reason); bus.track(errorEvent('rejection', reason)) })
app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') console.error(`[kernel] a ${d.type} process is gone (${d.reason}, exit code ${d.exitCode})`) })

/** Brings the window forward, or opens one if it was closed. A headless run stays hidden. */
function focusWindow() {
  const w = mainWindow()
  if (!w) { if (app.isReady()) createWindow(); return }
  if (headless) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

/** Shows a toast in the window, if there is one. */
const toast = (t: Omit<Toast, 'id'>) => bus.push({ type: 'toast', toast: t })
/** The hook port for Copy diagnostics. Unknown until the kernel exists, and in fixture runs. */
let hookPort: () => number | undefined = () => undefined
/** The latest usage events for Copy diagnostics (KERNEL-397). None until the kernel exists. */
let usageEvents: () => string[] | undefined = () => undefined

/** Help, Copy diagnostics: versions, the hook port and the end of the log, ready to paste into a bug report (KERNEL-288). */
async function copyDiagnostics() {
  const text = await diagnostics({ app: app.getVersion(), macos: process.getSystemVersion(), arch: process.arch, electron: process.versions.electron, hookPort: hookPort(), log, events: usageEvents(), ...redaction })
  await clipboard.writeText(text)
}

/** When the window's page last crashed, so a page that crashes as it loads isn't reloaded forever. */
let crashes: number[] = []

/** The window's page crashed or was killed. Reload it and say so, rather than leave a blank window (KERNEL-288). */
async function rendererGone(w: BrowserWindow, d: RenderProcessGoneDetails) {
  console.error(`[kernel] the window's page is gone (${d.reason}, exit code ${d.exitCode})`)
  if (d.reason !== 'clean-exit') bus.track({ name: 'app.renderer_gone', reason: d.reason as Extract<TelemetryEvent, { name: 'app.renderer_gone' }>['reason'] })
  if (d.reason === 'clean-exit' || w.isDestroyed()) return
  const now = Date.now()
  crashes = [...crashes.filter((t) => now - t < 60_000), now]
  if (crashes.length > 3) {
    console.error('[kernel] the window crashed 4 times in a minute, so Kernel stopped reloading it')
    if (headless) return
    const r = await dialog.showMessageBox(w, {
      type: 'warning', message: 'Kernel\'s window keeps crashing', detail: 'Kernel stopped reloading it. Help, Copy diagnostics copies what a bug report needs.',
      buttons: ['Reload', 'Quit'], defaultId: 0, cancelId: 0
    })
    if (r.response === 1) return app.quit()
    crashes = []
  }
  if (w.isDestroyed()) return
  w.webContents.once('did-finish-load', () => toast({ title: 'Kernel reloaded', sub: 'The window crashed. Help, Copy diagnostics has the details.' }))
  load(w)
}

const load = (w: BrowserWindow) => { if (rendererUrl) void w.loadURL(rendererUrl); else void w.loadFile(join(here, '../renderer/index.html')) }

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
  win.on('closed', () => { preview?.closeAll(); win = null })
  // The window only ever shows the app. A dropped HTML file, a link or a redirect would otherwise load in it, and
  // a foreign page in this window gets the bridge.
  const stay = (e: { url: string; preventDefault(): void }) => { if (!isAppUrl(e.url, appUrl)) e.preventDefault() }
  win.webContents.on('will-navigate', stay)
  win.webContents.on('will-redirect', stay)
  // A link with target="_blank" never opens a window. A web page goes to the browser, and anything else, like a file: link
  // in an agent's message, goes nowhere (KERNEL-246).
  win.webContents.setWindowOpenHandler(({ url }) => { if (isWebUrl(url)) void shell.openExternal(url); return { action: 'deny' } })
  const w = win
  w.webContents.on('render-process-gone', (_e, d) => void rendererGone(w, d))
  // The page's own errors go to the log too: a React error can blank the window with no crash.
  w.webContents.on('console-message', (e) => { if (e.level === 'error') log?.error('[renderer]', e.message, `(${e.sourceId}:${e.lineNumber})`) })
  load(w)
}

/** Every bridge call comes through here. Only the app's own page may call, never a page that got into the window. */
function handle(channel: string, fn: (e: IpcMainInvokeEvent, req: any) => Promise<unknown>) {
  ipcMain.handle(channel, (e, req) => {
    const from = e.senderFrame?.url
    if (!isAppUrl(from, appUrl)) throw new Error(`Kernel refused ${channel} from ${from || 'a closed page'}`)
    return fn(e, req)
  })
}

/**
 * A failed boot leaves nothing for IPC to talk to, so say why and quit instead of showing a broken window. A packaged
 * build checks for an update first and offers to install it, so a release that can't start can still get its fix (KERNEL-408).
 */
async function bootFailed(err: unknown, rescue?: { updater: Updater; quit: QuitGuard }) {
  console.error('[kernel] boot failed', err)
  const detail = err instanceof Error ? err.stack ?? err.message : String(err)
  try {
    const version = rescue && (await rescue.updater.readyWithin(BOOT_UPDATE_MS))
    if (rescue && version) {
      const r = await dialog.showMessageBox({
        type: 'error', message: 'Kernel could not start', detail: `Kernel ${version} is ready to install.\n\n${detail}`,
        buttons: ['Install and restart', 'Quit'], defaultId: 0, cancelId: 1
      })
      // Electron closes the windows before before-quit on this path, so the guard settles first, as Restart to update does.
      if (r.response === 0 && (await rescue.quit.confirmUpdate())) return rescue.updater.install()
    } else dialog.showErrorBox('Kernel could not start', detail)
  } catch (e) {
    console.error('[kernel] could not offer an update after a failed boot', e)
  }
  app.quit()
}

app.whenReady().then(async () => {
  if (refusal) {
    console.error(`[kernel] ${refusal.message}`)
    if (!headless) await dialog.showMessageBox({ type: 'info', message: refusal.message, detail: refusal.detail, buttons: ['OK'] })
    return app.quit()
  }
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
  if (fixture) {
    handlers = fixtureHandlers(fixture) as typeof handlers
    // A fixture run has no live previews, except in test/preview.e2e.test.ts: a dev build there serves copies from the
    // fixture's data folder, and the test reaches the host for thumbnails.
    if (!app.isPackaged && process.env.KERNEL_E2E_PREVIEWS === '1') {
      preview = new PreviewHost({ window: mainWindow, file: copiesIn(app.getPath('userData')), push: (e) => bus.push(e), dev: true })
      ;(globalThis as { kernelPreview?: PreviewHost }).kernelPreview = preview
    }
  } else {
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
    // Every quit goes through here: it asks while agents work and waits for the stop (KERNEL-214).
    const quit: QuitGuard = new QuitGuard({
      working: (): number => kernel.workingAgents(),
      ask: async (d) => {
        // A closed window gets no dialog parent, and the dialog shows on its own. focusWindow would open a new one.
        const w = mainWindow()
        if (!w) return (await dialog.showMessageBox(d)).response === 0
        focusWindow()
        return (await dialog.showMessageBox(w, d)).response === 0
      },
      stop: async () => { updater?.stop(); await kernel.stop() },
      quit: () => app.quit(),
      quiet: headless
    })
    // Draws shared HTML in locked-down views and thumbnails shared files for their cards (KERNEL-303).
    preview = new PreviewHost({ window: mainWindow, file: (id, n) => kernel.sharedFile(id, n), push: (e) => bus.push(e), dev: !app.isPackaged })
    const installed = isInstalledCopy({ packaged: app.isPackaged, inApplicationsFolder: app.isPackaged && app.isInApplicationsFolder(), exePath: app.getPath('exe'), home: app.getPath('home') })
    // Usage data goes out only from a packaged release built with a key, after the user says yes, and never from a smoke
    // test, a fixture or headless run, or when DO_NOT_TRACK=1 or KERNEL_TELEMETRY=0 is set (KERNEL-397).
    const sends = app.isPackaged && !smokeTest && !fixtureName && !headless && !!__KERNEL_TELEMETRY__.key && process.env.DO_NOT_TRACK !== '1' && process.env.KERNEL_TELEMETRY !== '0'
    const kernel = new Kernel({
      dataDir: app.getPath('userData'),
      telemetry: sends ? { ...__KERNEL_TELEMETRY__, os: process.getSystemVersion(), arch: process.arch } : undefined,
      starterDir: join(app.getAppPath(), 'docs', 'starter-agents'),
      inBackground: () => !mainWindow()?.isFocused(),
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
        // macOS shows notifications only from a signed app (Electron 42), so an unsigned build says why here instead.
        banner.on('failed', (_e, error) => console.error(`[kernel] could not show a notification: ${error}`))
        banner.show()
      },
      confirmQuit: () => quit.confirmUpdate(),
      capture: preview,
      reveal: (path) => shell.showItemInFolder(path),
      openFile: async (path) => { const err = await shell.openPath(path); if (err) throw new Error(err) }
    })
    app.on('before-quit', (e) => quit.beforeQuit(e))
    powerMonitor.on('shutdown', () => quit.shutdown())
    // The window opens while the kernel boots. Calls made before start() finishes wait for it.
    // PATH comes first so sessions and git calls made during start() find Homebrew and npm tools.
    started = refreshPath().then(() => kernel.start())
    started.catch((err: unknown) => { quit.bootFailed(); void bootFailed(err, updater && { updater, quit }) })
    void started.then(() => updater?.start(), () => undefined)
    // Timers run late by however long the Mac slept, so a usage limit that reset meanwhile is checked on wake, and the PRs
    // are read again, as when the window comes back from another app (KERNEL-388).
    powerMonitor.on('resume', () => void started.then(() => { kernel.prs.pollSoon(); return kernel.checkLimits() }, () => undefined))
    app.on('browser-window-focus', (_e, w) => { if (w === mainWindow()) void started.then(() => kernel.prs.pollSoon(), () => undefined) })
    handlers = kernel.handlers() as typeof handlers
    hookPort = () => kernel.settings?.hookPort
    usageEvents = () => kernel.telemetry.lines()
  }
  // The page asks for nothing: clipboard writes back the copy buttons, and every other request is refused.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) => done(permission === 'clipboard-sanitized-write' && isAppUrl(details.requestingUrl, appUrl)))
  for (const [channel, fn] of Object.entries(handlers)) handle(channel, async (_e, req) => { await started; return fn(req) })
  const folders = lastFolder()
  const images = lastFolder()
  handle('system.pickFolder' satisfies Channel, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: folders.defaultPath })
    folders.picked(r.filePaths)
    return r.canceled ? null : r.filePaths[0]
  })
  handle('system.pickImage' satisfies Channel, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }], defaultPath: images.defaultPath })
    images.picked(r.filePaths)
    return r.canceled ? null : r.filePaths[0]
  })
  // Only web pages: a URL a run script printed or a room's settings name must not open a file or another app (KERNEL-246).
  handle('system.openExternal' satisfies Channel, async (_e, { url }: KernelApi['system.openExternal']['req']) => {
    if (typeof url !== 'string' || !isWebUrl(url)) throw new Error('Kernel only opens http and https links')
    await shell.openExternal(url)
    return { ok: true }
  })
  const previews: PreviewHandlers = preview?.handlers() ?? previewFixture(fixture!)
  for (const [channel, fn] of Object.entries(previews) as [string, (req: unknown) => Promise<unknown>][]) handle(channel, async (_e, req) => { await started; return fn(req) })
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
  bus.on('push', (event) => mainWindow()?.webContents.send('kernel:event', event))
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu({ copyDiagnostics: () => void copyDiagnostics().catch((err: unknown) => console.error('[kernel] could not copy diagnostics', err)) })))
  createWindow()
  app.on('activate', () => { if (!mainWindow()) createWindow() })
}).catch((err: unknown) => void bootFailed(err))

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
