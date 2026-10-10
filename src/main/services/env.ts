import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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

/** A room's env files resolved against `dir`, in order. A file that can't be read is missing and gives no variables. */
export function readEnvFiles(dir: string, files: string[]): { path: string; missing: boolean; vars: Record<string, string> }[] {
  return files.map((path) => {
    try {
      const vars = parseEnv(readFileSync(resolve(dir, path), 'utf8')) as Record<string, string>
      return { path, missing: false, vars }
    } catch { return { path, missing: true, vars: {} } }
  })
}

/** Throws unless `name` can be a variable the user sets. */
export function checkName(name: string) {
  if (!ENV_NAME.test(name)) throw new Error(`${name || 'That'} is not a valid variable name. Use letters, digits and _, and don't start with a digit.`)
  if (isKernelVar(name)) throw new Error(`${name} is one of Kernel's own variables. Pick another name.`)
}

/** What `env.json` holds: names in the clear, each value encrypted on its own. `app` is app-wide, `rooms` by room id. */
interface EnvFile { app: Record<string, string>; rooms: Record<string, Record<string, string>> }

const APP = ''

/**
 * App-wide and per-room variables, stored encrypted in `<dataDir>/env.json`. Values are decrypted once into memory, so a
 * session, which starts synchronously, can read them without waiting. With no cipher nothing can be set, so no value is
 * ever written in plain text.
 */
export class EnvStore {
  /** The file as stored, encrypted. */
  private stored: EnvFile | null = null
  /** Decrypted values by scope (`APP` or a room id), filled on first read. */
  private plain = new Map<string, Record<string, string>>()

  constructor(private o: { file: string; cipher?: Cipher }) {}

  private file(): EnvFile {
    if (this.stored) return this.stored
    try {
      const raw = JSON.parse(readFileSync(this.o.file, 'utf8')) as Partial<EnvFile>
      this.stored = { app: raw.app ?? {}, rooms: raw.rooms ?? {} }
    } catch { this.stored = { app: {}, rooms: {} } }
    return this.stored
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
    const value = this.values(roomId)[name]
    if (value === undefined) throw new Error(`Kernel can't read ${name} on this Mac. Set it again.`)
    return value
  }

  /** Sets a variable, or deletes it when `value` is null. */
  set(roomId: string | undefined, name: string, value: string | null) {
    checkName(name)
    const { cipher } = this.o
    if (value !== null && !cipher) throw new Error('Kernel can\'t encrypt values on this Mac, so it won\'t save them.')
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
    mkdirSync(dirname(this.o.file), { recursive: true })
    const tmp = `${this.o.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.file(), null, 2), { mode: 0o600 })
    renameSync(tmp, this.o.file)
  }
}
