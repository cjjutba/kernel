import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { exec } from '../exec'
import { planName } from '../preflight'
import { plainText, TOKEN_COLS } from './claudeToken'

// An added Claude account's folder, its CLAUDE_CONFIG_DIR (KERNEL-560, KERNEL-567). It holds the account's own `.claude.json`,
// and its login sits in a Keychain item named after the folder's exact path. Every other entry of `~/.claude` is linked in,
// so settings, Kernel's hooks, chats, MCP servers, plugins and skills stay one set however many accounts there are.

/**
 * What stays the account's own: its `.claude.json`, its lock and the CLI's copies of it, the plain-text login fallback, the MCP
 * servers that wait on its sign-in, its org's policy and managed settings, and the CLI's daemon.
 */
const CLAUDE_OWN = new Set([
  '.claude.json', '.claude.json.lock', '.credentials.json', 'backups', 'mcp-needs-auth-cache.json', 'policy-limits.json', 'policy-limits.json.stamp.json',
  'remote-settings.json', 'daemon', 'daemon.log', 'daemon-auth-cooldown', 'daemon-auth-status.json'
])

/** Real folders in the account's folder whose entries link to `~/.claude`'s, all but `synced`: claude.ai syncs each org's own skills and plugins there. */
const CLAUDE_MERGED = new Set(['skills', 'plugins'])

/** The `.claude.json` keys every account copies from the CLI login's: user and local MCP servers, and per-project state. */
const SHARED_KEYS = ['mcpServers', 'projects']

const lstatOf = (path: string) => { try { return lstatSync(path) } catch { return undefined } }

/**
 * A lock of Claude Code's: a folder `<name>.lock` that is there only while a process holds it. Each login takes its own in
 * its own folder, `.storage-write.lock` to save its login and `.oauth_refresh.lock` to renew it. A link to one in `~/.claude`
 * points at nothing once that lock is released, and Claude Code then finds the name taken on every try: the account could
 * never save or renew its login again (feat-make-claude-account-credentials-and).
 */
const isLock = (name: string) => name.endsWith('.lock')

/**
 * Links every entry of `root` (`~/.claude`) into the account's folder `home` that the folder doesn't have yet, so what
 * `~/.claude` gained since is linked too. Run right after the login and before each use. An empty folder the CLI made
 * where a link goes gives way to the link. One with something in it stays. A lock is never linked, and a link to one that
 * an older Kernel left goes (`isLock`).
 */
