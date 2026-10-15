import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import type { ProductionHint } from '@shared/types'
import { ENV_NAME, isClaudeVar, isKernelVar, KERNEL_VARS, workspaceSlug, type KernelVar } from '@shared/kernelVars'

/**
 * Turns a value into text that is safe to write to disk and back. The app passes Electron's `safeStorage`, which uses the
 * Keychain. Tests pass a fake, since `safeStorage` doesn't work under ELECTRON_RUN_AS_NODE.
 */
export interface Cipher {
  encrypt(text: string): string
  decrypt(data: string): string
}

/**
 * `${KERNEL_PORT}`, `${KERNEL_WORKSPACE_SLUG}` and Kernel's other names in a value, filled in from `kernel`. Only the braced
 * form of Kernel's own names: `$NAME`, any other variable and commands stay as written, so a value can't read the Mac's
 * environment or run anything (KERNEL-449).
 */
export const expandKernelVars = (value: string, kernel: Record<string, string>): string =>
  value.replace(/\$\{(KERNEL_[A-Z_]+)\}/g, (all, name: string) => (Object.hasOwn(KERNEL_VARS, name) && Object.hasOwn(kernel, name) ? kernel[name] : all))

/**
 * The Mac's environment without what a parent Kernel gave it. Kernel runs inside a Kernel workspace while it is developed,
 * and then its environment holds that workspace's `KERNEL_*` names and every value made from its slug, like
 * `COMPOSE_PROJECT_NAME=kernel_<parent>` or a database URL ending in it. Those belong to the parent workspace, so they are
 * dropped, and the child's own defaults and filled-in values win. A slug is `kernel_` and 12 letters and digits, so a value
 * the user set themselves doesn't hold one by chance (KERNEL-710).
 */
function ownBase(base: NodeJS.ProcessEnv): Record<string, string> {
  const parent = base.KERNEL_WORKSPACE_SLUG
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !isKernelVar(k) && !(parent && v.includes(parent))) out[k] = v
  return out
}

/**
 * Every variable a process in a workspace gets, where a later layer wins: Kernel's defaults, the Mac's environment, the
 * app's variables, the project's env files in list order, the project's variables, what the workspace's setup wrote to
 * `$KERNEL_ENV` (KERNEL-405), then Kernel's own (KERNEL-247). A default is what Kernel picks unless the user sets the name,
 * like `COMPOSE_PROJECT_NAME`. Values the user wrote get `${KERNEL_*}` filled in (KERNEL-449). The Mac's are left alone.
 */
export function buildEnv(l: {
  base: NodeJS.ProcessEnv
  defaults?: Record<string, string>
  app?: Record<string, string>
  files?: Record<string, string>[]
  project?: Record<string, string>
  setup?: Record<string, string>
  kernel: Record<string, string>
}): Record<string, string> {
  const out: Record<string, string> = { ...l.defaults }
  for (const [k, v] of Object.entries(ownBase(l.base))) out[k] = v
  for (const layer of [l.app ?? {}, ...(l.files ?? []), l.project ?? {}, l.setup ?? {}]) for (const [k, v] of Object.entries(layer)) out[k] = expandKernelVars(v, l.kernel)
  return Object.assign(out, l.kernel)
}

/** Kernel's own variables for a workspace. The same set for sessions, scripts and terminals. */
export const kernelVars = (ws: { id: string; name: string; path: string; port: number; branch: string; baseRef: string }, project: { path: string; defaultBranch?: string } | undefined): Record<KernelVar, string> => ({
  KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE_ID: ws.id, KERNEL_WORKSPACE: ws.path, KERNEL_ROOT_PATH: project?.path ?? ws.path,
  KERNEL_WORKSPACE_NAME: ws.name, KERNEL_WORKSPACE_SLUG: workspaceSlug(ws), KERNEL_BRANCH: ws.branch, KERNEL_BASE_REF: ws.baseRef, KERNEL_DEFAULT_BRANCH: project?.defaultBranch ?? ''
})

/** The file a workspace's setup writes NAME=value lines to, `$KERNEL_ENV` (KERNEL-405). Kept on archive, removed on Delete. */
export const setupEnvPath = (dataDir: string, workspaceId: string) => join(dataDir, 'setup-env', `${workspaceId}.env`)

/** The most a setup's `$KERNEL_ENV` file may hold. A bigger file gives nothing. */
export const MAX_SETUP_ENV = 64 * 1024

/** Empties the workspace's `$KERNEL_ENV` file before setup runs, so a run starts from nothing. Returns its path. */
export function resetSetupEnv(dataDir: string, workspaceId: string): string {
  const file = setupEnvPath(dataDir, workspaceId)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '', { mode: 0o600 })
  return file
}

