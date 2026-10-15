import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, session, shell, type IpcMainInvokeEvent, type RenderProcessGoneDetails } from 'electron'
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
import { hookTokenFile } from './services/hookToken'
import { diagnostics, Log } from './services/log'
import { errorEvent } from './services/telemetrySend'
import { appMenu } from './menu'
import { BOOT_UPDATE_MS, readNotes, runUpdateTest, Updater, updateTestArgs } from './updater'
import { dataDirs, moveToDev, removeJiraAccount, unshareHookToken } from './dataDir'
import { isInstalledCopy, loginItemSettings, offerMove, replaceBox, runsFrom, type CopyInfo } from './loginItem'
import { lastFolder } from './picker'
import { QuitGuard } from './quit'
import { probeNetwork } from './services/health'
import { refreshPath } from './services/shellPath'
import { muteShadowedWarning } from './services/providers/claude'
import { macKeychain } from './services/providers/claudeHome'
import { claudeAgents } from './services/pluginAgents'
import { isAppUrl } from './windowGuard'
import { appearanceOf, readAppearance, WindowAppearance } from './features/appearance'
import { handZoom, zoomStepOf } from './windowZoom'
import { attachImageMenu } from './imageMenu'
import { copiesIn, PreviewHost, previewFixture, registerPreviewScheme, type PreviewHandlers } from './previewHost'
import type { Channel, KernelApi, PushEvent } from '@shared/ipc'
import type { TelemetryEvent } from '@shared/telemetry'
import type { Toast } from '@shared/types'
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