export function linkClaudeHome(home: string, root: string) {
  mkdirSync(home, { recursive: true })
  mkdirSync(root, { recursive: true })
  for (const name of readdirSync(home)) {
    if (isLock(name) && lstatOf(join(home, name))?.isSymbolicLink()) { try { unlinkSync(join(home, name)) } catch { /* the next pass tries again */ } }
  }
  for (const name of readdirSync(root)) {
    if (CLAUDE_OWN.has(name) || isLock(name)) continue
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

/** What Kernel last left of the MCP servers in an account's `.claude.json`, kept in its folder (KERNEL-618). */
const MCP_BASE = 'kernel-mcp-base.json'

/** How old a `.claude.json.lock` is before it counts as left behind: Claude Code's lock library renews its own every 5 seconds and calls 10 stale. */
const LOCK_STALE_MS = 10_000

/**
 * How old a login's `.storage-write.lock` is before it counts as left behind. Claude Code 2.1.292 renews its own every 7.5
 * seconds and calls 15 stale, and Kernel waits twice that before it takes one over.
 */
const STORE_STALE_MS = 30_000

type Servers = Record<string, unknown>
/** The MCP servers of a `.claude.json`: the user ones, and the local ones of each project that has any. */
interface McpServers { mcpServers?: Servers; projects?: Record<string, Servers> }

const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined)

/** JSON with every object's keys sorted, so two servers compare by what they hold. */
const canon = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (record(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))
const same = (a: unknown, b: unknown) => canon(a) === canon(b)

/**
 * One set of MCP servers after a sync: the CLI login's (`cli`) with what the account changed since `base`, what Kernel last
 * left it. A server the account added, changed or removed since then goes the same way on the CLI login, unless the CLI login
 * changed it too, which wins. Without a base, a server only the account has counts as one it added. An account with no
 * servers object changed nothing: `claude mcp remove` leaves an empty one, and only a file that was reset has none, which
 * must not remove every server from the CLI login (KERNEL-618).
 */
function mergeServers(cli: Servers | undefined, acct: Servers | undefined, base: Servers | undefined): Servers {
  const out: Servers = { ...cli }
  if (!acct) return out
  for (const name of new Set([...Object.keys(acct), ...Object.keys(base ?? {})])) {
    const a = acct?.[name]
    if (same(a, base?.[name]) || !same(cli?.[name], base?.[name])) continue
    if (a === undefined) delete out[name]
    else out[name] = a
  }
  return out
}

/**
 * `projects` after a sync: the local MCP servers of each project the account has merged as `mergeServers` does. A project only
 * the account has comes along with its servers. One the account lacks changed nothing there.
 */
function mergeProjects(cli: Record<string, unknown> | undefined, acct: Record<string, unknown> | undefined, base: Record<string, Servers> | undefined) {
  const out = { ...cli }
  for (const [path, p] of Object.entries(acct ?? {})) {
    const c = record(cli?.[path])
    const was = record(c?.mcpServers)
    const servers = mergeServers(was, record(record(p)?.mcpServers), base?.[path])
    if (!same(servers, was ?? {})) out[path] = { ...(c ?? record(p)), mcpServers: servers }
  }
  return out
}

/** The MCP servers a `.claude.json` holds, as `MCP_BASE` keeps them. */
function serversOf(config: Record<string, unknown>): McpServers {
  const projects = Object.entries(record(config.projects) ?? {}).flatMap(([path, p]) => {
    const servers = record(record(p)?.mcpServers)
    return servers && Object.keys(servers).length ? [[path, servers] as const] : []
  })
  const user = record(config.mcpServers)
  return { ...(user && Object.keys(user).length ? { mcpServers: user } : {}), ...(projects.length ? { projects: Object.fromEntries(projects) } : {}) }
}

/**
 * Takes Claude Code's own lock on a config file, the folder `<file>.lock` its lock library makes, so neither writes over the
 * other's change. One older than `staleMs` was left behind and goes. Returns the release, or undefined while a CLI holds it.
 */
function lockConfig(file: string, staleMs = LOCK_STALE_MS): (() => void) | undefined {
  const dir = `${file}.lock`
  for (let tries = 0; tries < 2; tries++) {
    try {
      mkdirSync(dir)
      return () => { try { rmdirSync(dir) } catch { /* gone already */ } }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
      if (Date.now() - (lstatOf(dir)?.mtimeMs ?? Date.now()) <= staleMs) return undefined
      try { rmdirSync(dir) } catch { return undefined }
    }
  }
  return undefined
}

/** Writes JSON through a temp file beside `file`, at `mode`. */
function writeJson(file: string, value: unknown, mode: number) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode })
  renameSync(tmp, file)
}

/**
 * Keeps an account's `.claude.json` and the CLI login's (`from`) on one set of MCP servers (KERNEL-560, KERNEL-618). A user
 * or local server added, changed or removed on the account since Kernel last synced it goes to the CLI login first, through
 * Claude Code's own lock, so no server added on either login is lost. Then the account gets `mcpServers` and `projects` from
 * the CLI login in place of its own, and every other key, which describes its login, stays. What the account then holds is
 * kept as its base, which tells a server one login removed from one the other added. Writes go through temp files at the
 * files' own modes, 600 for the account. Nothing changes while a CLI holds either lock or either file can't be read whole.
 */
