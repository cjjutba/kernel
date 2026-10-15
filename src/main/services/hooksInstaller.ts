import { constants } from 'node:fs'
import { access, readFile, writeFile, mkdir, copyFile, lstat, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { kernelHookMatcher, tokenArg } from '@shared/hookEntry'
import type { HookBuild, HookProblem } from '@shared/types'
import { shellQuote } from './health'
import { tildify } from './projects'

/**
 * Events Kernel installs a hook for. Tool events take a "*" matcher; the rest take none.
 * SessionStart is not here (D-047): Kernel starts a session on its first hook.
 */
export const KERNEL_HOOK_EVENTS = [
  'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle'
] as const

type HookEntry = { type: string; url?: string; command?: string; timeout?: number }
type Matcher = { matcher?: string; hooks: HookEntry[] }
type Settings = { hooks?: Record<string, Matcher[]>; [k: string]: unknown }

const KERNEL_URL = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/hooks$/
/** Each build's command ends at its own path, so the installed app's pattern never matches Kernel Dev's entries (KERNEL-675). */
const KERNEL_COMMAND: Record<HookBuild, RegExp> = {
  app: /^\/usr\/bin\/curl .* http:\/\/(localhost|127\.0\.0\.1):\d+\/hooks \|\| true$/,
  dev: /^\/usr\/bin\/curl .* http:\/\/(localhost|127\.0\.0\.1):\d+\/hooks\/dev \|\| true$/,
  // A workspace run has no entries, so nothing in the file is ever its own (KERNEL-679).
  run: /(?!)/
}
/** What a write for a workspace run says. It keeps no entries in the file, and a write would be over Kernel Dev's (KERNEL-679). */
export const RUN_HOOKS_OFF = 'Hooks are off for a workspace run. It never changes ~/.claude/settings.json.'
const assertHasEntries = (build: HookBuild) => { if (build === 'run') throw new Error(RUN_HOOKS_OFF) }
/**
 * The http entries installs before KERNEL-56 wrote. Every install removes them, and they never count as installed. They
 * predate Kernel Dev, so they are the installed app's.
 */
const isLegacy = (h: HookEntry, build: HookBuild) => build === 'app' && h.type === 'http' && typeof h.url === 'string' && KERNEL_URL.test(h.url)
const isCommand = (h: HookEntry, build: HookBuild) => h.type === 'command' && typeof h.command === 'string' && KERNEL_COMMAND[build].test(h.command)
/** A command entry without this install's token gets a 401 from the server, so it counts as not installed (KERNEL-206). */
const isCurrent = (h: HookEntry, token: string, build: HookBuild) => isCommand(h, build) && h.command!.includes(` ${tokenArg(token)} `)
/** This build's entries only. The other build's are some other program's hooks here, and stay as they are (KERNEL-675). */
const isOurs = (h: HookEntry, build: HookBuild) => isLegacy(h, build) || isCommand(h, build)

/** Pure merge: returns settings with Kernel's hooks added (or replaced), old Kernel entries removed, and every other hook kept as is. */
export function withKernelHooks(settings: Settings, port: number, approvalTimeoutSec: number, token: string, build: HookBuild = 'app'): Settings {
  // Drop every entry of ours first, so one an older install left (SessionStart, an http entry, an old token) goes too.
  const next = withoutKernelHooks(settings, build)
  next.hooks = { ...(next.hooks ?? {}) }
  for (const event of KERNEL_HOOK_EVENTS) {
    next.hooks![event] = [...(next.hooks![event] ?? []), kernelHookMatcher(event, port, approvalTimeoutSec, token, build)]
  }
  return next
}

export function withoutKernelHooks(settings: Settings, build: HookBuild = 'app'): Settings {
  const hooks: Record<string, Matcher[]> = {}
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    const kept = matchers.map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isOurs(h, build)) })).filter((m) => m.hooks.length)
    if (kept.length) hooks[event] = kept
  }
  const next: Settings = { ...settings, hooks }
  if (!Object.keys(hooks).length) delete next.hooks
  return next
}

/** Events with a current Kernel hook. An old http entry or another token does not count, so Kernel offers Install, which replaces it. */
export function installedEvents(settings: Settings, token: string, build: HookBuild = 'app'): string[] {
  return Object.entries(settings.hooks ?? {}).filter(([, ms]) => ms.some((m) => m.hooks.some((h) => isCurrent(h, token, build)))).map(([e]) => e)
}

