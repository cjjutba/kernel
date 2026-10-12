import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { exec } from '../exec'
import { planName } from '../preflight'

// An added Claude account's folder, its CLAUDE_CONFIG_DIR (KERNEL-560, KERNEL-567). It holds the account's own `.claude.json`,
// and its login sits in a Keychain item named after the folder's exact path. Every other entry of `~/.claude` is linked in,
// so settings, Kernel's hooks, chats, MCP servers, plugins and skills stay one set however many accounts there are.

/**
 * What stays the account's own: its `.claude.json` and the CLI's copies of it, the plain-text login fallback, the MCP
 * servers that wait on its sign-in, its org's policy and managed settings, and the CLI's daemon.
 */
const CLAUDE_OWN = new Set([
  '.claude.json', '.credentials.json', 'backups', 'mcp-needs-auth-cache.json', 'policy-limits.json', 'policy-limits.json.stamp.json',
  'remote-settings.json', 'daemon', 'daemon.log', 'daemon-auth-cooldown', 'daemon-auth-status.json'
])

/** Real folders in the account's folder whose entries link to `~/.claude`'s, all but `synced`: claude.ai syncs each org's own skills and plugins there. */
const CLAUDE_MERGED = new Set(['skills', 'plugins'])

/** The `.claude.json` keys every account copies from the CLI login's: user and local MCP servers, and per-project state. */
const SHARED_KEYS = ['mcpServers', 'projects']

const lstatOf = (path: string) => { try { return lstatSync(path) } catch { return undefined } }

/**
 * Links every entry of `root` (`~/.claude`) into the account's folder `home` that the folder doesn't have yet, so what
 * `~/.claude` gained since is linked too. Run right after the login and before each use. An empty folder the CLI made
 * where a link goes gives way to the link. One with something in it stays.
 */
export function linkClaudeHome(home: string, root: string) {
  mkdirSync(home, { recursive: true })
  mkdirSync(root, { recursive: true })
  for (const name of readdirSync(root)) {
    if (CLAUDE_OWN.has(name)) continue
    if (!CLAUDE_MERGED.has(name)) { link(join(root, name), join(home, name)); continue }
    const into = join(home, name)
    // A link here would put the entries' links inside `~/.claude` itself.
    if (lstatOf(into)?.isSymbolicLink()) continue
    mkdirSync(into, { recursive: true })
    for (const entry of readdirSync(join(root, name))) if (entry !== 'synced') link(join(root, name, entry), join(into, entry))
  }
}

function link(target: string, at: string) {
  const s = lstatOf(at)
  if (s?.isDirectory()) { try { rmdirSync(at) } catch { return } } else if (s) return
  symlinkSync(target, at)
}

/**
 * Copies `mcpServers` and `projects` from the CLI login's `.claude.json` (`from`) into the account's, in place of its own,
 * so it has the same MCP servers. Every other key describes the account's login and stays. Written through a temp file at
 * mode 600. Nothing changes when either file can't be read whole, as when the CLI is writing it.
 */
export function copyClaudeConfig(home: string, from: string) {
  const file = join(home, '.claude.json')
  let shared: Record<string, unknown>
  let own: Record<string, unknown> = {}
  try { shared = JSON.parse(readFileSync(from, 'utf8')) } catch { return }
  try { own = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return }
  const next = { ...own }
  for (const key of SHARED_KEYS) { if (key in shared) next[key] = shared[key]; else delete next[key] }
  if (SHARED_KEYS.every((key) => JSON.stringify(next[key]) === JSON.stringify(own[key])) && lstatOf(file)) return
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/** Deletes an account's folder. A link goes as a link, so nothing in `~/.claude` it points to is touched. */
export async function removeClaudeHome(home: string): Promise<void> {
  const s = await lstat(home).catch(() => undefined)
  if (!s) return
  if (!s.isDirectory()) return unlink(home)
  for (const name of await readdir(home)) await removeClaudeHome(join(home, name))
  await rmdir(home)
}

/**
 * A Claude login's environment for a one-off command (`auth status`, `auth logout`), over the Mac's: the account's folder
 * when it has one, and never a token or key from the Mac, which would answer for another account (D-018).
 */
export function loginEnv(home: string | undefined): NodeJS.ProcessEnv {
  return { CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ...(home ? { CLAUDE_CONFIG_DIR: home } : {}) }
}

/** Who a Claude login is, from `claude auth status`. */
export interface ClaudeLogin { signedIn: boolean; email?: string; /** As the CLI says it, which the plan defaults read. */ subscriptionType?: string; /** "Claude Max". */ plan?: string }

/**
 * Reads a login through `bin`: an added account's with `loginEnv(home)`, the CLI's own with no `env`. Undefined when
 * the CLI didn't answer, which says nothing about the sign-in.
 */
export async function claudeStatus(bin: string, env?: NodeJS.ProcessEnv): Promise<ClaudeLogin | undefined> {
  const a = await exec(bin, ['auth', 'status'], { timeoutMs: 15_000, ...(env ? { env } : {}) })
  let s: { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown }
  try { s = JSON.parse(a.stdout) } catch { return undefined }
  if (typeof s?.loggedIn !== 'boolean') return undefined
  if (!s.loggedIn) return { signedIn: false }
  const type = typeof s.subscriptionType === 'string' && s.subscriptionType ? s.subscriptionType : undefined
  return { signedIn: true, ...(typeof s.email === 'string' ? { email: s.email } : {}), ...(type ? { subscriptionType: type, plan: planName(type) } : {}) }
}

/** `claude auth logout` for an added account's folder. It removes that folder's Keychain item, and the CLI's own login stays. */
export async function logoutClaude(bin: string, home: string) {
  await exec(bin, ['auth', 'logout'], { timeoutMs: 15_000, env: loginEnv(home) })
}