/**
 * What setup wrote to `$KERNEL_ENV`: the names Kernel passes on, and the ones it drops because they aren't valid names or are
 * Kernel's own. Nothing for a missing, odd or oversized file.
 */
export function readSetupEnv(file: string): { vars: Record<string, string>; dropped: string[] } {
  let fd: number
  try { fd = openSync(file, OPEN_FLAGS) } catch { return { vars: {}, dropped: [] } }
  let text: string
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_SETUP_ENV) return { vars: {}, dropped: [] }
    const buf = Buffer.alloc(st.size)
    text = buf.subarray(0, readSync(fd, buf, 0, st.size, 0)).toString('utf8')
  } catch { return { vars: {}, dropped: [] } } finally { closeSync(fd) }
  const vars: Record<string, string> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(parseEnv(text) as Record<string, string>)) {
    if (!ENV_NAME.test(k) || OBJECT_NAMES.has(k) || isKernelVar(k)) dropped.push(k)
    else vars[k] = v
  }
  return { vars, dropped }
}

/**
 * A layer without the names `isClaudeVar` matches: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`,
 * `CLAUDE_CODE_OAUTH_TOKEN` and the rest. Sessions and terminals take them from the Mac only, never from Kernel's
 * variables or a project's env files, so a project's `.env` can't send the plan's login to a proxy (KERNEL-247).
 */
export const withoutClaudeNames = (layer: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(layer).filter(([k]) => !isClaudeVar(k)))

/** The largest env file Kernel reads. A bigger one counts as missing. */
export const MAX_ENV_FILE = 1024 * 1024

const inside = (root: string, file: string) => {
  const r = relative(root, file)
  return !!r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)
}

/**
 * The env file's real path when Kernel may read it, else null. It must sit inside `dir` once links are followed, so an
 * absolute path, `..` or a link out of the folder is refused: a project's settings can come from a repo nobody trusted yet,
 * and they mustn't read the rest of the Mac into a session (KERNEL-209). A link that stays inside is fine.
 */
function envFilePath(dir: string, path: string): string | null {
  if (isAbsolute(path)) return null
  try {
    const real = realpathSync(resolve(dir, path))
    return inside(realpathSync(dir), real) ? real : null
  } catch { return null }
}

/**
 * How an env file is opened: never blocking on a FIFO, and never through a link, so a file swapped for a link between
 * `realpathSync` and the open fails instead of reading where the link points.
 */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW

/**
 * The file's text when it is a regular file of at most `MAX_ENV_FILE` bytes, else null. It opens without blocking and
 * checks what it opened, so a FIFO or a device never stalls the main process, which reads this synchronously.
 */
function readSmallFile(real: string): string | null {
  let fd: number
  try { fd = openSync(real, OPEN_FLAGS) } catch { return null }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_ENV_FILE) return null
    const buf = Buffer.alloc(st.size)
    const n = readSync(fd, buf, 0, st.size, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch { return null } finally { closeSync(fd) }
}

/** Whether Kernel would read the env file: inside `dir`, regular and small enough. It reads nothing. */
export function envFileReadable(dir: string, path: string): boolean {
  const real = envFilePath(dir, path)
  if (!real) return false
  try {
    const fd = openSync(real, OPEN_FLAGS)
    try { const st = fstatSync(fd); return st.isFile() && st.size <= MAX_ENV_FILE } finally { closeSync(fd) }
  } catch { return false }
}

/** A project's env files resolved against `dir`, in order. A file Kernel can't or won't read is missing and gives no variables. */
export function readEnvFiles(dir: string, files: string[]): { path: string; missing: boolean; vars: Record<string, string> }[] {
  return files.map((path) => {
    const real = envFilePath(dir, path)
    const text = real ? readSmallFile(real) : null
    return text === null ? { path, missing: true, vars: {} } : { path, missing: false, vars: parseEnv(text) as Record<string, string> }
  })
}

/**
 * The env file a project's agents, scripts and terminals read when neither settings file sets `[env] files`: the user's own
 * file for Kernel, next to the `.env` they keep for themselves (KERNEL-449).
 */
export const ENV_KERNEL = '.env.kernel'

/**
 * Whether git tracks `name` in `repo`, by the index and without case, the way a case-insensitive disk reads it. Synchronous,
 * for `envFor`, which only asks when the file changed. A folder with no `.git` tracks nothing. A git error counts as
 * tracked, so the file waits like the repo's.
 */
export function trackedSync(repo: string, name: string): boolean {
  if (!existsSync(join(repo, '.git'))) return false
  const r = spawnSync('git', ['-C', repo, 'ls-files', '-z', '--', `:(icase)${name}`], { encoding: 'utf8', timeout: 3000 })
  return r.status !== 0 || !!r.stdout
}