/** Any Kernel hook, current or old. A port or timeout change rewrites the hooks only when this is true. */
export function hasKernelHooks(settings: Settings, build: HookBuild = 'app'): boolean {
  return Object.values(settings.hooks ?? {}).some((ms) => ms.some((m) => m.hooks.some((h) => isOurs(h, build))))
}

/**
 * Kernel's own entries brought up to date where they are, for the start of each run (KERNEL-206). An entry without this
 * install's token, or with another port or timeout, becomes the current one in the same place. An event with no Kernel entry
 * gets none, so a user who never installed gets nothing and one who removed an event keeps it removed. An entry for an event
 * Kernel no longer hooks (SessionStart, D-047) goes, as Install does. Every other hook stays as it is. Null when nothing changes.
 */
export function withCurrentKernelHooks(settings: Settings, port: number, approvalTimeoutSec: number, token: string, build: HookBuild = 'app'): Settings | null {
  let changed = false
  const hooks: Record<string, Matcher[]> = {}
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    const want = (KERNEL_HOOK_EVENTS as readonly string[]).includes(event) ? kernelHookMatcher(event, port, approvalTimeoutSec, token, build).hooks[0] : null
    let placed = false
    const next = matchers.map((m) => ({
      ...m,
      hooks: m.hooks.flatMap((h): HookEntry[] => {
        if (!isOurs(h, build)) return [h]
        // One Kernel entry per event: a second one would post every event twice.
        if (!want || placed) { changed = true; return [] }
        placed = true
        if (h.type === want.type && h.command === want.command && h.timeout === want.timeout) return [h]
        changed = true
        return [want]
      })
    }))
    // Only a group this emptied goes. One the user left empty stays.
    const kept = next.filter((m, i) => m.hooks.length || !matchers[i].hooks.length)
    if (kept.length) hooks[event] = kept
  }
  if (!changed) return null
  const out: Settings = { ...settings, hooks }
  if (!Object.keys(hooks).length) delete out.hooks
  return out
}

async function readSettings(file: string): Promise<Settings> {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (e: any) { if (e.code === 'ENOENT') return {}; throw new Error(`Could not parse ${file}: ${e.message}`) }
}

/** Tests never write the real Claude settings. A suite that reaches an install path passes a temp `home` or `claudeSettingsFile`. */
function assertWritable(file: string) {
  if (process.env.VITEST && resolve(file) === join(homedir(), '.claude', 'settings.json')) throw new Error(`Refusing to write ${file} under vitest. Pass a temp claudeSettingsFile.`)
}

/**
 * The first copy of the file before Kernel touched it. Never overwritten, so a second install or an uninstall can't replace
 * the user's original settings with ones Kernel already changed (KERNEL-206).
 */
async function backupOnce(file: string) {
  try { await copyFile(file, file + '.kernel-backup', constants.COPYFILE_EXCL) } catch (e: any) { if (e.code !== 'EEXIST' && e.code !== 'ENOENT') throw e }
}

/** A write of the settings file that failed in a way Check hooks explains (KERNEL-461). */
export type HookWriteProblem = Extract<HookProblem, { kind: 'not-writable' | 'read-only' | 'symlink' }>

/** Kernel couldn't write Claude Code's settings file, and the one step that fixes it. The settings file is unchanged. */
export class HooksFileError extends Error {
  constructor(readonly problem: HookWriteProblem) {
    super(problem.kind === 'not-writable' ? `Kernel can't write to ${problem.dir}. Run ${problem.fix} in Terminal, then install again.`
      : problem.kind === 'read-only' ? `${problem.dir} is on a read-only disk. Run ${problem.fix} in Terminal, then install again.`
      : `${problem.file} links to a read-only file. Replace the link with a copy, then install again: ${problem.fix.replace('\n', ' ')}`)
  }
}

/** A path in a command the user pastes: ~ for home, quoted when it has to be. */
function arg(p: string): string {
  const t = tildify(p)
  if (/^[\w@%+=:,./~-]+$/.test(t)) return t
  return t.startsWith('~/') ? `"$HOME"${shellQuote(t.slice(1))}` : shellQuote(t)
}

/** The folder a disk is mounted at: the highest folder above `p`, or above the nearest one that exists, on the same device. */
export async function mountPoint(p: string): Promise<string> {
  const dev = async (d: string) => (await stat(d).catch(() => null))?.dev
  let dir = resolve(p)
  let own = await dev(dir)
  while (own === undefined && dir !== dirname(dir)) { dir = dirname(dir); own = await dev(dir) }
  while (dir !== dirname(dir) && (await dev(dirname(dir))) === own) dir = dirname(dir)
  return dir
}

