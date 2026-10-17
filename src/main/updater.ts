import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppUpdate } from '@shared/types'
import { bus } from './bus'

type Note = { title: string; body: string }

/** What electron-updater's `update-available` and `update-downloaded` carry that Kernel reads. */
export interface UpdateInfo { version: string; releaseNotes?: string | { version: string; note: string | null }[] | null }

/** electron-updater's logger shape. */
export interface UpdateLogger { info(m?: unknown): void; warn(m?: unknown): void; error(m?: unknown): void; debug?(m: string): void }

/** The part of electron-updater's autoUpdater Kernel uses. Tests pass a fake. */
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger?: UpdateLogger | null
  on(event: 'checking-for-update' | 'update-not-available', fn: () => void): unknown
  on(event: 'update-available' | 'update-downloaded', fn: (info: UpdateInfo) => void): unknown
  on(event: 'download-progress', fn: (p: { percent: number }) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  /** The result's token cancels the download the check started, so a stalled one can be retried. */
  checkForUpdates(): Promise<{ cancellationToken?: { cancel(): void } } | null | void>
  quitAndInstall(): void
}

/**
 * Electron's own autoUpdater, which is Squirrel.Mac. electron-updater reports a download before Squirrel has fetched and
 * validated it, so only this source's `update-downloaded` means the update can install (KERNEL-1020).
 */
export interface NativeUpdater {
  on(event: 'update-downloaded', fn: () => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
}

/** What's saved in update.json: the downloaded version's notes, whether What's new has shown them since it installed, and the install that failed. */
interface Saved { version: string; notes: Note[]; shown: boolean; installFailed?: AppUpdate['installFailed'] }

/** How long Kernel waits for the app to quit after Restart to update before it gives up on the install and relaunches (KERNEL-1020). */
export const INSTALL_QUIT_MS = 30_000

/** Squirrel's message when the new build's code signature doesn't match the running app's. */
const SIGNATURE_ERROR = /code signature|did not pass validation|code requirement/i

/** How often a running Kernel checks for a new release. */
export const CHECK_EVERY_MS = 4 * 3600_000

/** How long a failed check or download waits before the next try: the first failure, the second, then every one after (KERNEL-711). */
export const RETRY_MS = [5 * 60_000, 15 * 60_000, 3600_000]

/** A download with no progress for this long has stalled, so Kernel drops it and retries (KERNEL-711). */
export const STALL_MS = 10 * 60_000

/** Waking the Mac checks only when the last check is at least this old (KERNEL-711). */
export const WAKE_MS = 30 * 60_000

/** How long a Kernel that could not start waits for an update to download before it says so (KERNEL-408). */
export const BOOT_UPDATE_MS = 90_000

/**
 * Auto-update from GitHub Releases (KERNEL-30, UpdateReady.png, WhatsNew.png). A new version downloads in the
 * background; the footer pill appears once it's ready, and Restart to update installs it. After it installs,
 * the first `get()` says `installed` so What's new shows once with the release notes.
 *
 * Checks carry on after an update is ready. A newer version downloads behind the ready one, which stays in the pill until
 * the newer one replaces it. A failed check or download retries on `RETRY_MS`, a download with no progress for `STALL_MS`
 * is dropped and retried, and waking the Mac checks (KERNEL-711).
 *
 * Failures stay quiet: a check that can't reach GitHub (offline, or the repo still private) reports idle again.
 * A copy outside Applications never checks, since it can't replace itself, and says why in `blocked` (KERNEL-443).
 */
export class Updater {
  private state: AppUpdate
  private saved: Saved | null
  private readonly file: string
  /** Called after every status change, for `readyWithin`. */
  private readonly watchers = new Set<() => void>()
  /** The next check: `CHECK_EVERY_MS` after a check, or the backoff after a failure. Only set after `start()`. */
  private timer?: NodeJS.Timeout
  private started = false
  /** Failures in a row, for the backoff. A check with no update, or a finished download, puts it back to 0. */
  private failures = 0
  /** This check already failed, so its error event and its rejected promise count once. */
  private failed = false
  private lastCheck = 0
  /** The version downloading now. With an update ready, the download runs behind it and the pill doesn't change. */
  private fetching?: string
  private cancel?: { cancel(): void }
  private watchdog?: NodeJS.Timeout
  /** electron-updater has downloaded this version and Squirrel hasn't said yet whether it accepts it. */
  private staged?: { version: string; notes: Note[] }
  /** The skipped version's download was found by the check running now, so the check cancels it. */
  private skipping = false
  /** Restart to update has stopped Kernel and the app should quit. `failed` runs once if it doesn't. */
  private installing?: { failed: () => void; timer: NodeJS.Timeout }
  private tmp = 0
  /** Saves run one after another, so an older write never lands over a newer one. */
  private saving: Promise<void> = Promise.resolve()

