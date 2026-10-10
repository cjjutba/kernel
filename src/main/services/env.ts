import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { ENV_NAME, isKernelVar, type KernelVar } from '@shared/kernelVars'

/**
 * Turns a value into text that is safe to write to disk and back. The app passes Electron's `safeStorage`, which uses the
 * Keychain. Tests pass a fake, since `safeStorage` doesn't work under ELECTRON_RUN_AS_NODE.
 */
export interface Cipher {
  encrypt(text: string): string
  decrypt(data: string): string
}

/**
 * Every variable a process in a workspace gets, where a later layer wins: the Mac's environment, the app's variables, the
 * room's env files in list order, the room's variables, then Kernel's own (KERNEL-247).
 */
export function buildEnv(l: {
  base: NodeJS.ProcessEnv
  app?: Record<string, string>
  files?: Record<string, string>[]
  room?: Record<string, string>
  kernel: Record<string, string>
}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(l.base)) if (v !== undefined) out[k] = v
  for (const layer of [l.app ?? {}, ...(l.files ?? []), l.room ?? {}, l.kernel]) Object.assign(out, layer)
  return out
}

/** Kernel's own variables for a workspace. The same set for sessions, scripts and terminals. */
export const kernelVars = (ws: { id: string; path: string; port: number }, root: string): Record<KernelVar, string> =>
  ({ KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE_ID: ws.id, KERNEL_WORKSPACE: ws.path, KERNEL_ROOT_PATH: root })

/**
 * Names that pick Claude Code's endpoint, account or billing: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`,
 * `CLAUDE_CODE_OAUTH_TOKEN` and the rest. Sessions and terminals take them from the Mac only, never from Kernel's
 * variables or a room's env files, so a project's `.env` can't send the plan's login to a proxy (KERNEL-247).
 */
export const CLAUDE_NAME = /^(ANTHROPIC_|CLAUDE_CODE_)/

/** A layer without the names `CLAUDE_NAME` matches. */
export const withoutClaudeNames = (layer: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(layer).filter(([k]) => !CLAUDE_NAME.test(k)))

/** The largest env file Kernel reads. A bigger one counts as missing. */
export const MAX_ENV_FILE = 1024 * 1024

const inside = (root: string, file: string) => {
  const r = relative(root, file)
  return !!r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)
}

/**
 * The env file's real path when Kernel may read it, else null. It must sit inside `dir` once links are followed, so an
 * absolute path, `..` or a link out of the folder is refused: a room's settings can come from a repo nobody trusted yet,
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
 * The file's text when it is a regular file of at most `MAX_ENV_FILE` bytes, else null. It opens without blocking and
 * checks what it opened, so a FIFO or a device never stalls the main process, which reads this synchronously.
 */
function readSmallFile(real: string): string | null {
  let fd: number
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK) } catch { return null }
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
    const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK)
    try { const st = fstatSync(fd); return st.isFile() && st.size <= MAX_ENV_FILE } finally { closeSync(fd) }
  } catch { return false }
}

/** A room's env files resolved against `dir`, in order. A file Kernel can't or won't read is missing and gives no variables. */
export function readEnvFiles(dir: string, files: string[]): { path: string; missing: boolean; vars: Record<string, string> }[] {
  return files.map((path) => {
    const real = envFilePath(dir, path)
    const text = real ? readSmallFile(real) : null
    return text === null ? { path, missing: true, vars: {} } : { path, missing: false, vars: parseEnv(text) as Record<string, string> }
  })
}

/** Names a plain object can't hold as its own, so a variable with one would be saved as nothing. */
const OBJECT_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** Throws unless `name` can be a variable the user sets. */
export function checkName(name: string) {
  if (!ENV_NAME.test(name) || OBJECT_NAMES.has(name)) throw new Error(`${name || 'That'} is not a valid variable name. Use letters, digits and _, and don't start with a digit.`)
  if (isKernelVar(name)) throw new Error(`${name} is one of Kernel's own variables. Pick another name.`)
}

/** What `env.json` holds: names in the clear, each value encrypted on its own. `app` is app-wide, `rooms` by room id. */
interface EnvFile { app: Record<string, string>; rooms: Record<string, Record<string, string>> }

const APP = ''

const NO_CIPHER = 'Kernel can\'t encrypt or decrypt variables on this Mac, because the Keychain isn\'t available to it.'

const isStrings = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')