export function syncClaudeConfig(home: string, from: string) {
  const file = join(home, '.claude.json')
  const unlockFrom = lockConfig(from)
  if (!unlockFrom) return
  try {
    const unlockOwn = lockConfig(file)
    if (!unlockOwn) return
    try { syncLocked(home, file, from) } finally { unlockOwn() }
  } finally { unlockFrom() }
}

function syncLocked(home: string, file: string, from: string) {
  let shared: Record<string, unknown> | undefined
  let own: Record<string, unknown> = {}
  try { shared = record(JSON.parse(readFileSync(from, 'utf8'))) } catch { return }
  if (!shared) return
  try { own = record(JSON.parse(readFileSync(file, 'utf8'))) ?? {} } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return }
  let base: McpServers | undefined
  try { base = record(JSON.parse(readFileSync(join(home, MCP_BASE), 'utf8'))) as McpServers | undefined } catch { /* none yet */ }
  const merged = { ...shared }
  const servers = mergeServers(record(shared.mcpServers), record(own.mcpServers), record(base?.mcpServers))
  if (!same(servers, record(shared.mcpServers) ?? {})) merged.mcpServers = servers
  const projects = mergeProjects(record(shared.projects), record(own.projects), record(base?.projects) as McpServers['projects'])
  if (!same(projects, record(shared.projects) ?? {})) merged.projects = projects
  if (merged.mcpServers !== shared.mcpServers || merged.projects !== shared.projects) {
    // A `.claude.json` linked from a dotfiles folder stays a link.
    const real = realpathSync(from)
    writeJson(real, merged, statSync(real).mode & 0o777)
  }
  const next = { ...own }
  for (const key of SHARED_KEYS) { if (key in merged) next[key] = merged[key]; else delete next[key] }
  if (!SHARED_KEYS.every((key) => same(next[key], own[key])) || !lstatOf(file)) writeJson(file, next, 0o600)
  const now = serversOf(merged)
  if (!same(now, base)) writeJson(join(home, MCP_BASE), now, 0o600)
}

// ---------- plugins (KERNEL-646)
// Claude Code 2.1.292 writes `plugins/installed_plugins.json` and `plugins/known_marketplaces.json` through a temp file and a
// rename, which puts a file of the account's own where `linkClaudeHome` left a link. From then on a plugin installed,
// updated or removed on the account stayed there, and one on the CLI login never reached it.

/** The plugin files Claude Code replaces, each with where its plugins sit in it: `plugins`, or the whole file. */
const PLUGIN_FILES: { name: string; key?: string }[] = [{ name: 'installed_plugins.json', key: 'plugins' }, { name: 'known_marketplaces.json' }]

/** What the plugin files held after Kernel's last sync of an account, kept in its folder. */
const PLUGINS_BASE = 'kernel-plugins-base.json'

/**
 * Keeps an account's plugins and the CLI login's (`root`, `~/.claude`) one set (KERNEL-646). For each plugin file the account
 * has a file of its own in place of the link: a plugin or marketplace it added, changed or removed since the last sync goes
 * to `~/.claude`, through Claude Code's own locks, unless the CLI login changed that one too, which wins, as MCP servers
 * merge (`mergeServers`). Paths into the account's folder become paths into `~/.claude`, which they reach through the
 * links anyway. Then the file is a link to `~/.claude`'s again, so the CLI login's changes reach the account at once. A
 * file that doesn't parse whole, or a lock a CLI holds, leaves both as they are until the next sync.
 */