/** A file's identity and last change, to tell when it changed: inode, size and mtime. Null when Kernel wouldn't read it. */
export function fileStamp(dir: string, path: string): string | null {
  const real = envFilePath(dir, path)
  if (!real) return null
  try {
    const st = statSync(real)
    return st.isFile() && st.size <= MAX_ENV_FILE ? `${st.ino}:${st.size}:${st.mtimeMs}` : null
  } catch { return null }
}

const LIVE_KEY = /^(sk|rk)_live_/
const DB_SCHEMES = new Set(['postgres', 'postgresql', 'mysql', 'mysql2', 'mariadb', 'mongodb', 'mongodb+srv', 'redis', 'rediss', 'sqlserver', 'mssql', 'cockroachdb', 'libsql', 'prisma', 'prisma+postgres'])
const ENV_NAMES = /^(.+_)?ENV(IRONMENT)?$/i
const PRODUCTION = new Set(['production', 'prod', 'live'])

/** A host on this Mac or its own network: loopback, a private address, `.local`, or one word like a Compose service's `db`. */
function localHost(host: string): boolean {
  const h = host.toLowerCase()
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === 'host.docker.internal') return true
  if (isIP(h) === 4) return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$)/.test(h)
  if (isIP(h) === 6) return h === '::1' || h === '::' || /^(f[cd]|fe80:)/.test(h)
  return !h.includes('.')
}

/** The hosts in a URL's authority, after any user and password: `a:1,b:2` names two. */
const hostsOf = (authority: string) => authority.slice(authority.lastIndexOf('@') + 1).split(',').map((h) => (h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d*$/, '')))

/**
 * The hosts a database URL names, or null when the value isn't one. A password may hold `/`, `?` or `#` unescaped, so the
 * host is read both ways, up to the first of those and after the last `@`, and each counts.
 */