  /** `notesFile` is the running version's notes in the build, written by scripts/release.sh (KERNEL-154). */
  /** `outside` is where a copy outside Applications runs from (`runsFrom` in loginItem.ts). */
  constructor(private o: {
    current: string; dataDir: string; engine: UpdateEngine; notesFile?: string; outside?: string
    /** Timings, for tests. They default to the constants above. */
    every?: number; retry?: number[]; stall?: number; wake?: number; installQuit?: number
    /** Squirrel.Mac, on macOS. With it, an update is ready only once Squirrel accepts it (KERNEL-1020). Without it, electron-updater's word is enough. */
    native?: NativeUpdater
  }) {
    this.file = join(o.dataDir, 'update.json')
    this.saved = readSaved(this.file)
    const failed = this.saved?.installFailed
    this.state = {
      status: 'idle', current: o.current, currentNotes: this.currentNotes(), blocked: o.outside && blockedReason(o.outside),
      installFailed: failed && failed.version !== o.current ? failed : undefined
    }
    const e = o.engine
    e.autoDownload = true
    // A downloaded update installs on the next quit even without Restart to update.
    e.autoInstallOnAppQuit = true
    // electron-updater's own lines, staging percentage and user ID included. Kernel's log keeps warnings and errors.
    e.logger = {
      info: (m) => console.warn('[updater]', m),
      warn: (m) => console.warn('[updater]', m),
      error: (m) => console.error('[updater]', m)
    }
    e.on('checking-for-update', () => { if (!this.ready()) this.set({ status: 'checking', error: undefined }) })
    e.on('update-not-available', () => {
      this.succeeded()
      if (!this.ready()) this.set({ status: 'idle', version: undefined, notes: undefined, progress: undefined, error: undefined })
    })
    e.on('update-available', (info) => {
      const skip = this.state.installFailed
      if (skip && skip.reason === 'signature' && skip.version === info.version) {
        this.log(`skipping ${info.version}: its signature failed Squirrel's check`)
        this.skipping = true
        if (!this.ready()) this.set({ status: 'idle', version: undefined, notes: undefined, progress: undefined, error: undefined })
        return
      }
      if (skip && skip.version !== info.version) this.clearInstallFailed()
      this.fetching = info.version
      this.armWatchdog()
      if (this.ready()) return this.log(`downloading ${info.version} behind ready ${this.state.version}`)
      this.set({ status: 'downloading', version: info.version, notes: parseNotes(info.releaseNotes), progress: 0 })
    })
    e.on('download-progress', (p) => {
      if (!this.fetching) return
      this.armWatchdog()
      if (this.state.status === 'downloading') this.set({ progress: Math.round(p.percent) })
    })
    e.on('update-downloaded', (info) => {
      const notes = parseNotes(info.releaseNotes)
      if (!o.native) return this.accept(info.version, notes)
      // Squirrel has yet to fetch it, so the version is only staged. Its verdict is the native event or an error.
      this.staged = { version: info.version, notes }
      this.armWatchdog()
      this.log(`${info.version} staged, waiting for Squirrel`)
      if (!this.ready()) this.set({ status: 'downloading', version: info.version, notes, progress: 100 })
    })
    e.on('error', (err) => this.onError(err))
    o.native?.on('update-downloaded', () => {
      const staged = this.staged
      if (!staged) return this.log('Squirrel accepted an update that is not staged')
      this.accept(staged.version, staged.notes)
    })
    o.native?.on('error', (err) => this.onError(err))
  }

  /** Checks now, then every few hours, sooner after a failure. */
  start() {
    if (this.state.blocked) return console.warn(`[kernel] updates are off: ${this.state.blocked}`)
    this.started = true
    void this.check()
  }

  stop() {
    this.started = false
    clearTimeout(this.timer)
    clearTimeout(this.watchdog)
  }

  /** The Mac woke. Timers ran late while it slept, so check, unless a check ran in the last `WAKE_MS`. */
  wake() {
    if (!this.started || Date.now() - this.lastCheck < (this.o.wake ?? WAKE_MS)) return
    this.log('checking after wake')
    void this.check()
  }

