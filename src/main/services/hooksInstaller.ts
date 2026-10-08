import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { kernelHookMatcher } from '@shared/hookEntry'

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
const isCurrent = (h: HookEntry) => h.type === 'command' && typeof h.command === 'string' && KERNEL_COMMAND.test(h.command)
const isOurs = (h: HookEntry) => isLegacy(h) || isCurrent(h)

/** Pure merge: returns settings with Kernel's hooks added (or replaced), old Kernel entries removed, and every other hook kept as is. */
export function withKernelHooks(settings: Settings, port: number, approvalTimeoutSec: number): Settings {
  // Drop every entry of ours first, so one an older install left (SessionStart, an http entry) goes too.
  const next = withoutKernelHooks(settings)
  next.hooks = { ...(next.hooks ?? {}) }
  for (const event of KERNEL_HOOK_EVENTS) {
    next.hooks![event] = [...(next.hooks![event] ?? []), kernelHookMatcher(event, port, approvalTimeoutSec)]
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

/** Events with a current Kernel hook. An old http entry does not count, so Kernel offers Install, which replaces it. */
export function installedEvents(settings: Settings): string[] {
  return Object.entries(settings.hooks ?? {}).filter(([, ms]) => ms.some((m) => m.hooks.some(isCurrent))).map(([e]) => e)
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

/** Writes ~/.claude/settings.json, keeping a one-time backup next to it. */
export async function installHooks(file: string, port: number, approvalTimeoutSec: number): Promise<string[]> {
  assertWritable(file)
  const current = await readSettings(file)
  await mkdir(dirname(file), { recursive: true })
  try { await copyFile(file, file + '.kernel-backup') } catch { /* first install */ }
  const next = withKernelHooks(current, port, approvalTimeoutSec)
  await writeFile(file, JSON.stringify(next, null, 2) + '\n')
  return installedEvents(next)
}

export async function uninstallHooks(file: string) {
  assertWritable(file)
  const current = await readSettings(file)
  await writeFile(file, JSON.stringify(withoutKernelHooks(current), null, 2) + '\n')
}

export async function hookStatus(file: string) { return installedEvents(await readSettings(file)) }

export async function kernelHooksPresent(file: string) { return hasKernelHooks(await readSettings(file)) }