export function syncClaudePlugins(home: string, root: string) {
  let base: Record<string, Servers> = {}
  try { base = record(JSON.parse(readFileSync(join(home, PLUGINS_BASE), 'utf8'))) as Record<string, Servers> ?? {} } catch { /* none yet */ }
  let changed = false
  for (const f of PLUGIN_FILES) {
    const own = join(home, 'plugins', f.name)
    const shared = join(root, 'plugins', f.name)
    if (!lstatOf(own)?.isFile()) continue
    mkdirSync(join(root, 'plugins'), { recursive: true })
    const unlockShared = lockConfig(shared)
    if (!unlockShared) continue
    try {
      const unlockOwn = lockConfig(own)
      if (!unlockOwn) continue
      try {
        const merged = mergePluginFile(own, shared, base[f.name], { home, root, key: f.key })
        if (!merged) continue
        base[f.name] = merged
        changed = true
      } finally { unlockOwn() }
    } finally { unlockShared() }
  }
  if (changed) writeJson(join(home, PLUGINS_BASE), base, 0o600)
}

/** One plugin file's merge and link (`syncClaudePlugins`). Returns the plugins both logins now share, or undefined when it left the file as it was. */
function mergePluginFile(own: string, shared: string, base: Servers | undefined, o: { home: string; root: string; key?: string }): Servers | undefined {
  // A path is a JSON string, so its prefix is swapped as JSON writes it.
  const from = JSON.stringify(join(o.home, 'plugins') + '/').slice(1, -1)
  const to = JSON.stringify(join(o.root, 'plugins') + '/').slice(1, -1)
  let mine: Record<string, unknown> | undefined
  let theirs: Record<string, unknown> | undefined
  try { mine = record(JSON.parse(readFileSync(own, 'utf8').split(from).join(to))) } catch { return undefined }
  if (!mine) return undefined
  try { theirs = record(JSON.parse(readFileSync(shared, 'utf8'))) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return undefined }
  const pick = (v: Record<string, unknown> | undefined) => (o.key ? record(v?.[o.key]) : v)
  const plugins = mergeServers(pick(theirs), pick(mine), base)
  if (!theirs || !same(plugins, pick(theirs) ?? {})) {
    const next = o.key ? { ...(theirs ?? mine), [o.key]: plugins } : plugins
    const real = theirs ? realpathSync(shared) : shared
    writeJson(real, next, theirs ? statSync(real).mode & 0o777 : 0o644)
  }
  unlinkSync(own)
  symlinkSync(shared, own)
  return plugins
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
  return { CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ...(home ? accountEnv(home) : {}) }
}

/**
 * What points a Claude process at an added account: its folder as CLAUDE_CONFIG_DIR, and as CLAUDE_SECURESTORAGE_CONFIG_DIR
 * too. Claude Code reads its login from the second when it is set, so one the Mac or a workspace exports would otherwise put
 * every account on a single Keychain item. Naming the folder twice gives the item the folder alone would
 * (feat-make-claude-account-credentials-and).
 */
export function accountEnv(home: string): { CLAUDE_CONFIG_DIR: string; CLAUDE_SECURESTORAGE_CONFIG_DIR: string } {
  return { CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home }
}

/** Who a Claude login is, from `claude auth status`. */
export interface ClaudeLogin {
  signedIn: boolean
  email?: string
  /** As the CLI says it, which the plan defaults read. */
  subscriptionType?: string
  /** "Claude Max". */
  plan?: string
  /** The claude.ai organization it signed in to. One email can have a personal plan and a Team seat (KERNEL-616). */
  orgId?: string
}

/**
 * Reads a login through `bin`: an added account's with `loginEnv(home)`, the CLI's own with no `env`. Undefined when
 * the CLI didn't answer, which says nothing about the sign-in.
 */
export async function claudeStatus(bin: string, env?: NodeJS.ProcessEnv): Promise<ClaudeLogin | undefined> {
  const a = await exec(bin, ['auth', 'status'], { timeoutMs: 15_000, ...(env ? { env } : {}) })
  let s: { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown; orgId?: unknown }
  try { s = JSON.parse(a.stdout) } catch { return undefined }
  if (typeof s?.loggedIn !== 'boolean') return undefined
  if (!s.loggedIn) return { signedIn: false }
  const type = typeof s.subscriptionType === 'string' && s.subscriptionType ? s.subscriptionType : undefined
  return {
    signedIn: true, ...(typeof s.email === 'string' ? { email: s.email } : {}), ...(type ? { subscriptionType: type, plan: planName(type) } : {}),
    ...(typeof s.orgId === 'string' && s.orgId ? { orgId: s.orgId } : {})
  }
}

