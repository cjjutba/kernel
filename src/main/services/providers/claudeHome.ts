import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
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
}

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
 * the CLI gave it and no prompt shows. A secret goes in on stdin, or as an argument when it is too long for `security -i`,
 * as the CLI does. Nothing read or written is logged.
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
    }
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
 * that later. One with a token but no expiry counts as 0, so any dated one beats it.
 */
const freshness = (t: McpToken | undefined) => (!t || !(t.accessToken || t.refreshToken) ? -1 : typeof t.expiresAt === 'number' ? t.expiresAt : 0)

/**
 * Gives every Claude login the freshest sign-in of each MCP server the user added (KERNEL-616). `logins` is each login's
 * Keychain item with its folder, the CLI's own first, which wins a tie. A sign-in with a token beats one without, and a
 * later expiry beats an earlier one, so a token one login refreshes reaches the others, both ways, before the old one stops
 * working where the server swaps refresh tokens. A server's own client secret goes where it is missing. claude.ai
 * connectors stay with their account. An item Kernel can't read whole is left alone, and none is made. Each item is read
 * again right before it is written, and only the sign-ins still behind change, so the login and anything the CLI wrote
 * meanwhile stay. A server that got a sign-in leaves the login's `mcp-needs-auth-cache.json`, or Claude Code would skip it
 * for up to 15 minutes. Returns the servers each login got, by folder. Nothing it reads is logged.
 */
export function shareMcpSignIns(keychain: Keychain, logins: { item: string; dir: string }[]): Map<string, string[]> {
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
    for (const [key, t] of Object.entries(tokensOf(secrets))) if (!isConnector(serverOf(key, t)) && freshness(t) > freshness(best.get(key))) best.set(key, t)
    for (const [key, c] of Object.entries(clientsOf(secrets))) if (!clients.has(key)) clients.set(key, c)
  }
  const behind = (s: Secrets) => [...best].filter(([key, t]) => freshness(tokensOf(s)[key]) < freshness(t))
  const missing = (s: Secrets) => [...clients].filter(([key]) => !(key in clientsOf(s)))
  for (const login of read) {
    if (!behind(login.secrets).length && !missing(login.secrets).length) continue
    const now = secretsOf(keychain.read(login.item))
    if (!now) continue
    const tokens = behind(now)
    const secrets = missing(now)
    if (!tokens.length && !secrets.length) continue
    const next: Secrets = { ...now, mcpOAuth: { ...tokensOf(now), ...Object.fromEntries(tokens) } }
    if (secrets.length) next.mcpOAuthClientConfig = { ...clientsOf(now), ...Object.fromEntries(secrets) }
    if (!keychain.write(login.item, JSON.stringify(next))) continue
    const servers = [...new Set(tokens.map(([key, t]) => serverOf(key, t)))].sort()
    if (!servers.length) continue
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