  get(): AppUpdate {
    const s = this.saved
    if (s && !s.shown && s.version === this.o.current) {
      this.save({ ...s, shown: true })
      return { ...this.state, installed: true, version: s.version, notes: s.notes }
    }
    return this.state
  }

  /**
   * Settings > About and the timer. Resolves once the check is answered; the download carries on after. A check during a
   * download leaves it alone. With an update ready it still checks, so a newer release replaces the ready one.
   */
  async check(): Promise<AppUpdate> {
    if (this.state.blocked || this.fetching) return this.state
    this.lastCheck = Date.now()
    this.failed = false
    this.next(this.o.every ?? CHECK_EVERY_MS)
    const result = await this.o.engine.checkForUpdates().catch((err: unknown) => {
      this.log(`check failed: ${err instanceof Error ? err.message : String(err)}`)
      this.fail()
      return undefined
    })
    if (this.skipping) {
      this.skipping = false
      result?.cancellationToken?.cancel()
    } else if (this.fetching && result?.cancellationToken) this.cancel = result.cancellationToken
    return this.state
  }

  /**
   * A Kernel that could not start checks once and waits for the download, at most `ms`, so a release that crashes at
   * launch can still install its fix (KERNEL-408). The version once an update is ready; undefined with no update, an error
   * or no answer in time.
   */
  readyWithin(ms: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.watchers.delete(watch)
        resolve(this.state.status === 'ready' ? this.state.version : undefined)
      }
      // An error or "no update" puts the status back to idle, whether it comes with the check or later in the download.
      const watch = () => { if (this.state.status === 'ready' || this.state.status === 'idle') finish() }
      const timer = setTimeout(finish, ms)
      this.watchers.add(watch)
      // Once the check is answered, only a download is worth waiting for. A check that failed without an error event leaves `checking`.
      void this.check().then(() => { if (this.state.status !== 'downloading') finish() })
    })
  }

  /**
   * Resolves with the version Restart to update can install, before Kernel stops. While a newer version downloads behind
   * the ready one it waits for Squirrel to accept that one, since the feed has moved past the ready version. If the newer
   * one fails or stalls, the ready one is the answer. Rejects when nothing is ready, or the ready one is rejected meanwhile (KERNEL-1020).
   */
  whenInstallable(): Promise<string> {
    return new Promise((resolve, reject) => {
      const watch = () => {
        if (this.state.status !== 'ready') {
          this.watchers.delete(watch)
          return reject(new Error('No update is ready'))
        }
        if (this.fetching && this.fetching !== this.state.version) return
        this.watchers.delete(watch)
        resolve(this.state.version!)
      }
      if (this.fetching && this.fetching !== this.state.version) this.log(`install waits for ${this.fetching} to download`)
      this.watchers.add(watch)
      watch()
    })
  }

  /**
   * Restart to update, once `whenInstallable` has answered and Kernel has stopped. Squirrel quits the app to install. If it
   * hasn't quit within `INSTALL_QUIT_MS`, or Squirrel reports an error, the install is recorded as failed and `failed`
   * runs once, so the caller can relaunch the running version. No timer or retry ever installs.
   */
  install(failed: () => void = () => undefined) {
    if (this.state.status !== 'ready') throw new Error('No update is ready')
    clearTimeout(this.installing?.timer)
    const timer = setTimeout(() => this.installFailedNow(new Error(`Kernel did not quit within ${(this.o.installQuit ?? INSTALL_QUIT_MS) / 1000} s`)), this.o.installQuit ?? INSTALL_QUIT_MS)
    timer.unref?.()
    this.installing = { failed, timer }
    this.o.engine.quitAndInstall()
  }

  /** Squirrel accepted `version` (or electron-updater did, without Squirrel). */
  private accept(version: string, notes: Note[]) {
    this.succeeded()
    this.set({ status: 'ready', version, notes, progress: undefined, error: undefined, installFailed: undefined })
    // After the status change, so a waiting Restart sees the new version and not the old one.
    this.endDownload()
    this.save({ version, notes, shown: false })
  }

  private onError(err: Error) {
    this.log(`check or download failed: ${err.message}`)
    if (this.installing) return this.installFailedNow(err)
    const rejected = this.staged?.version
    this.staged = undefined
    this.endDownload()
    if (rejected !== undefined) this.rejected(rejected, err)
    else if (!this.ready()) this.set({ status: 'idle', version: undefined, notes: undefined, progress: undefined, error: err.message })
    this.fail()
  }

  /** Squirrel refused `version`. A newer one failing behind an accepted ready one leaves the ready one offered. */
  private rejected(version: string, err: Error) {
    if (this.ready() && this.state.version !== version) return
    this.dropOffer(version, err, err.message)
  }

  /** The offer leaves, and the failure is kept for Settings, About and, for a signature, to skip the version. */
  private dropOffer(version: string, err: Error, shown?: string) {
    const reason = SIGNATURE_ERROR.test(err.message) ? 'signature' : 'other'
    const installFailed = { version, reason } as const
    this.set({ status: 'idle', version: undefined, notes: undefined, progress: undefined, error: shown, installFailed })
    this.save({ ...(this.saved ?? { version: '', notes: [], shown: true }), installFailed })
  }

  private installFailedNow(err: Error) {
    const install = this.installing
    if (!install) return
    clearTimeout(install.timer)
    this.installing = undefined
    this.log(`install failed: ${err.message}`)
    this.dropOffer(this.state.version ?? '', err)
    install.failed()
  }

  private clearInstallFailed() {
    this.set({ installFailed: undefined })
    if (this.saved?.installFailed) this.save({ ...this.saved, installFailed: undefined })
  }

  /**
   * What's new for the version that's running, when no update is ready (KERNEL-154). A release build carries its notes.
   * A build without them falls back to update.json, which has them when Kernel updated itself to this version.
   */
  private currentNotes(): Note[] | undefined {
    const notes = readNotes(this.o.notesFile)
    if (notes.length) return notes
    return this.saved?.version === this.o.current && this.saved.notes.length ? this.saved.notes : undefined
  }

  private ready() { return this.state.status === 'ready' }

  /** Schedules the next check `ms` from now, replacing the one scheduled. */
  private next(ms: number) {
    clearTimeout(this.timer)
    if (!this.started) return
    this.timer = setTimeout(() => void this.check(), ms)
    this.timer.unref?.()
  }

  private succeeded() {
    this.failures = 0
    this.next(this.o.every ?? CHECK_EVERY_MS)
  }

  /** Retries on the backoff. A check fails once, however many ways electron-updater reports it. */
  private fail() {
    if (this.failed) return
    this.failed = true
    const retry = this.o.retry ?? RETRY_MS
    const ms = retry[Math.min(this.failures, retry.length - 1)]
    this.failures++
    if (this.started) this.log(`retrying in ${Math.round(ms / 60_000)} min`)
    this.next(ms)
  }

  private armWatchdog() {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => this.stalled(), this.o.stall ?? STALL_MS)
    this.watchdog.unref?.()
  }

  private endDownload() {
    clearTimeout(this.watchdog)
    this.fetching = undefined
    this.cancel = undefined
    this.staged = undefined
    for (const w of [...this.watchers]) w()
  }

  /** No progress for `STALL_MS`: drop the download, so the retry can start a new one. electron-updater waits on the old one otherwise. */
  private stalled() {
    this.log(`download of ${this.fetching} stalled`)
    const cancel = this.cancel
    this.endDownload()
    cancel?.cancel()
    if (!this.ready()) this.set({ status: 'idle', version: undefined, notes: undefined, progress: undefined })
    this.fail()
  }

  private log(what: string) {
    console.warn(`[kernel] update: ${what} (running ${this.o.current})`)
  }

  private set(patch: Partial<AppUpdate>) {
    const before = this.state
    this.state = { ...this.state, ...patch }
    if (before.status !== this.state.status || before.version !== this.state.version) this.log(`${this.state.status}${this.state.version ? ` ${this.state.version}` : ''}`)
    bus.push({ type: 'update', update: this.state })
    for (const w of [...this.watchers]) w()
  }

  /** Writes a temporary file and renames it over update.json, so a crash mid-write never leaves half a file. */
  private save(s: Saved) {
    this.saved = s
    const tmp = `${this.file}.${process.pid}.${++this.tmp}.tmp`
    this.saving = this.saving
      .then(() => writeFile(tmp, JSON.stringify(s)))
      .then(() => rename(tmp, this.file))
      .catch((err) => console.warn('[kernel] could not save update.json', err))
  }
}