/** The file's contents when they have the right shape, else null. */
function envFileOf(raw: unknown): EnvFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { app = {}, rooms = {} } = raw as Record<string, unknown>
  if (!isStrings(app) || !rooms || typeof rooms !== 'object' || Array.isArray(rooms) || !Object.values(rooms).every(isStrings)) return null
  return { app, rooms: rooms as EnvFile['rooms'] }
}

/**
 * App-wide and per-room variables, stored encrypted in `<dataDir>/env.json`. Values are decrypted once into memory, so a
 * session, which starts synchronously, can read them without waiting. With no cipher nothing can be set, so no value is
 * ever written in plain text. A file Kernel can't read is moved aside, never written over.
 */
export class EnvStore {
  /** The file as stored, encrypted. */
  private stored: EnvFile | null = null
  /** Decrypted values by scope (`APP` or a room id), filled on first read. */
  private plain = new Map<string, Record<string, string>>()
  /** Set when an unreadable file couldn't be moved aside, so nothing is saved over it. */
  private stuck = false

  constructor(private o: { file: string; cipher?: Cipher; onSetAside?: (file: string) => void }) {}

  private file(): EnvFile {
    if (this.stored) return this.stored
    this.stored = { app: {}, rooms: {} }
    let text: string
    try { text = readFileSync(this.o.file, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.stored
      this.setAside()
      return this.stored
    }
    let parsed: EnvFile | null = null
    try { parsed = envFileOf(JSON.parse(text)) } catch { /* not JSON */ }
    if (parsed) this.stored = parsed
    else this.setAside()
    return this.stored
  }

  /** Moves an unreadable `env.json` to `env.json.corrupt-<time>`. It holds only names and ciphertext, so keeping it is safe. */
  private setAside() {
    const to = `${this.o.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try { renameSync(this.o.file, to) } catch { this.stuck = true; return }
    this.o.onSetAside?.(basename(to))
  }

  private scope(roomId?: string): Record<string, string> {
    const f = this.file()
    return roomId ? f.rooms[roomId] ?? {} : f.app
  }

  /** The variables' names, sorted. */
  names(roomId?: string): string[] { return Object.keys(this.scope(roomId)).sort() }

  /** The decrypted values. A value the cipher can't read (a new Keychain, say) is left out. */
  values(roomId?: string): Record<string, string> {
    const key = roomId ?? APP
    const cached = this.plain.get(key)
    if (cached) return cached
    const out: Record<string, string> = {}
    const { cipher } = this.o
    if (cipher) for (const [name, data] of Object.entries(this.scope(roomId))) { try { out[name] = cipher.decrypt(data) } catch { /* unreadable */ } }
    this.plain.set(key, out)
    return out
  }

  reveal(roomId: string | undefined, name: string): string {
    if (!Object.hasOwn(this.scope(roomId), name)) throw new Error(`There is no variable named ${name}.`)
    if (!this.o.cipher) throw new Error(NO_CIPHER)
    const value = this.values(roomId)[name]
    if (value === undefined) throw new Error(`Kernel can't decrypt ${name} on this Mac. Set it again.`)
    return value
  }

  /** Sets a variable, or deletes it when `value` is null. */
  set(roomId: string | undefined, name: string, value: string | null) {
    checkName(name)
    const { cipher } = this.o
    if (value !== null && !cipher) throw new Error(`${NO_CIPHER} So it won't save them.`)
    const f = this.file()
    const scope = roomId ? (f.rooms[roomId] ??= {}) : f.app
    const plain = this.values(roomId)
    if (value === null) { delete scope[name]; delete plain[name] }
    else { scope[name] = cipher!.encrypt(value); plain[name] = value }
    if (roomId && !Object.keys(scope).length) delete f.rooms[roomId]
    this.save()
  }

  /** A removed room takes its variables with it. */
  dropRoom(roomId: string) {
    const f = this.file()
    this.plain.delete(roomId)
    if (!f.rooms[roomId]) return
    delete f.rooms[roomId]
    this.save()
  }

  private save() {
    if (this.stuck && existsSync(this.o.file)) throw new Error(`Kernel can't read ${basename(this.o.file)} in its data folder, so it won't write over it. Move the file away and try again.`)
    this.stuck = false
    mkdirSync(dirname(this.o.file), { recursive: true })
    const tmp = `${this.o.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.file(), null, 2), { mode: 0o600 })
    // A temp file a crash left behind keeps its old mode through writeFileSync, and the rename would carry it over.
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.o.file)
  }
}
