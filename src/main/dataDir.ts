import Database from 'better-sqlite3'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { copyDatabase } from './migrations'

// Where Kernel keeps its data (KERNEL-408). The installed app uses `Kernel` and a dev run uses `Kernel Dev`, so `pnpm dev`
// from main never writes data an older installed build can't read. A dev run started inside a Kernel workspace uses a
// folder of its own in `Kernel Dev Runs`, so it opens next to the Kernel that started it (KERNEL-679). Electron stays out
// of this file, so tests drive it on temp folders.

export const APP_FOLDER = 'Kernel'
export const DEV_FOLDER = 'Kernel Dev'
export const RUNS_FOLDER = 'Kernel Dev Runs'

/**
 * What a dev run copies from `Kernel` besides the database. Caches, logs, telemetry and update.json stay behind, and so does
 * `hook-token`: each build has its own, so both can run at once (KERNEL-675).
 */
export const MOVED = ['settings.json', 'trust.json', 'integrations.json', 'env.json', 'project-icons', 'shared', 'Local Storage']

export interface DataDirs { own: string; other: string; name: string; otherName: string; run?: true }

/** A workspace id as Kernel makes them. Anything else is no folder name, so the launch is a plain dev run. */
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * This build's folder in `appData` and the other build's, with the names a person knows them by. `workspaceId` is
 * `KERNEL_WORKSPACE_ID` from the environment, which Kernel sets in every script and terminal of a workspace. An unpackaged
 * launch that has it is a workspace run: `own` is `Kernel Dev Runs/<workspace id>`, it starts empty and stays between runs,
 * and `other` is Kernel Dev, which it never reads (KERNEL-679).
 */
export function dataDirs(appData: string, packaged: boolean, workspaceId?: string): DataDirs {
  if (!packaged && workspaceId && WORKSPACE_ID.test(workspaceId)) {
    return { own: join(appData, RUNS_FOLDER, workspaceId), other: join(appData, DEV_FOLDER), name: RUNS_FOLDER, otherName: DEV_FOLDER, run: true }
  }
  const [name, otherName] = packaged ? [APP_FOLDER, DEV_FOLDER] : [DEV_FOLDER, APP_FOLDER]
  return { own: join(appData, name), other: join(appData, otherName), name, otherName }
}

/**
 * Whether a running Kernel holds `dir`. Chromium's single-instance lock is a `SingletonLock` symlink to `<host>-<pid>`,
 * and it stays behind after a crash, so it counts only when the host is this Mac and the process is alive.
 */
export function openBy(dir: string, host = hostname()): boolean {
  let target: string
  try { target = readlinkSync(join(dir, 'SingletonLock')) } catch { return false }
  const dash = target.lastIndexOf('-')
  const pid = Number(target.slice(dash + 1))
  if (dash < 0 || target.slice(0, dash) !== host || !Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

export type MoveResult = 'moved' | 'has-data' | 'nothing' | 'in-use'

/**
 * A dev run's first launch moves the data from `from` (Kernel) to `to` (Kernel Dev). It copies into `<to>.partial`, then
 * renames each entry into `to` with kernel.db last, so a crash anywhere before that rename leaves no kernel.db in `to` and
 * the next launch starts over. The old database is set aside as `kernel.db.moved-to-dev`, and the installed app starts
 * fresh. A failed copy throws; a failed set-aside only logs, since the data is already in `to`.
 */
export function moveToDev(o: { from: string; to: string; host?: string }): MoveResult {
  const db = join(o.from, 'kernel.db')
  if (existsSync(join(o.to, 'kernel.db'))) return 'has-data'
  if (!existsSync(db)) return 'nothing'
  // Checked last and right before the copy, so an installed app that opened meanwhile stops the move.
  if (openBy(o.from, o.host)) return 'in-use'
  const partial = `${o.to}.partial`
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(partial, { recursive: true })
  const source = new Database(db)
  try {
    copyDatabase(source, join(partial, 'kernel.db'))
    // Folds the WAL into the file, so the copy set aside below opens on its own.
    source.pragma('wal_checkpoint(TRUNCATE)')
  } finally { source.close() }
  for (const name of MOVED) {
    if (existsSync(join(o.from, name))) cpSync(join(o.from, name), join(partial, name), { recursive: true, preserveTimestamps: true })
  }
  mkdirSync(o.to, { recursive: true })
  for (const name of [...readdirSync(partial).filter((n) => n !== 'kernel.db'), 'kernel.db']) {
    rmSync(join(o.to, name), { recursive: true, force: true })
    renameSync(join(partial, name), join(o.to, name))
  }
  rmSync(partial, { recursive: true, force: true })
  try {
    renameSync(db, `${db}.moved-to-dev`)
    for (const end of ['-wal', '-shm']) rmSync(`${db}${end}`, { force: true })
  } catch (err) {
    console.warn(`[kernel] moved the data to ${o.to}, but could not set ${db} aside`, err)
  }
  return 'moved'
}

/**
 * Kernel Dev's move before KERNEL-675 copied `hook-token`, so both builds sent the same token. Removes `own`'s copy when it
 * matches `other`'s, so the next read makes a new one. Returns whether it did. A missing or unreadable file shares nothing.
 */
export function unshareHookToken(o: { own: string; other: string }): boolean {
  const read = (dir: string) => { try { return readFileSync(join(dir, 'hook-token'), 'utf8').trim() } catch { return undefined } }
  const mine = read(o.own)
  if (!mine || mine !== read(o.other)) return false
  rmSync(join(o.own, 'hook-token'), { force: true })
  return true
}

/**
 * Jira was a tracker until it was removed (remove-jira), and its account sat in `jira.json` in the data folder. Each launch
 * deletes it, so no saved Jira token is left behind. A missing file is fine, and a file it can't delete waits for the next launch.
 */
export function removeJiraAccount(dir: string) {
  try { rmSync(join(dir, 'jira.json'), { force: true }) } catch (err) { console.warn('[kernel] could not delete jira.json', err) }
}
