import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { exec } from './exec'
import { loginShell } from './scripts'

const MARK = '__KERNEL_ENV__'
/** PATH as the app was started with. Each refresh builds from this, so repeated checks don't pile up folders. */
const launchPath = process.env.PATH

/**
 * What Kernel takes from the login shell besides PATH (KERNEL-448). Proxies and certificates, so agents, git and gh reach
 * the network the way the terminal does. Claude Code's Bedrock, Vertex and endpoint settings, which only the Mac's own
 * environment may set (KERNEL-247). The Linear token. Opened from Finder, the app has none of them.
 */
export const SHELL_VARS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE',
  'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
  'ANTHROPIC_BASE_URL', 'LINEAR_API_KEY'
] as const

/** gh prefers these over its stored login, so they pass on only when gh has none. */
export const GH_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

const READ: string[] = ['PATH', ...SHELL_VARS, ...GH_TOKENS]
const KEPT: string[] = [...SHELL_VARS, ...GH_TOKENS]
/** The kept names as the app was started with, so a name the shell drops later goes back to this. */
const launchVars = pick(process.env, KEPT)

/** How long startup waits for the login shell. The timeout row in preflight says this number. */
export const SHELL_TIMEOUT_MS = 10_000

/** Where Homebrew, npm, the Claude Code installer and version managers put CLIs. Covers a login shell that can't be read. */
export function commonBins(home = homedir()): string[] {
  return [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'),
    // Version managers add these in .zshrc, so a Finder launch whose shell read failed has no node, python or ruby without them.
    ...nvmBin(home),
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'), join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'), join(home, '.fnm', 'aliases', 'default', 'bin'),
    join(home, '.asdf', 'shims'), join(home, '.local', 'share', 'mise', 'shims'), join(home, '.pyenv', 'shims')
  ]
}

/** nvm has no fixed bin folder, only one per Node version, so this takes the default alias's newest match, else the newest. */
function nvmBin(home: string): string[] {
  const dir = join(home, '.nvm', 'versions', 'node')
  let versions: string[]
  try { versions = readdirSync(dir).filter((v) => /^v\d+\.\d+\.\d+$/.test(v)) } catch { return [] }
  let alias = ''
  // "20", "v20.11.0" or "lts/*". A name nvm resolves itself, like lts/*, falls back to the newest.
  try { alias = readFileSync(join(home, '.nvm', 'alias', 'default'), 'utf8').trim().replace(/^v/, '') } catch { /* no default */ }
  const matching = alias ? versions.filter((v) => v.slice(1) === alias || v.slice(1).startsWith(`${alias}.`)) : []
  const num = (v: string) => v.slice(1).split('.').map(Number)
  const newest = (matching.length ? matching : versions).sort((a, b) => { const x = num(a), y = num(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] })[0]
  return newest ? [join(dir, newest, 'bin')] : []
}

/** Joins PATH strings in order, keeping the first copy of each folder. */
export function mergePath(...paths: (string | null | undefined)[]): string {
  const seen = new Set<string>()
  for (const p of paths) for (const dir of (p ?? '').split(delimiter)) if (dir) seen.add(dir)
  return [...seen].join(delimiter)
}

function pick(env: Record<string, string | undefined>, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of names) if (env[n]) out[n] = env[n]!
  return out
}

/** One printf of `name=value` pairs, NUL-separated since no value can hold a NUL. Only these names leave the shell. */
const COMMAND = `printf '${MARK}'; printf '%s=%s\\0' ${READ.map((n) => `${n} "$${n}"`).join(' ')}; printf '${MARK}'`

/** Reads the variables out of shell output. The markers skip anything the user's rc files print. Empty values count as unset. */
export function parseShellEnv(out: string): Record<string, string> | null {
  const body = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(out)?.[1]
  if (body === undefined) return null
  const vars: Record<string, string> = {}
  for (const pair of body.split('\0')) {
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq)
    if (eq > 0 && READ.includes(name) && pair.length > eq + 1) vars[name] = pair.slice(eq + 1)
  }
  return vars
}