/** EACCES and EROFS become the error that names their fix. Anything else stays as it is. */
async function explain(e: unknown, file: string): Promise<unknown> {
  const err = e as NodeJS.ErrnoException & { dest?: string }
  if (err?.code !== 'EACCES' && err?.code !== 'EROFS') return e
  // The folder the write needed: the temp file's, the backup's, or the parent of one Kernel had to make.
  const dir = dirname(err.dest ?? err.path ?? file)
  if (err.code === 'EACCES') return new HooksFileError({ kind: 'not-writable', code: err.code, file: tildify(file), dir: tildify(dir), fix: `sudo chown -R "$USER" ${arg(dir)}` })
  const mount = await mountPoint(dir)
  return new HooksFileError({ kind: 'read-only', code: err.code, dir: tildify(dir), disk: basename(mount) || mount, fix: `sudo mount -uw ${arg(mount)}` })
}

/**
 * A settings file that links into a folder Kernel can't write, like the Nix store, is left alone, with an error that says how
 * to replace the link with a copy. A link into a folder Kernel can write, like a stow checkout, is written through.
 */
async function refuseReadOnlyLink(file: string, target: string) {
  if (!(await lstat(file).catch(() => null))?.isSymbolicLink()) return
  const code = await access(dirname(target), constants.W_OK).then(() => undefined, (e: NodeJS.ErrnoException) => e.code)
  if (code !== 'EACCES' && code !== 'EROFS') return
  const nix = target.startsWith('/nix/store/')
  throw new HooksFileError({ kind: 'symlink', code, file: tildify(file), store: nix ? '/nix/store' : tildify(dirname(target)), nix, fix: `rm ${arg(file)} &&\ncp ${arg(target)} ${arg(file)}` })
}

/**
 * Keeps the first backup, then writes a temp file next to the target and renames it over, so Claude Code never reads half a
 * file and a write of its own lands whole, before or after ours. A symlinked settings file keeps its link: the write goes to
 * the file it points at, unless that file sits in a folder Kernel can't write. The hooks carry the token, so group and others
 * lose read access (KERNEL-206). The owner keeps write access, so a copy of a read-only file stays one Claude Code can write.
 * A folder the account can't write or a read-only disk throws a HooksFileError (KERNEL-461).
 */
async function writeAtomic(file: string, settings: Settings) {
  const target = await realpath(file).catch(() => file)
  await refuseReadOnlyLink(file, target)
  const mode = await stat(target).then((s) => (s.mode & 0o700) | 0o600, () => 0o600)
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await backupOnce(file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { mode, flag: 'wx' })
    await rename(tmp, target)
  } catch (e) { await rm(tmp, { force: true }); throw await explain(e, file) }
}

/** Writes ~/.claude/settings.json, keeping the first backup next to it. */
export async function installHooks(file: string, port: number, approvalTimeoutSec: number, token: string, build: HookBuild = 'app'): Promise<string[]> {
  assertHasEntries(build)
  assertWritable(file)
  const next = withKernelHooks(await readSettings(file), port, approvalTimeoutSec, token, build)
  await writeAtomic(file, next)
  return installedEvents(next, token, build)
}

/** CheckHooksOff "Turn hooks on": takes disableAllHooks out of the file, after the first backup. Writes nothing when it isn't set. */
export async function turnHooksOn(file: string): Promise<boolean> {
  const { disableAllHooks, ...rest } = await readSettings(file)
  if (disableAllHooks === undefined) return false
  assertWritable(file)
  await writeAtomic(file, rest)
  return true
}

/**
 * Runs at start: rewrites Kernel's out-of-date entries with the same safe write as Install, and writes nothing when they are
 * current or there are none. Returns whether it wrote. Throws, leaving the file alone, when the file can't be read, parsed or
 * written, so Kernel can ask the user to install instead.
 */
export async function refreshHooks(file: string, port: number, approvalTimeoutSec: number, token: string, build: HookBuild = 'app'): Promise<boolean> {
  if (build === 'run') return false
  const next = withCurrentKernelHooks(await readSettings(file), port, approvalTimeoutSec, token, build)
  if (!next) return false
  assertWritable(file)
  await writeAtomic(file, next)
  return true
}

export async function uninstallHooks(file: string, build: HookBuild = 'app') {
  assertHasEntries(build)
  assertWritable(file)
  await writeAtomic(file, withoutKernelHooks(await readSettings(file), build))
}

export async function hookStatus(file: string, token: string, build: HookBuild = 'app') { return installedEvents(await readSettings(file), token, build) }

export async function kernelHooksPresent(file: string, build: HookBuild = 'app') { return hasKernelHooks(await readSettings(file), build) }