/**
 * Why a copy outside Applications can't update itself, for Settings, About. Squirrel replaces the app where it runs, and a
 * disk image or a translocated copy is read-only, so Kernel doesn't download an update it can't install (KERNEL-443).
 */
export function blockedReason(place: string): string {
  return `Kernel is running from ${place}. Move it to Applications and open it from there.`
}

/** A notes file as What's new items, or none when the file isn't there. */
export function readNotes(file: string | undefined): Note[] {
  try { return file ? parseNotes(readFileSync(file, 'utf8')) : [] } catch { return [] }
}

function readSaved(file: string): Saved | null {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Saved
    return typeof s.version === 'string' && Array.isArray(s.notes) ? s : null
  } catch { return null }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/** Drops markdown emphasis and a trailing PR reference such as "(#44)" or "(#44, #45)". */
const clean = (s: string) => s.replace(/\*\*/g, '').replace(/\s*\(#\d+(?:,\s*#\d+)*\)$/, '').trim()

/**
 * Release notes to What's new items. Each `###` heading (or `<h3>`, since the GitHub feed sends HTML) is a title,
 * and the text under it until the next heading is the body. Each list item starts a new line of the body, and
 * paragraph text joins the line it follows. Text before the first heading is dropped. The notes come from
 * `pnpm release:notes --app` (scripts/notes.ts, D-058).
 */
export function parseNotes(raw: UpdateInfo['releaseNotes']): Note[] {
  if (!raw) return []
  const text = Array.isArray(raw) ? raw.map((r) => r.note ?? '').join('\n') : raw
  const md = text
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n### $1\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>|<\/(p|li|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? m)
  const notes: Note[] = []
  for (const line of md.split('\n').map((l) => l.trim())) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) notes.push({ title: clean(heading[1]), body: '' })
    else if (line && notes.length) {
      const n = notes[notes.length - 1]
      const item = /^[-*]\s+(.*)$/.exec(line)
      const part = clean(item ? item[1] : line)
      if (part) n.body = n.body ? `${n.body}${item ? '\n' : ' '}${part}` : part
    }
  }
  return notes.filter((n) => n.title)
}

