import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppUpdate } from '@shared/types'
import { bus } from './bus'

type Note = { title: string; body: string }

/** What electron-updater's `update-available` and `update-downloaded` carry that Kernel reads. */
export interface UpdateInfo { version: string; releaseNotes?: string | { version: string; note: string | null }[] | null }

/** The part of electron-updater's autoUpdater Kernel uses. Tests pass a fake. */
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update' | 'update-not-available', fn: () => void): unknown
  on(event: 'update-available' | 'update-downloaded', fn: (info: UpdateInfo) => void): unknown
  on(event: 'download-progress', fn: (p: { percent: number }) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

/** What's saved in update.json: the downloaded version's notes, and whether What's new has shown them since it installed. */
interface Saved { version: string; notes: Note[]; shown: boolean }

/** How often a running Kernel checks for a new release. */
export const CHECK_EVERY_MS = 4 * 3600_000

/** How long a Kernel that could not start waits for an update to download before it says so (KERNEL-408). */
export const BOOT_UPDATE_MS = 90_000

/**
 * Auto-update from GitHub Releases (KERNEL-30, UpdateReady.png, WhatsNew.png). A new version downloads in the
 * background; the footer pill appears once it's ready, and Restart to update installs it. After it installs,
 * the first `get()` says `installed` so What's new shows once with the release notes.
 *
 * Failures stay quiet: a check that can't reach GitHub (offline, or the repo still private) reports idle again.
 */
export class Updater {
  private state: AppUpdate
  private saved: Saved | null
  private timer?: NodeJS.Timeout
  private readonly file: string
  /** Called after every status change, for `readyWithin`. */
  private readonly watchers = new Set<() => void>()

  /** `notesFile` is the running version's notes in the build, written by scripts/release.sh (KERNEL-154). */
  constructor(private o: { current: string; dataDir: string; engine: UpdateEngine; every?: number; notesFile?: string }) {
    this.file = join(o.dataDir, 'update.json')
    this.saved = readSaved(this.file)
    this.state = { status: 'idle', current: o.current, currentNotes: this.currentNotes() }
    const e = o.engine
    e.autoDownload = true
    // A downloaded update installs on the next quit even without Restart to update.
    e.autoInstallOnAppQuit = true
    e.on('checking-for-update', () => { if (this.state.status !== 'ready') this.set({ status: 'checking', error: undefined }) })
    e.on('update-not-available', () => { if (this.state.status !== 'ready') this.set({ status: 'idle', version: undefined, notes: undefined, progress: undefined, error: undefined }) })
    e.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, notes: parseNotes(info.releaseNotes), progress: 0 }))
    e.on('download-progress', (p) => { if (this.state.status === 'downloading') this.set({ progress: Math.round(p.percent) }) })
    e.on('update-downloaded', (info) => {
      const notes = parseNotes(info.releaseNotes)
      this.set({ status: 'ready', version: info.version, notes, progress: undefined, error: undefined })
      this.save({ version: info.version, notes, shown: false })
    })
    e.on('error', (err) => {
      console.warn('[kernel] update check failed', err.message)
      if (this.state.status !== 'ready') this.set({ status: 'idle', version: undefined, notes: undefined, progress: undefined, error: err.message })
    })
  }

  /** Checks now and then every few hours. */
  start() {
    void this.check()
    this.timer = setInterval(() => void this.check(), this.o.every ?? CHECK_EVERY_MS)
    this.timer.unref?.()
  }

  stop() { clearInterval(this.timer) }

  get(): AppUpdate {
    const s = this.saved
    if (s && !s.shown && s.version === this.o.current) {
      this.save({ ...s, shown: true })
      return { ...this.state, installed: true, version: s.version, notes: s.notes }
    }
    return this.state
  }

  /** Settings > About and the timer. Resolves once the check is answered; the download carries on after. */
  async check(): Promise<AppUpdate> {
    if (this.state.status === 'ready' || this.state.status === 'downloading') return this.state
    await this.o.engine.checkForUpdates().catch(() => undefined)
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

  install() {
    if (this.state.status !== 'ready') throw new Error('No update is ready')
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

  private set(patch: Partial<AppUpdate>) {
    this.state = { ...this.state, ...patch }
    bus.push({ type: 'update', update: this.state })
    for (const w of [...this.watchers]) w()
  }

  private save(s: Saved) {
    this.saved = s
    void writeFile(this.file, JSON.stringify(s)).catch((err) => console.warn('[kernel] could not save update.json', err))
  }
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
