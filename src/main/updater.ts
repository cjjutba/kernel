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

/** What's saved in update.json: the downloaded version's notes, and whether What's new has shown them since it installed. */
interface Saved { version: string; notes: Note[]; shown: boolean }

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
  /** Restart to update was pressed while a newer version downloaded, so it installs once that one is ready. */
  private installWanted = false
  private tmp = 0
  /** Saves run one after another, so an older write never lands over a newer one. */
  private saving: Promise<void> = Promise.resolve()

  /** `notesFile` is the running version's notes in the build, written by scripts/release.sh (KERNEL-154). */
  /** `outside` is where a copy outside Applications runs from (`runsFrom` in loginItem.ts). */
  constructor(private o: {
    current: string; dataDir: string; engine: UpdateEngine; notesFile?: string; outside?: string
    /** Timings, for tests. They default to the constants above. */
    every?: number; retry?: number[]; stall?: number; wake?: number
  }) {
    this.file = join(o.dataDir, 'update.json')
    this.saved = readSaved(this.file)
    this.state = { status: 'idle', current: o.current, currentNotes: this.currentNotes(), blocked: o.outside && blockedReason(o.outside) }
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
      this.endDownload()
      this.succeeded()
      const notes = parseNotes(info.releaseNotes)
      this.set({ status: 'ready', version: info.version, notes, progress: undefined, error: undefined })
      this.save({ version: info.version, notes, shown: false })
      if (this.installWanted) this.o.engine.quitAndInstall()
    })
    e.on('error', (err) => {
      this.log(`check or download failed: ${err.message}`)
      this.endDownload()
      if (!this.ready()) this.set({ status: 'idle', version: undefined, notes: undefined, progress: undefined, error: err.message })
      this.fail()
    })
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
    if (this.fetching && result?.cancellationToken) this.cancel = result.cancellationToken
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
   * Restart to update. While a newer version downloads behind the ready one, it waits for that one, since the feed has
   * moved past the ready version. If the newer download fails, the ready one installs: Kernel has already stopped (KERNEL-711).
   */
  install() {
    if (this.state.status !== 'ready') throw new Error('No update is ready')
    if (this.fetching && this.fetching !== this.state.version) {
      this.installWanted = true
      return this.log(`install waits for ${this.fetching} to download`)
    }
    this.o.engine.quitAndInstall()
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
    // The newer version failed, and Kernel stopped for the restart, so the ready one installs.
    if (this.installWanted && this.ready()) this.o.engine.quitAndInstall()
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
