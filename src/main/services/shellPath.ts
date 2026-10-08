import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { exec } from './exec'
import { loginShell } from './scripts'

const MARK = '__KERNEL_PATH__'
/** PATH as the app was started with. Each refresh builds from this, so repeated checks don't pile up folders. */
const launchPath = process.env.PATH

/** Where Homebrew, npm and the Claude Code installer put CLIs. Covers a login shell that can't be read. */
export function commonBins(home = homedir()): string[] {
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin')]
}

/** Joins PATH strings in order, keeping the first copy of each folder. */
export function mergePath(...paths: (string | null | undefined)[]): string {
  const seen = new Set<string>()
  for (const p of paths) for (const dir of (p ?? '').split(delimiter)) if (dir) seen.add(dir)
  return [...seen].join(delimiter)
}

/** Reads PATH out of shell output. The markers skip anything the user's rc files print. */
export function parseShellPath(out: string): string | null {
  return new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(out)?.[1] || null
}

/**
 * The PATH the user's terminal sees: an interactive login shell, so .zprofile and .zshrc both apply.
 * Null after `timeoutMs` even if the shell lingers. Something an rc file starts in the background
 * can hold stdout open past the kill, and startup waits on this.
 */
export async function shellPath(shell = loginShell(), timeoutMs = 5000): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs + 500) })
  const read = exec(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeoutMs }).then((r) => parseShellPath(r.stdout))
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}

/**
 * Opened from Finder or the Dock, the app gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so `claude`, `gh` and anything from Homebrew or npm is missing. This puts the terminal's PATH
 * first, then what the app started with, then the usual install folders.
 */
export async function refreshPath(shell = loginShell()): Promise<void> {
  process.env.PATH = mergePath(await shellPath(shell), launchPath, commonBins().join(delimiter))
}