/** `claude auth logout` for an added account's folder. It removes that folder's Keychain item, and the CLI's own login stays. */
export async function logoutClaude(bin: string, home: string) {
  await exec(bin, ['auth', 'logout'], { timeoutMs: 15_000, env: loginEnv(home) })
}

// ---------- MCP sign-ins (KERNEL-616)
// Claude Code 2.1.292 keeps a login and its MCP servers' OAuth sign-ins in one Keychain item, under `mcpOAuth`, keyed by the
// server's name and a hash of its type, URL and headers. An added login has an item of its own, so it starts with none of
// the CLI login's sign-ins. Logins can't share one item without sharing the login, so Kernel copies the sign-ins instead.

/**
 * The Mac's login Keychain as Claude Code uses it: one generic password per login, filed under the user's name. Synchronous,
 * since Kernel shares the sign-ins right before it starts a Claude process.
 */
export interface Keychain {
  /** The item's secret, or undefined when it has none or can't be read. */
  read(item: string): string | undefined
  /** Writes the item's secret, making the item when there is none. False when it couldn't. */
  write(item: string, secret: string): boolean
  /**
   * Whether the item's secret can be read, without keeping it (KERNEL-618): `ok`, `absent` when there is no item, or `denied`
   * when the read failed or ran past `timeoutMs`, as when macOS asks first and nobody allows it. Async, since the read
   * waits on that prompt. Left out, Kernel can't tell a login waiting on a prompt from a signed-out one.
   */
  access?(item: string, timeoutMs: number): Promise<KeychainAccess>
}

/** What a read of a Keychain item found (`Keychain.access`). */
export type KeychainAccess = 'ok' | 'absent' | 'denied'

/** The code `security` exits with when there is no such item. */
const NO_ITEM = 44

/** The name Claude Code files its items under: $USER, or a stand-in when that has characters it won't use. */
function keychainAccount(): string {
  let name: string
  try { name = process.env.USER || userInfo().username } catch { name = '' }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user'
}

/** How long one `security` call may take. A locked Keychain that asks for its password gives up after this. */
const SECURITY_MS = 5_000

/** The longest line `security -i` reads, which the CLI keeps its writes under. */
const SECURITY_LINE = 4032

/**
 * The real Keychain, through `/usr/bin/security` the way Claude Code reads and writes it, so each item keeps the access list
 * the CLI gave it, which names `/usr/bin/security`, and no prompt shows (KERNEL-618). A secret goes in on stdin, or as an
 * argument when it is too long for `security -i`, as the CLI does. Nothing read or written is logged.
 */
export function macKeychain(account = keychainAccount()): Keychain {
  const run = (args: string[], input?: string) => execFileSync('/usr/bin/security', args, { input, encoding: 'utf8', timeout: SECURITY_MS, stdio: ['pipe', 'pipe', 'ignore'] })
  return {
    read: (item) => { try { return run(['find-generic-password', '-a', account, '-w', '-s', item]).trim() || undefined } catch { return undefined } },
    write: (item, secret) => {
      const hex = Buffer.from(secret, 'utf8').toString('hex')
      const line = `add-generic-password -U -a "${account}" -s "${item}" -X "${hex}"\n`
      try {
        if (line.length <= SECURITY_LINE) run(['-i'], line)
        else run(['add-generic-password', '-U', '-a', account, '-s', item, '-X', hex])
        return true
      } catch { return false }
    },
    // The secret goes nowhere: only whether it could be read counts.
    access: (item, timeoutMs) => new Promise((resolve) => {
      const child = spawn('/usr/bin/security', ['find-generic-password', '-a', account, '-w', '-s', item], { stdio: 'ignore', timeout: timeoutMs })
      child.on('error', () => resolve('denied'))
      child.on('exit', (code) => resolve(code === 0 ? 'ok' : code === NO_ITEM ? 'absent' : 'denied'))
    })
  }
}

