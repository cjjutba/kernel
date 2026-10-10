import { constants } from 'node:fs'
import { readFile, writeFile, mkdir, copyFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { kernelHookMatcher, tokenArg } from '@shared/hookEntry'

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
const KERNEL_COMMAND = /^\/usr\/bin\/curl .* http:\/\/(localhost|127\.0\.0\.1):\d+\/hooks \|\| true$/
/** The http entries installs before KERNEL-56 wrote. Every install removes them, and they never count as installed. */
const isLegacy = (h: HookEntry) => h.type === 'http' && typeof h.url === 'string' && KERNEL_URL.test(h.url)
const isCommand = (h: HookEntry) => h.type === 'command' && typeof h.command === 'string' && KERNEL_COMMAND.test(h.command)
/** A command entry without this install's token gets a 401 from the server, so it counts as not installed (KERNEL-206). */
const isCurrent = (h: HookEntry, token: string) => isCommand(h) && h.command!.includes(` ${tokenArg(token)} `)
const isOurs = (h: HookEntry) => isLegacy(h) || isCommand(h)

/** Pure merge: returns settings with Kernel's hooks added (or replaced), old Kernel entries removed, and every other hook kept as is. */
export function withKernelHooks(settings: Settings, port: number, approvalTimeoutSec: number, token: string): Settings {
  // Drop every entry of ours first, so one an older install left (SessionStart, an http entry, an old token) goes too.
  const next = withoutKernelHooks(settings)
  next.hooks = { ...(next.hooks ?? {}) }
  for (const event of KERNEL_HOOK_EVENTS) {
    next.hooks![event] = [...(next.hooks![event] ?? []), kernelHookMatcher(event, port, approvalTimeoutSec, token)]
  }
  return next
}

export function withoutKernelHooks(settings: Settings): Settings {
  const hooks: Record<string, Matcher[]> = {}
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    const kept = matchers.map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isOurs(h)) })).filter((m) => m.hooks.length)
    if (kept.length) hooks[event] = kept
  }
  const next: Settings = { ...settings, hooks }
  if (!Object.keys(hooks).length) delete next.hooks
  return next
}

/** Events with a current Kernel hook. An old http entry or another token does not count, so Kernel offers Install, which replaces it. */
export function installedEvents(settings: Settings, token: string): string[] {
  return Object.entries(settings.hooks ?? {}).filter(([, ms]) => ms.some((m) => m.hooks.some((h) => isCurrent(h, token)))).map(([e]) => e)
}

/** Any Kernel hook, current or old. A port or timeout change rewrites the hooks only when this is true. */
export function hasKernelHooks(settings: Settings): boolean {
  return Object.values(settings.hooks ?? {}).some((ms) => ms.some((m) => m.hooks.some(isOurs)))
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

/**
 * Writes a temp file next to the target and renames it over, so Claude Code never reads half a file and a write of its own
 * lands whole, before or after ours. A symlinked settings file keeps its link: the write goes to the file it points at.
 * The hooks carry the token, so group and others lose read access (KERNEL-206).
 */
async function writeAtomic(file: string, settings: Settings) {
  const target = await realpath(file).catch(() => file)
  const mode = await stat(target).then((s) => s.mode & 0o700, () => 0o600)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { mode, flag: 'wx' })
    await rename(tmp, target)
  } catch (e) { await rm(tmp, { force: true }); throw e }
}

/** Writes ~/.claude/settings.json, keeping the first backup next to it. */
export async function installHooks(file: string, port: number, approvalTimeoutSec: number, token: string): Promise<string[]> {
  assertWritable(file)
  const current = await readSettings(file)
  await backupOnce(file)
  const next = withKernelHooks(current, port, approvalTimeoutSec, token)
  await writeAtomic(file, next)
  return installedEvents(next, token)
}

export async function uninstallHooks(file: string) {
  assertWritable(file)
  const current = await readSettings(file)
  await backupOnce(file)
  await writeAtomic(file, withoutKernelHooks(current))
}

export async function hookStatus(file: string, token: string) { return installedEvents(await readSettings(file), token) }

export async function kernelHooksPresent(file: string) { return hasKernelHooks(await readSettings(file)) }