// The end-to-end update test (KERNEL-713) runs a packaged Kernel against a local feed. It keeps everything in <dir>: no
// database, no Kernel, no hooks in Claude Code's user settings, no single-instance lock, no window and no Dock icon. With
// no feed it prints the version, so the test can tell which build is installed.
const updateTest = updateTestArgs(process.argv)
if (updateTest) {
  app.setActivationPolicy('accessory')
  if (!updateTest.feed) {
    writeSync(1, `version ${app.getVersion()}\n`)
    app.exit(0)
  } else if (!updateTest.dir) {
    console.error('[kernel] usage: --kernel-update-test <feed-url> <dir>')
    app.exit(1)
  } else app.setPath('userData', updateTest.dir)
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
// release can't read (KERNEL-408). Each has its own hook token, port and entries in ~/.claude/settings.json, so both run
// at once (KERNEL-675). Fixture runs and the smoke test keep their own folder. A dev run started inside a Kernel workspace
// gets a folder of its own, so it holds its own lock and opens next to the Kernel that started it (KERNEL-679).
const dirs = smokeTest || updateTest || fixtureName ? undefined : dataDirs(app.getPath('appData'), app.isPackaged, process.env.KERNEL_WORKSPACE_ID)
/** Said in a dialog once the app is ready, before Kernel quits without opening its data. */
let refusal: { message: string; detail?: string } | undefined
if (dirs) app.setPath('userData', dirs.own)

// Two copies would share kernel.db, and the second one's start expires the first one's pending approvals. A second
// launch (open -n) hands over to the running copy and quits. Fixture runs have no database and a userData of their own,
// so they skip the lock.
const primary = !smokeTest && !updateTest && (!!fixtureName || app.requestSingleInstanceLock())
if (!primary && !updateTest) app.quit()
app.on('second-instance', () => focusWindow())

// A dev run's first launch moves the data over from Kernel, once it holds its own lock. The move never copies a database
// the installed app has open, so a first launch while Kernel runs waits for it to quit. A workspace run moves nothing and
// starts empty.
let moved: string | undefined
/** The installed app's hook entries were Kernel Dev's too until this launch: it just moved, or it had Kernel's token (KERNEL-675). */
let hooksWereShared = false
if (dirs && primary && !app.isPackaged && !dirs.run) {
  try {
    const r = moveToDev({ from: dirs.other, to: dirs.own })
    if (r === 'moved') moved = `[kernel] moved the data from ${dirs.other} to ${dirs.own}`
    if (r === 'in-use') refusal = { message: `${dirs.otherName} is open. Quit it, then open ${dirs.name} again.`, detail: `${dirs.name} moves your data from ${dirs.otherName} on its first launch, and can't while ${dirs.otherName} has it open.` }
    // A refused launch keeps the token as it is, so the launch that opens is the one that adds Kernel Dev's hooks.
    else hooksWereShared = r === 'moved' || unshareHookToken(dirs)
  } catch (err) {
    console.error('[kernel] could not move the data', err)
    refusal = { message: `${dirs.name} could not move its data`, detail: `Your data is still in ${dirs.other}. ${err instanceof Error ? err.message : String(err)}` }
  }
}
// No saved Jira token outlives Jira (remove-jira).
if (dirs && primary && !refusal) removeJiraAccount(dirs.own)

// Kernel's log (KERNEL-288). Fixture runs leave it off, so screenshots and scripted runs never write to the real one. A dev
// run can point it at another folder, as test/crash.e2e.test.ts does.
const logDir = !app.isPackaged && process.env.KERNEL_LOG_DIR ? process.env.KERNEL_LOG_DIR : fixtureName ? undefined : join(app.getPath('home'), 'Library', 'Logs', dirs?.name ?? 'Kernel')
/** The log and Copy diagnostics hide the home folder and the hook token, read from its file so nothing makes one early. */
const redaction = {
  home: app.getPath('home'),
  secrets: () => { try { return [readFileSync(hookTokenFile(app.getPath('userData')), 'utf8').trim()] } catch { return [] } }
}
// The smoke test, the update test and a second launch, which only hands over and quits, write nothing.
const log = logDir && primary ? new Log({ dir: logDir, ...redaction }) : undefined
log?.captureConsole()
log?.info(`[kernel] Kernel ${app.getVersion()} started on macOS ${process.getSystemVersion()}`)
if (moved) log?.info(moved)
// With no listener, Electron shows an error nothing caught in a raw dialog. Kernel logs it and keeps running: the database
// writes in transactions, and a stuck feature beats a window that quits under the user's agents.
process.on('uncaughtException', (err) => { console.error('[kernel] uncaught exception', err); bus.track(errorEvent('exception', err)) })
process.on('unhandledRejection', (reason) => { console.error('[kernel] unhandled rejection', reason); bus.track(errorEvent('rejection', reason)) })
// Every session in Bypass permissions would print the SDK's warning that canUseTool doesn't see every call (KERNEL-447).
muteShadowedWarning()
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

/** Traffic lights centered on the screen header row (y 9 to 53), in the same place whether the sidebar is open or hidden (KERNEL-431). */
const LIGHTS = { x: 20, y: 25 }

/** Settings, Appearance for the window and native UI, made once the app is ready (KERNEL-708). */
let appearance: WindowAppearance | undefined

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    // Small enough to tile half of a laptop screen. Below 1024 and 900 the right panel and sidebar fold (D-080).
    minWidth: 720,
    minHeight: 520,
    backgroundColor: appearance?.backgroundColor,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: LIGHTS,
    show: false,
    // A hidden page counts as in the background, and Chromium would slow its timers and frames.
    webPreferences: { preload: join(here, '../preload/index.mjs'), sandbox: false, contextIsolation: true, backgroundThrottling: !headless, additionalArguments: appearance ? [appearance.arg] : [] }
  })
  // The default menu would close the window on Cmd+W and reload it on Cmd+R. Kernel closes the open tab and runs the dev
  // script instead, so the page hears about them (KERNEL-539). View, Reload stays in the menu. The menu also zooms the window on
  // Cmd+Plus, Minus and 0: the page gets those first, for a shared image's tab, and the window zooms when the page leaves them (KERNEL-598).
  win.webContents.on('before-input-event', (e, input) => {
    const zoom = zoomStepOf(input)
    if (zoom && win) { e.preventDefault(); void handZoom(win.webContents, zoom); return }
    // Cmd+Shift+/ is also macOS's own key for searching the Help menu, which the app menu has, so the menu takes it and the page never hears it.
    // The page is handed the key here instead, from the focused element so an open picker sees it too.
    if (input.type === 'keyDown' && input.meta && input.shift && !input.alt && !input.control && (input.code === 'Slash' || input.key === '/' || input.key === '?')) {
      e.preventDefault()
      void win?.webContents.executeJavaScript(`(document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', { key: '?', code: 'Slash', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))`)
      return
    }
    if (input.type !== 'keyDown' || !input.meta || input.shift || input.alt || input.control) return
    const event = { w: 'kernel:close-tab', r: 'kernel:run-script' }[input.key.toLowerCase()]
    if (!event) return
    e.preventDefault()
    void win?.webContents.executeJavaScript(`window.dispatchEvent(new Event('${event}'))`)
  })
  attachImageMenu(win.webContents)
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
  if (updateTest?.feed && updateTest.dir) {
    return runUpdateTest({
      feed: updateTest.feed,
      dir: updateTest.dir,
      current: app.getVersion(),
      engine: electronUpdater.autoUpdater,
      print: (line) => writeSync(1, `${line}\n`),
      exit: (code) => app.exit(code)
    })
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
  // `pnpm shots --motion` asks the app for what the fixture declares, since the script can't import the fixtures (KERNEL-831).
  ;(globalThis as { kernelFixtureMotion?: unknown }).kernelFixtureMotion = fixture?.motion
  ;(globalThis as { kernelFixturePush?: unknown }).kernelFixturePush = (events: PushEvent[]) => events.forEach((e) => bus.push(e))
  // A fixture's theme wins, as `pnpm shots --theme light` asks. A real run opens on what settings.json says.
  const fixtureLook = fixture && appearanceOf({ theme: fixtureTheme().theme ?? fixture.ui.theme })
  appearance = new WindowAppearance({ nativeTheme, window: mainWindow, initial: fixtureLook || readAppearance(join(app.getPath('userData'), 'settings.json')) })
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
    const copy: CopyInfo = { packaged: app.isPackaged, inApplicationsFolder: app.isPackaged && app.isInApplicationsFolder(), exePath: app.getPath('exe'), home: app.getPath('home') }
    // A copy outside Applications can't update itself, so it offers once to move there before anything opens. Electron
    // relaunches the moved copy, and this one stops here (KERNEL-443).
    const offer = await offerMove({
      copy,
      headless,
      dataDir: app.getPath('userData'),
      show: async (box) => (await dialog.showMessageBox(box)).response,
      move: () => app.moveToApplicationsFolder({ conflictHandler: (c) => c === 'existsAndRunning' || dialog.showMessageBoxSync(replaceBox) === 0 })
    })
    if (offer === 'moved') return app.quit()
    // Only a packaged, signed app can update itself. Dev runs report no update. scripts/release.sh writes the version's
    // notes into the build for What's new (KERNEL-154).
    const updater = app.isPackaged
      ? new Updater({
          current: app.getVersion(),
          dataDir: app.getPath('userData'),
          engine: electronUpdater.autoUpdater,
          notesFile: join(app.getAppPath(), 'out', 'release-notes', `${app.getVersion()}.md`),
          outside: runsFrom(copy)
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
    const installed = isInstalledCopy(copy)
    // Usage data goes out only from a packaged release built with a key, after the user says yes, and never from a smoke
    // test, a fixture or headless run, or when DO_NOT_TRACK=1 or KERNEL_TELEMETRY=0 is set (KERNEL-397).
    const sends = app.isPackaged && !smokeTest && !fixtureName && !headless && !!__KERNEL_TELEMETRY__.key && process.env.DO_NOT_TRACK !== '1' && process.env.KERNEL_TELEMETRY !== '0'
    /** Each app's icon for the Open in menu, drawn once per app path (KERNEL-427). */
    const appIcons = new Map<string, Promise<string | undefined>>()
    const kernel = new Kernel({
      dataDir: app.getPath('userData'),
      build: app.isPackaged ? 'app' : dirs?.run ? 'run' : 'dev',
      hooksWereShared,
      telemetry: sends ? { ...__KERNEL_TELEMETRY__, os: process.getSystemVersion(), arch: process.arch } : undefined,
      starterDir: join(app.getAppPath(), 'docs', 'starter-agents'),
      inBackground: () => !mainWindow()?.isFocused(),
      probeNetwork: () => probeNetwork(),
      refreshPath,
      claudeAgents,
      checkPins: true,
      checkMcpOnAdd: true,
      // Variables are kept with the Keychain. Where it can't be used, Kernel saves none rather than plain text (KERNEL-247).
      cipher: safeStorage.isEncryptionAvailable()
        ? { encrypt: (text) => safeStorage.encryptString(text).toString('base64'), decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')) }
        : undefined,
      // MCP sign-ins are shared between Claude logins through the Keychain. A smoke test leaves the user's items alone (KERNEL-616).
      keychain: smokeTest ? undefined : macKeychain(),
      version: app.getVersion(),
      log,
      updater,
      // A dev run has no updater and no notes in its build, so What's new reads the version's release file in the repo.
      currentNotes: app.isPackaged ? undefined : readNotes(join(app.getAppPath(), 'site', 'content', 'releases', `${app.getVersion()}.md`)),
      // Only the installed copy touches the login item, so a dev run or a dist/ build never registers or removes it.
      onSettings: (s) => { appearance?.set(s.appearance); const login = loginItemSettings(installed, s); if (login) app.setLoginItemSettings(login) },
      showNotification: (n, { silent, sound }) => {
        if (!Notification.isSupported()) return
        const banner = new Notification({ title: n.heading ?? n.title, body: n.sub, silent, ...(sound ? { sound } : {}) })
        banner.on('click', () => focusWindow())
        // macOS shows notifications only from a signed app (Electron 42), so an unsigned build says why here instead.
        banner.on('failed', (_e, error) => console.error(`[kernel] could not show a notification: ${error}`))
        banner.show()
      },
      confirmQuit: () => quit.confirmUpdate(),
      capture: preview,
      reveal: (path) => shell.showItemInFolder(path),
      // A Quick Look thumbnail, since app.getFileIcon goes by extension on macOS and draws every .app with the same icon.
      appIcon: (p) => {
        let icon = appIcons.get(p)
        if (!icon) appIcons.set(p, (icon = nativeImage.createThumbnailFromPath(p, { width: 32, height: 32 }).then((i) => i.toDataURL(), () => undefined)))
        return icon
      },
      openFile: async (path) => { const err = await shell.openPath(path); if (err) throw new Error(err) },
      // Only web pages, as system.openExternal: a sign-in page Codex or Claude Code names.
      openExternal: async (url) => { if (isWebUrl(url)) await shell.openExternal(url) }
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
    // The update timer ran late too, so waking checks for an update, at most every half hour (KERNEL-711).
    powerMonitor.on('resume', () => void started.then(() => updater?.wake(), () => undefined))
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
  // Only web pages: a URL a run script printed or a project's settings name must not open a file or another app (KERNEL-246).
  handle('system.openExternal' satisfies Channel, async (_e, { url }: KernelApi['system.openExternal']['req']) => {
    if (typeof url !== 'string' || !isWebUrl(url)) throw new Error('Kernel only opens http and https links')
    await shell.openExternal(url)
    return { ok: true }
  })
  const previews: PreviewHandlers = preview?.handlers() ?? previewFixture(fixture!)
  for (const [channel, fn] of Object.entries(previews) as [string, (req: unknown) => Promise<unknown>][]) handle(channel, async (_e, req) => { await started; return fn(req) })
  handle('system.fixture' satisfies Channel, async () => (fixture ? { ui: { ...fixture.ui, ...fixtureTheme() }, push: fixturePush(fixture) } : null))
  // The file view, plan rows, approval cards and Settings open in the default editor, through Open in's checks (KERNEL-427).
  handle('system.openInEditor' satisfies Channel, async (_e, { path }: KernelApi['system.openInEditor']['req']) => {
    await started
    return handlers['app.openIn']({ path })
  })
  bus.on('push', (event) => mainWindow()?.webContents.send('kernel:event', event))
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu({ copyDiagnostics: () => void copyDiagnostics().catch((err: unknown) => console.error('[kernel] could not copy diagnostics', err)) })))
  createWindow()
  app.on('activate', () => { if (!mainWindow()) createWindow() })
}).catch((err: unknown) => void bootFailed(err))

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