/** What one read of the login shell found. `vars` is null when it couldn't be read; `timedOut` says it was too slow. */
export interface ShellEnv { vars: Record<string, string> | null; timedOut: boolean }

/**
 * PATH and `SHELL_VARS` as the user's terminal sees them: an interactive login shell, so .zprofile and .zshrc both apply.
 * Gives up after `timeoutMs` even if the shell lingers. Something an rc file starts in the background can hold stdout open
 * past the kill, and startup waits on this.
 */
export async function readShell(shell = loginShell(), timeoutMs = SHELL_TIMEOUT_MS): Promise<ShellEnv> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<ShellEnv>((resolve) => { timer = setTimeout(() => resolve({ vars: null, timedOut: true }), timeoutMs + 500) })
  // The shell starts with the names as the app launched, as a new terminal would. Given Kernel's own, a value from an earlier
  // read would come straight back, and a line the user removed from .zshrc would never stop applying.
  const env = Object.fromEntries(KEPT.map((n) => [n, launchVars[n]]))
  const read = exec(shell, ['-ilc', COMMAND], { timeoutMs, env }).then((r): ShellEnv => {
    const vars = parseShellEnv(r.stdout)
    return { vars, timedOut: !vars && !!r.timedOut }
  })
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}

/** What preflight shows about the last shell read. It never holds a variable's value. */
export interface ShellRead {
  shell: string
  timeoutMs: number
  timedOut: boolean
  /** The GitHub token the environment had, by name, and whether Kernel passed it on. */
  ghToken?: { name: (typeof GH_TOKENS)[number]; passed: boolean }
}

/** The startup file to name when the shell read is slow. */
export function rcFile(shell: string): string {
  const name = basename(shell)
  return name === 'zsh' ? '.zshrc' : name === 'bash' ? '.bash_profile' : name === 'fish' ? 'config.fish' : '.profile'
}

/**
 * Opened from Finder or the Dock, the app gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin) and none of the terminal's
 * variables, so `claude`, `gh` and anything from Homebrew or npm is missing, and so is a proxy. This puts the terminal's
 * PATH first, then what the app started with, then the usual install folders. Each name in `SHELL_VARS` takes the shell's
 * value, else the launch value, else is unset. Sessions, Codex and Kernel's own git and gh calls all build from
 * `process.env`, so they all get them. Nothing here logs a value.
 */
export async function refreshPath(shell = loginShell(), o: { timeoutMs?: number; run?: typeof exec } = {}): Promise<ShellRead> {
  const timeoutMs = o.timeoutMs ?? SHELL_TIMEOUT_MS
  const read = await readShell(shell, timeoutMs)
  process.env.PATH = mergePath(read.vars?.PATH, launchPath, commonBins().join(delimiter))
  const vars = { ...launchVars, ...pick(read.vars ?? {}, KEPT) }
  // After PATH, so the check finds the gh the terminal would.
  const ghToken = await keepGhToken(vars, o.run ?? exec)
  for (const name of KEPT) {
    if (vars[name]) process.env[name] = vars[name]
    else delete process.env[name]
  }
  return { shell, timeoutMs, timedOut: read.timedOut, ...(ghToken ? { ghToken } : {}) }
}

/**
 * gh uses GH_TOKEN or GITHUB_TOKEN ahead of its stored login, so a token exported for another tool would change who opens
 * and merges PRs. The token stays only when gh has no stored login, and then it's the only way in (KERNEL-448).
 * `gh auth token` with both cleared answers from the keyring or gh's config alone, without the network. Its output is dropped.
 */
async function keepGhToken(vars: Record<string, string>, run: typeof exec): Promise<ShellRead['ghToken']> {
  const name = GH_TOKENS.find((n) => vars[n])
  if (!name) return undefined
  const stored = (await run('gh', ['auth', 'token', '--hostname', 'github.com'], { env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, timeoutMs: 10_000 })).code === 0
  if (stored) for (const n of GH_TOKENS) delete vars[n]
  return { name, passed: !stored }
}
