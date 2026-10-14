import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi, type Mock } from 'vitest'

// Loads src/main/index.ts as a packaged app launched with --kernel-update-test, with Electron, the kernel, the database
// and electron-updater swapped for fakes, and checks it touches none of Kernel's own state (KERNEL-713).
const h = vi.hoisted(() => {
  let ready!: () => void
  const whenReady = new Promise<void>((r) => { ready = r })
  return {
    ready: () => ready(),
    kernel: vi.fn(),
    database: vi.fn(),
    paths: new Map<string, string>(),
    lock: vi.fn(() => true),
    exit: vi.fn(),
    quit: vi.fn(),
    window: vi.fn(),
    whenReady,
    engine: undefined as unknown as { setFeedURL: Mock; allowDowngrade: boolean }
  }
})

vi.mock('electron', () => {
  const noop = () => undefined
  const app = {
    isPackaged: true,
    on: noop,
    once: noop,
    whenReady: () => h.whenReady,
    setPath: (name: string, p: string) => h.paths.set(name, p),
    getPath: (name: string) => h.paths.get(name) ?? join(tmpdir(), `kernel-update-mode-${name}`),
    getVersion: () => '0.1.0',
    getAppPath: () => tmpdir(),
    setActivationPolicy: noop,
    requestSingleInstanceLock: h.lock,
    isReady: () => true,
    exit: h.exit,
    quit: h.quit,
    dock: { setIcon: noop }
  }
  return {
    app,
    BrowserWindow: h.window,
    protocol: { registerSchemesAsPrivileged: noop },
    session: {}, WebContentsView: noop, clipboard: {}, dialog: {}, ipcMain: {}, Menu: {}, nativeImage: {}, nativeTheme: {},
    Notification: {}, powerMonitor: { on: noop }, safeStorage: {}, shell: {}
  }
})
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  const engine = Object.assign(new EventEmitter(), {
    autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: true, autoRunAppAfterInstall: true,
    setFeedURL: vi.fn(),
    checkForUpdates: async () => { engine.emit('checking-for-update'); engine.emit('update-not-available'); return null },
    quitAndInstall: vi.fn()
  })
  h.engine = engine
  return { default: { autoUpdater: engine } }
})
vi.mock('../src/main/kernel', () => ({ Kernel: h.kernel }))
vi.mock('better-sqlite3', () => ({ default: h.database }))

const argv = process.argv
afterAll(() => { process.argv = argv })

it('the update test keeps to its folder and never builds Kernel, opens the database or takes the lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-update-mode-'))
  process.argv = [argv[0], '--kernel-update-test', 'http://127.0.0.1:4410/feed', dir]
  await import('../src/main/index')
  expect(h.paths.get('userData')).toBe(dir)
  h.ready()
  await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(1))
  expect(h.engine.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'http://127.0.0.1:4410/feed' })
  expect(h.engine.allowDowngrade).toBe(false)
  expect(h.kernel).not.toHaveBeenCalled()
  expect(h.database).not.toHaveBeenCalled()
  expect(h.lock).not.toHaveBeenCalled()
  expect(h.window).not.toHaveBeenCalled()
  expect(h.quit).not.toHaveBeenCalled()
})