/** The flag for the end-to-end update test (KERNEL-713). */
export const UPDATE_TEST_FLAG = '--kernel-update-test'

/**
 * `--kernel-update-test [<feed-url> <dir>]` from the command line, or undefined without the flag. The values are the
 * arguments after the flag up to the next one starting with `-`, so a `-psn_` argument macOS adds is never read as one.
 */
export function updateTestArgs(argv: string[]): { feed?: string; dir?: string } | undefined {
  const at = argv.indexOf(UPDATE_TEST_FLAG)
  if (at < 0) return undefined
  const rest = argv.slice(at + 1)
  const end = rest.findIndex((a) => a.startsWith('-'))
  const values = end < 0 ? rest : rest.slice(0, end)
  return { feed: values[0], dir: values[1] }
}

/** The part of electron-updater's autoUpdater the update test sets as well. */
export interface UpdateTestEngine extends UpdateEngine {
  allowDowngrade: boolean
  autoRunAppAfterInstall: boolean
  setFeedURL(feed: { provider: 'generic'; url: string }): void
}

/**
 * The update test (KERNEL-713): points the updater at a generic feed, waits for the update, prints `ready <version>` and
 * quits so it installs, or prints `none` and exits 1. It never relaunches, so the new build never opens a full Kernel.
 *
 * Squirrel.Mac checks the new build's code signature against the running app's, and `allowDowngrade` stays false, so the
 * test can only install a newer build signed by the same team. Nothing here turns either check off.
 *
 * On macOS, electron-updater reports the download before Squirrel has fetched it, so the test quits through
 * `quitAndInstall`, which waits for Squirrel. With `autoRunAppAfterInstall` off that is a plain quit, and Squirrel
 * installs the update as the app exits. A quit that hasn't happened `within` later exits 1.
 */
export async function runUpdateTest(o: {
  feed: string; dir: string; current: string; engine: UpdateTestEngine
  print(line: string): void; exit(code: number): void; within?: number; native?: NativeUpdater
}) {
  const within = o.within ?? BOOT_UPDATE_MS
  o.engine.setFeedURL({ provider: 'generic', url: o.feed })
  o.engine.allowDowngrade = false
  o.engine.autoRunAppAfterInstall = false
  // No `outside`: Squirrel replaces the app wherever it runs, and the test runs a copy outside Applications.
  const updater = new Updater({ current: o.current, dataDir: o.dir, engine: o.engine, native: o.native })
  const version = await updater.readyWithin(within)
  if (!version) {
    o.print('none')
    return o.exit(1)
  }
  o.print(`ready ${version}`)
  setTimeout(() => {
    console.error(`[kernel] update test: ${version} did not install within ${within / 1000} s`)
    o.exit(1)
  }, within)
  updater.install(() => {
    console.error(`[kernel] update test: ${version} did not install`)
    o.exit(1)
  })
}
