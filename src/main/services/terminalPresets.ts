import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { AppSettings, Chat, TerminalPreset, WorkspaceMode } from '@shared/types'

type TerminalSettings = AppSettings['terminal']

export const SKIP_FLAG = '--dangerously-skip-permissions'
/**
 * The flag as the shell hands it to `claude`: quoted, after a backslash, with `=value`, or next to `;`, `|`, `&`, `<` and `>`.
 * `--dangerously-skip-permissions-x` is another word and is left alone. A variable or an alias can't be caught (KERNEL-248).
 */
const SKIP_WORD = /(^|[\s;&|(])\\?(["']?)--dangerously-skip-permissions(?:=[^\s;&|()<>"']*)?\2(?=$|[\s;&|)<>])/g

export const BUILTIN_PRESETS: readonly TerminalPreset[] = [
  { id: 'claude', name: 'Claude', command: 'claude', builtin: true, skipsPermissions: false },
  { id: 'claude-skip', name: 'Claude without permission prompts', command: `claude ${SKIP_FLAG}`, builtin: true, skipsPermissions: true },
  { id: 'shell', name: 'Shell', command: null, builtin: true, skipsPermissions: false }
]

/** Other agent CLIs, listed when found on the PATH. Each runs its plain command; flags go in a custom command. */
export const KNOWN_CLIS: readonly { id: string; name: string }[] = [
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'amp', name: 'Amp' },
  { id: 'copilot', name: 'Copilot' },
  { id: 'gemini', name: 'Gemini' }
]

export const skipsPermissions = (command: string) => new RegExp(SKIP_WORD.source).test(command)
/** Removes every form of the flag. The space before it goes with it, a `;` or `(` before it stays. */
const withoutSkip = (command: string) => command.replace(SKIP_WORD, (_, before: string) => (/\s/.test(before) ? '' : before)).trim()

/** An executable file named `bin` in one of PATH's folders. Nothing is run. */
async function onPath(bin: string, path: string): Promise<boolean> {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const file = join(dir, bin)
    try {
      if ((await stat(file)).isFile()) { await access(file, constants.X_OK); return true }
    } catch { /* not here */ }
  }
  return false
}

/** The known CLIs on `path`, the app's PATH as `refreshPath` last set it. */
export async function foundClis(path = process.env.PATH ?? ''): Promise<TerminalPreset[]> {
  const found = await Promise.all(KNOWN_CLIS.map((c) => onPath(c.id, path)))
  return KNOWN_CLIS.filter((_, i) => found[i]).map((c) => ({ id: c.id, name: c.name, command: c.id, builtin: true, skipsPermissions: false }))
}

/** The built-ins, then the found CLIs, then the custom commands. A custom id that repeats an earlier one is left out. */
export function presetList(t: TerminalSettings, clis: TerminalPreset[]): TerminalPreset[] {
  const out: TerminalPreset[] = [...BUILTIN_PRESETS, ...clis]
  for (const c of t.custom) out.push({ id: c.id, name: c.name, command: c.command, builtin: false, skipsPermissions: skipsPermissions(c.command) })
  const seen = new Set<string>()
  return out.filter((p) => !seen.has(p.id) && !!seen.add(p.id))
}

export async function terminalPresets(t: TerminalSettings, path?: string): Promise<TerminalPreset[]> {
  return presetList(t, await foundClis(path))
}

/**
 * What a new tab runs. `id` unset means the settings' preset, and Claude when that one is gone (a CLI uninstalled,
 * a custom command removed). An id that was asked for and isn't listed is an error. With Only in worktrees on,
 * a current-branch workspace runs the command without the skip-permissions flag.
 */
export function resolvePreset(list: TerminalPreset[], t: TerminalSettings, mode: WorkspaceMode, id?: string): { preset: TerminalPreset; terminal: NonNullable<Chat['terminal']> } {
  const preset = id !== undefined ? list.find((p) => p.id === id) : list.find((p) => p.id === t.preset) ?? list[0]
  if (!preset) throw new Error('That terminal preset is gone. Pick another one.')
  const keep = !(t.onlyInWorktrees && mode === 'current')
  const command = preset.command !== null && preset.skipsPermissions && !keep ? withoutSkip(preset.command) : preset.command
  return { preset, terminal: { preset: preset.id, command } }
}

/** "Terminal (codex)": a built-in or found CLI by its id, a custom command by the name the user gave it. */
export const terminalTitle = (p: TerminalPreset) => `Terminal (${p.builtin ? p.id : p.name})`

/** The command a terminal chat types in. Chats from before presets have no `terminal` and ran `claude`. */
export const terminalCommand = (chat: Chat): string | null => (chat.terminal ? chat.terminal.command : 'claude')

/**
 * Settings as saved, made safe to use: custom commands need an id, a name and a command, and ids don't repeat. An id a
 * built-in or a known CLI uses is left out, or the custom command would vanish once that CLI is installed.
 */
export function terminalSettingsOf(v: unknown, defaults: TerminalSettings): TerminalSettings {
  const t = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof TerminalSettings, unknown>>
  const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d)
  const seen = new Set<string>([...BUILTIN_PRESETS, ...KNOWN_CLIS].map((p) => p.id))
  const custom = (Array.isArray(t.custom) ? t.custom : [])
    .filter((c): c is TerminalSettings['custom'][number] => typeof c?.id === 'string' && !!c.id && typeof c.name === 'string' && typeof c.command === 'string' && !!c.command.trim())
    .filter((c) => !seen.has(c.id) && !!seen.add(c.id))
    .map((c) => ({ id: c.id, name: c.name, command: c.command }))
  return {
    enabled: bool(t.enabled, defaults.enabled),
    preset: typeof t.preset === 'string' && t.preset ? t.preset : defaults.preset,
    onlyInWorktrees: bool(t.onlyInWorktrees, defaults.onlyInWorktrees),
    custom
  }
}