/**
 * The Keychain item a Claude process keeps its login and MCP sign-ins in, named from its environment the way Claude Code
 * 2.1.292 names it: `Claude Code-credentials`, with the first 8 hex characters of the sha256 of the folder after a dash when
 * CLAUDE_SECURESTORAGE_CONFIG_DIR, or else CLAUDE_CONFIG_DIR, names one. An empty CLAUDE_SECURESTORAGE_CONFIG_DIR is the
 * plain name (KERNEL-560).
 */
export function credentialsItem(env: { CLAUDE_CONFIG_DIR?: string; CLAUDE_SECURESTORAGE_CONFIG_DIR?: string }): string {
  const store = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const dir = store !== undefined ? store : env.CLAUDE_CONFIG_DIR
  return dir ? `Claude Code-credentials-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}` : 'Claude Code-credentials'
}

/**
 * The folder a login's Keychain item belongs to, where Claude Code 2.1.292 takes its `.storage-write.lock` before it writes
 * the item: CLAUDE_SECURESTORAGE_CONFIG_DIR, `~/.claude` under `userHome` when that is empty, or else the login's own folder.
 */
export function credentialsDir(env: { CLAUDE_CONFIG_DIR?: string; CLAUDE_SECURESTORAGE_CONFIG_DIR?: string }, userHome: string): string {
  const store = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  return (store !== undefined ? store || join(userHome, '.claude') : env.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude')).normalize('NFC')
}

/** A claude.ai connector, by its name: it signs in through the claude.ai account, so each account has its own. */
export const isConnector = (server: string) => server.startsWith('claude.ai ')

/** One MCP server's sign-in as the CLI keeps it. Kernel reads only these fields and copies the rest as it is. */
interface McpToken { serverName?: unknown; accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown }
type Secrets = Record<string, unknown> & { mcpOAuth?: Record<string, McpToken>; mcpOAuthClientConfig?: Record<string, unknown> }

/** A login's item as an object, or undefined when it has none or can't be read whole. */
function secretsOf(secret: string | undefined): Secrets | undefined {
  if (!secret) return undefined
  try {
    const v: unknown = JSON.parse(secret)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Secrets : undefined
  } catch { return undefined }
}

const tokensOf = (s: Secrets): Record<string, McpToken> => (s.mcpOAuth && typeof s.mcpOAuth === 'object' ? s.mcpOAuth : {})
const clientsOf = (s: Secrets): Record<string, unknown> => (s.mcpOAuthClientConfig && typeof s.mcpOAuthClientConfig === 'object' ? s.mcpOAuthClientConfig : {})
const serverOf = (key: string, t: McpToken | undefined) => (typeof t?.serverName === 'string' ? t.serverName : key.split('|')[0])

/**
 * How fresh a sign-in is: -1 without a token, else when its access token expires. A refresh or a new sign-in always moves
 * that later. One with a token but no expiry counts as 0, so any dated one beats it. One that expired with no refresh token
 * to renew it is dead, so it counts as no token (KERNEL-935).
 */
const freshness = (t: McpToken | undefined, now: number) => {
  if (!t || !(t.accessToken || t.refreshToken)) return -1
  if (typeof t.expiresAt !== 'number') return 0
  return t.expiresAt <= now && !t.refreshToken ? -1 : t.expiresAt
}

/** A sign-in whose access token still works by its clock: one with an expiry that hasn't passed. */
const valid = (t: McpToken | undefined, now: number) => !!t?.accessToken && typeof t.expiresAt === 'number' && t.expiresAt > now

/**
 * What Kernel remembers of a copied sign-in Claude Code then rejected (KERNEL-935): a hash of the server's name and the
 * token's expiry, never the token.
 */
export const mcpTokenMark = (server: string, t: { expiresAt?: unknown }) => createHash('sha256').update(`${server}|${String(t.expiresAt)}`).digest('hex')

/**
 * Gives every Claude login the freshest sign-in of each MCP server the user added (KERNEL-616). `logins` is each login's
 * Keychain item with its folder, the CLI's own first, which wins a tie. A sign-in with a token beats one without, and a
 * later expiry beats an earlier one. A login whose own token is still valid keeps it, whatever another login holds: a later
 * expiry elsewhere may be a token the server revoked (KERNEL-935). A token that expired with no refresh token, or one in
 * `rejected` (`mcpTokenMark`), is never copied, and a login holding one counts as holding none. A server's own client
 * secret goes where it is missing. claude.ai connectors stay with their account. An item Kernel can't read whole is left
 * alone, and none is made. An item is written under the lock Claude Code itself takes to write it, `.storage-write.lock`
 * in `store`, the item's folder (`credentialsDir`), `dir` when left out. Inside it the item is read again and only the
 * sign-ins still behind change, so a login Claude Code renews meanwhile is saved after Kernel's write and never under it.
 * A login whose lock a CLI holds is left for the next share (feat-make-claude-account-credentials-and). A server that got a
 * sign-in leaves the login's `mcp-needs-auth-cache.json`, or Claude Code would skip it for up to 15 minutes. Returns the
 * servers each login got, by folder, and `onCopy` hears each copied token's mark. `now` is the clock tokens expire by.
 * Nothing it reads is logged.
 */
export function shareMcpSignIns(
  keychain: Keychain,
  logins: { item: string; dir: string; store?: string }[],
  o: { now?: number; rejected?: ReadonlySet<string>; onCopy?: (dir: string, server: string, mark: string) => void } = {}
): Map<string, string[]> {
  const now = o.now ?? Date.now()
  const rejected = (key: string, t: McpToken) => !!o.rejected?.has(mcpTokenMark(serverOf(key, t), t))
  const rank = (key: string, t: McpToken | undefined) => (t && rejected(key, t) ? -1 : freshness(t, now))
  const got = new Map<string, string[]>()
  const items = new Set<string>()
  const read = logins.filter((l) => !items.has(l.item) && !!items.add(l.item)).flatMap((l) => {
    const secrets = secretsOf(keychain.read(l.item))
    return secrets ? [{ ...l, secrets }] : []
  })
  if (read.length < 2) return got
  const best = new Map<string, McpToken>()
  const clients = new Map<string, unknown>()
  for (const { secrets } of read) {
    for (const [key, t] of Object.entries(tokensOf(secrets))) if (!isConnector(serverOf(key, t)) && rank(key, t) > rank(key, best.get(key))) best.set(key, t)
    for (const [key, c] of Object.entries(clientsOf(secrets))) if (!clients.has(key)) clients.set(key, c)
  }
  const behind = (s: Secrets) => [...best].filter(([key, t]) => {
    const had = tokensOf(s)[key]
    const r = rank(key, had)
    return !(r >= 0 && valid(had, now)) && r < rank(key, t)
  })
  const missing = (s: Secrets) => [...clients].filter(([key]) => !(key in clientsOf(s)))
  for (const login of read) {
    if (!behind(login.secrets).length && !missing(login.secrets).length) continue
    const unlock = lockConfig(join(login.store ?? login.dir, '.storage-write'), STORE_STALE_MS)
    if (!unlock) continue
    let tokens: [string, McpToken][]
    try {
      const now = secretsOf(keychain.read(login.item))
      if (!now) continue
      tokens = behind(now)
      const secrets = missing(now)
      if (!tokens.length && !secrets.length) continue
      const next: Secrets = { ...now, mcpOAuth: { ...tokensOf(now), ...Object.fromEntries(tokens) } }
      if (secrets.length) next.mcpOAuthClientConfig = { ...clientsOf(now), ...Object.fromEntries(secrets) }
      if (!keychain.write(login.item, JSON.stringify(next))) continue
    } finally { unlock() }
    const servers = [...new Set(tokens.map(([key, t]) => serverOf(key, t)))].sort()
    if (!servers.length) continue
    for (const [key, t] of tokens) o.onCopy?.(login.dir, serverOf(key, t), mcpTokenMark(serverOf(key, t), t))
    forgetNeedsAuth(login.dir, servers)
    got.set(login.dir, servers)
  }
  return got
}

/** Takes servers out of a login's needs-auth cache, written whole through a temp file. A cache Kernel can't read stays. */
function forgetNeedsAuth(dir: string, servers: string[]) {
  const file = join(dir, 'mcp-needs-auth-cache.json')
  let cache: unknown
  try { cache = JSON.parse(readFileSync(file, 'utf8')) } catch { return }
  if (!cache || typeof cache !== 'object' || !servers.some((s) => s in cache)) return
  const next = { ...cache as Record<string, unknown> }
  for (const s of servers) delete next[s]
  const tmp = `${file}.${process.pid}.tmp`
  try { writeFileSync(tmp, JSON.stringify(next)); renameSync(tmp, file) } catch { /* Claude Code checks the server again once the entry is old */ }
}

/** The page `claude mcp login` opens: the hyperlink it wraps it in, else the URL after "visit:" or "authorize:". */
export function mcpLoginLink(out: string): string | undefined {
  const linked = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(out)?.[1]
  return linked ?? /(?:visit|authorize):\s*(https:\/\/\S+)/i.exec(plainText(out))?.[1]
}

/**
 * `claude mcp login <server>` in a pty, since the CLI needs a terminal while it waits (KERNEL-616). `env` carries the
 * account's CLAUDE_CONFIG_DIR, so the sign-in lands in that login's item. The CLI opens the page in the browser and `onLink`
 * gets it. `done` resolves when the CLI exits 0, which for a claude.ai connector is as soon as the page is open, and rejects
 * with the CLI's last line when it fails, on Cancel, or after `timeoutMs`.
 */
export function loginMcp(bin: string, server: string, o: { env: Record<string, string>; cwd: string; timeoutMs: number; onLink?: (url: string) => void }): { done: Promise<void>; cancel(): void } {
  const proc = pty.spawn(bin, ['mcp', 'login', server], { name: 'xterm-256color', cols: TOKEN_COLS, rows: 50, cwd: o.cwd, env: { ...o.env, TERM: 'xterm-256color' } })
  let out = ''
  let link: string | undefined
  let settle: { resolve: () => void; reject: (e: Error) => void } | undefined
  const done = new Promise<void>((resolve, reject) => { settle = { resolve, reject } })
  const end = (error?: string) => {
    if (!settle) return
    const s = settle
    settle = undefined
    clearTimeout(timer)
    try { proc.kill() } catch { /* already gone */ }
    if (error) s.reject(new Error(error))
    else s.resolve()
  }
  const timer = setTimeout(() => end('Sign-in took too long, so Kernel stopped waiting.'), o.timeoutMs)
  timer.unref?.()
  proc.onData((data) => {
    out = (out + data).slice(-200_000)
    const url = mcpLoginLink(out)
    if (url && url !== link) { link = url; o.onLink?.(url) }
  })
  proc.onExit(({ exitCode }) => {
    const last = plainText(out).split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean).at(-1)
    end(exitCode === 0 ? undefined : last ? `Claude Code said: ${last}` : 'Claude Code stopped before the sign-in finished.')
  })
  return { done, cancel: () => end('Sign-in canceled.') }
}
