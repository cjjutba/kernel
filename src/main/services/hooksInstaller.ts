import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Events Kernel installs an http hook for. Tool events take a "*" matcher; the rest take none.
 * SessionStart is not here: Claude Code skips http hooks for it (D-020), so Kernel starts a session on its first hook.
 */
export const KERNEL_HOOK_EVENTS = [
  'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle'
] as const

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'])

type HookEntry = { type: string; url?: string; command?: string; timeout?: number }
type Matcher = { matcher?: string; hooks: HookEntry[] }
type Settings = { hooks?: Record<string, Matcher[]>; [k: string]: unknown }

export const hookUrl = (port: number) => `http://localhost:${port}/hooks`
const isOurs = (h: HookEntry) => h.type === 'http' && typeof h.url === 'string' && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/hooks$/.test(h.url)

/** Pure merge: returns settings with Kernel's hooks added (or replaced), old Kernel entries removed, and every other hook kept as is. */
export function withKernelHooks(settings: Settings, port: number, approvalTimeoutSec: number): Settings {
  // Drop every entry of ours first, so one an older install left on an event Kernel no longer uses (SessionStart) goes too.
  const next = withoutKernelHooks(settings)
  next.hooks = { ...(next.hooks ?? {}) }
  for (const event of KERNEL_HOOK_EVENTS) {
    const kept = (next.hooks![event] ?? []).map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isOurs(h)) })).filter((m) => m.hooks.length)
    const entry: HookEntry = { type: 'http', url: hookUrl(port), timeout: event === 'PermissionRequest' ? approvalTimeoutSec + 30 : 10 }
    kept.push(TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] })
    next.hooks![event] = kept
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

export function installedEvents(settings: Settings): string[] {
  return Object.entries(settings.hooks ?? {}).filter(([, ms]) => ms.some((m) => m.hooks.some(isOurs))).map(([e]) => e)
}

async function readSettings(file: string): Promise<Settings> {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (e: any) { if (e.code === 'ENOENT') return {}; throw new Error(`Could not parse ${file}: ${e.message}`) }
}

/** Writes ~/.claude/settings.json, keeping a one-time backup next to it. */
export async function installHooks(file: string, port: number, approvalTimeoutSec: number): Promise<string[]> {
  const current = await readSettings(file)
  await mkdir(dirname(file), { recursive: true })
  try { await copyFile(file, file + '.kernel-backup') } catch { /* first install */ }
  const next = withKernelHooks(current, port, approvalTimeoutSec)
  await writeFile(file, JSON.stringify(next, null, 2) + '\n')
  return installedEvents(next)
}

export async function uninstallHooks(file: string) {
  const current = await readSettings(file)
  await writeFile(file, JSON.stringify(withoutKernelHooks(current), null, 2) + '\n')
}

export async function hookStatus(file: string) { return installedEvents(await readSettings(file)) }