function databaseHosts(value: string): string[] | null {
  const m = /^(?:jdbc:)?([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(value.trim())
  if (!m || !DB_SCHEMES.has(m[1].toLowerCase())) return null
  const rest = m[2]
  const plain = rest.split(/[/?#]/)[0]
  const afterAt = rest.slice(rest.lastIndexOf('@') + 1).split(/[/?#]/)[0]
  return [...new Set([...hostsOf(plain), ...hostsOf(afterAt)])]
}

/** Why a variable looks like production, or nothing. Reads the value and never returns it (KERNEL-449). */
export function productionWhy(name: string, value: string): ProductionHint['why'] | undefined {
  const v = value.trim()
  if (LIVE_KEY.test(v)) return 'live-key'
  const hosts = databaseHosts(v)
  if (hosts?.some((h) => !localHost(h))) return 'remote-database'
  if (ENV_NAMES.test(name) && PRODUCTION.has(v.toLowerCase())) return 'production'
  return undefined
}

/** How strongly each reason says production, first first. */
const WHY_ORDER: ProductionHint['why'][] = ['live-key', 'remote-database', 'production']

/** Each variable in an env file's text that looks like production, the strongest reasons first, then in file order. */
export function productionHints(path: string, text: string): ProductionHint[] {
  let vars: Record<string, string>
  try { vars = parseEnv(text) as Record<string, string> } catch { return [] }
  const hints = Object.entries(vars).flatMap(([name, value]) => { const why = productionWhy(name, value); return why ? [{ path, name, why }] : [] })
  return hints.sort((a, b) => WHY_ORDER.indexOf(a.why) - WHY_ORDER.indexOf(b.why))
}

/** Names a plain object can't hold as its own, so a variable with one would be saved as nothing. */
const OBJECT_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** Throws unless `name` can be a variable the user sets. */
export function checkName(name: string) {
  if (!ENV_NAME.test(name) || OBJECT_NAMES.has(name)) throw new Error(`${name || 'That'} is not a valid variable name. Use letters, digits and _, and don't start with a digit.`)
  if (isKernelVar(name)) throw new Error(`${name} is one of Kernel's own variables. Pick another name.`)
}

/**
 * What `env.json` holds: names in the clear, each value encrypted on its own. `app` is app-wide, `projects` by project id.
 * The file names `projects` `rooms`, as it did before rooms were renamed projects (KERNEL-880), so saved variables stay.
 */
interface EnvFile { app: Record<string, string>; projects: Record<string, Record<string, string>> }

const APP = ''

const NO_CIPHER = 'Kernel can\'t encrypt or decrypt variables on this Mac, because the Keychain isn\'t available to it.'

const isStrings = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')

/** The file's contents when they have the right shape, else null. */
function envFileOf(raw: unknown): EnvFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { app = {}, rooms: projects = {} } = raw as Record<string, unknown>
  if (!isStrings(app) || !projects || typeof projects !== 'object' || Array.isArray(projects) || !Object.values(projects).every(isStrings)) return null
  return { app, projects: projects as EnvFile['projects'] }
}

/**
 * App-wide and per-project variables, stored encrypted in `<dataDir>/env.json`. Values are decrypted once into memory, so a
 * session, which starts synchronously, can read them without waiting. With no cipher nothing can be set, so no value is
 * ever written in plain text. A file Kernel can't read is moved aside, never written over.
 */
export class EnvStore {
  /** The file as stored, encrypted. */
  private stored: EnvFile | null = null
  /** Decrypted values by scope (`APP` or a project id), filled on first read. */
  private plain = new Map<string, Record<string, string>>()
  /**
   * Set while the file exists but can't be read (EACCES, EMFILE), or couldn't be moved aside. Nothing is saved over it,
   * and the next call tries again.
   */
  private stuck = false

  constructor(private o: { file: string; cipher?: Cipher; onSetAside?: (file: string) => void }) {}

  private file(): EnvFile {
    if (this.stored) return this.stored
    let text: string
    try { text = readFileSync(this.o.file, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { this.stuck = false; return (this.stored = { app: {}, projects: {} }) }
      // The file may be fine and only unreadable for now. It stays where it is, nothing is cached, and saves refuse.
      this.stuck = true
      return { app: {}, projects: {} }
    }
    this.stuck = false
    let parsed: EnvFile | null = null
    try { parsed = envFileOf(JSON.parse(text)) } catch { /* not JSON */ }
    if (!parsed) this.setAside()
    return (this.stored = parsed ?? { app: {}, projects: {} })
  }

  /** Moves an unreadable `env.json` to `env.json.corrupt-<time>`. It holds only names and ciphertext, so keeping it is safe. */
  private setAside() {
    const to = `${this.o.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try { renameSync(this.o.file, to) } catch { this.stuck = true; return }
    this.o.onSetAside?.(basename(to))
  }

  private scope(projectId?: string): Record<string, string> {
    const f = this.file()
    return projectId ? f.projects[projectId] ?? {} : f.app
  }

  /** The variables' names, sorted. */
  names(projectId?: string): string[] { return Object.keys(this.scope(projectId)).sort() }

  /** The decrypted values. A value the cipher can't read (a new Keychain, say) is left out. */
  values(projectId?: string): Record<string, string> {
    const key = projectId ?? APP
    const cached = this.plain.get(key)
    if (cached) return cached
    const out: Record<string, string> = {}
    const { cipher } = this.o
    if (cipher) for (const [name, data] of Object.entries(this.scope(projectId))) { try { out[name] = cipher.decrypt(data) } catch { /* unreadable */ } }
    if (!this.stuck) this.plain.set(key, out)
    return out
  }

  reveal(projectId: string | undefined, name: string): string {
    if (!Object.hasOwn(this.scope(projectId), name)) throw new Error(`There is no variable named ${name}.`)
    if (!this.o.cipher) throw new Error(NO_CIPHER)
    const value = this.values(projectId)[name]
    if (value === undefined) throw new Error(`Kernel can't decrypt ${name} on this Mac. Set it again.`)
    return value
  }

  /** Sets a variable, or deletes it when `value` is null. */
  set(projectId: string | undefined, name: string, value: string | null) {
    checkName(name)
    const { cipher } = this.o
    if (value !== null && !cipher) throw new Error(`${NO_CIPHER} So it won't save them.`)
    const f = this.writable()
    const scope = projectId ? (f.projects[projectId] ??= {}) : f.app
    const plain = this.values(projectId)
    if (value === null) { delete scope[name]; delete plain[name] }
    else { scope[name] = cipher!.encrypt(value); plain[name] = value }
    if (projectId && !Object.keys(scope).length) delete f.projects[projectId]
    this.save(f)
  }

  /** A removed project takes its variables with it. */
  dropProject(projectId: string) {
    this.plain.delete(projectId)
    if (!this.file().projects[projectId]) return
    const f = this.writable()
    delete f.projects[projectId]
    this.save(f)
  }

  /** The file to change, or a throw while it can't be read, so nothing is written over it. */
  private writable(): EnvFile {
    const f = this.file()
    if (this.stuck) throw new Error(`Kernel can't read ${basename(this.o.file)} in its data folder, so it won't write over it. Check the file's permissions, or move it away, and try again.`)
    return f
  }

  private save(f: EnvFile) {
    mkdirSync(dirname(this.o.file), { recursive: true })
    const tmp = `${this.o.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ app: f.app, rooms: f.projects }, null, 2), { mode: 0o600 })
    // A temp file a crash left behind keeps its old mode through writeFileSync, and the rename would carry it over.
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.o.file)
  }
}
