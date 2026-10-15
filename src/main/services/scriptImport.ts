import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { isRunName, RUN_SCRIPT_NAME, type ProjectSettings, type ProjectSettingsPatch, type ScriptSuggestion } from '@shared/types'
import { installOf, stacksOf, tildify } from './projects'

// Scripts a project could take from another tool's files, or from its lockfiles (KERNEL-682). Everything here reads. A
// suggestion is saved by `settings.setProject`, like text typed into Settings, Scripts.

/** Conductor's and Superset's variables that Kernel has under another name. Any other `CONDUCTOR_*` or `SUPERSET_*` name has none. */
export const SCRIPT_VARIABLES: Record<string, string> = {
  CONDUCTOR_PORT: 'KERNEL_PORT',
  CONDUCTOR_ROOT_PATH: 'KERNEL_ROOT_PATH',
  SUPERSET_ROOT_PATH: 'KERNEL_ROOT_PATH',
  CONDUCTOR_WORKSPACE_PATH: 'KERNEL_WORKSPACE',
  SUPERSET_WORKSPACE_PATH: 'KERNEL_WORKSPACE',
  CONDUCTOR_WORKSPACE_NAME: 'KERNEL_WORKSPACE_NAME',
  SUPERSET_WORKSPACE_NAME: 'KERNEL_WORKSPACE_NAME',
  CONDUCTOR_DEFAULT_BRANCH: 'KERNEL_DEFAULT_BRANCH'
}

const FOREIGN = '(?:CONDUCTOR|SUPERSET)_[A-Za-z0-9_]*'
/** `$X` and `${X`, with the `#` or `!` a `${` may put before the name. The name runs to its end, so `$CONDUCTOR_PORTAL` is one name. */
const REFERENCE = new RegExp(`(\\$\\{?[#!]?)(${FOREIGN})`, 'g')
/** A name on its own, as shell arithmetic reads one. */
const BARE = new RegExp(`(?<![A-Za-z0-9_])(${FOREIGN})`, 'g')

/** `fn` over each `$(( ... ))` in the script, to its matching close. */
function inArithmetic(script: string, fn: (span: string) => string): string {
  let out = ''
  let from = 0
  for (;;) {
    const at = script.indexOf('$((', from)
    if (at < 0) return out + script.slice(from)
    let end = at + 3
    for (let depth = 2; end < script.length && depth > 0; end++) depth += script[end] === '(' ? 1 : script[end] === ')' ? -1 : 0
    out += script.slice(from, at) + fn(script.slice(at, end))
    from = end
  }
}

/**
 * A script with Conductor's and Superset's variables renamed to Kernel's (`SCRIPT_VARIABLES`), by whole name, where the
 * shell reads one: `$X`, `${X}` and inside `$(( ))`. `renamed` lists the names it renamed, and `unknown` the
 * `CONDUCTOR_*` and `SUPERSET_*` names it read that Kernel has no variable for, which stay as written.
 */
export function convertScriptVariables(script: string): { script: string; unknown: string[]; renamed: string[] } {
  const unknown = new Set<string>()
  const renamed = new Set<string>()
  const rename = (name: string) => (SCRIPT_VARIABLES[name] ? (renamed.add(name), SCRIPT_VARIABLES[name]) : (unknown.add(name), name))
  const referenced = script.replace(REFERENCE, (_, lead: string, name: string) => lead + rename(name))
  return { script: inArithmetic(referenced, (span) => span.replace(BARE, (_, name: string) => rename(name))), unknown: [...unknown].sort(), renamed: [...renamed].sort() }
}

/** The most Kernel reads of another tool's file. A real one is a few kilobytes. */
export const MAX_IMPORT_BYTES = 256 * 1024

/**
 * A file under `root`, read only when it is a regular file whose real path stays inside `root` and it is no bigger than
 * `MAX_IMPORT_BYTES`: a cloned repo can bring a link to any file on the Mac. Undefined when no file is there, null when
 * one is and Kernel won't read it.
 */
async function readInside(root: string, path: string): Promise<string | null | undefined> {
  const gone = (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? undefined : null)
  const base = await realpath(root).catch(gone)
  if (!base) return base
  const real = await realpath(join(base, path)).catch(gone)
  if (!real) return real
  if (!real.startsWith(base + sep)) return null
  const info = await stat(real).catch(() => null)
  if (!info?.isFile() || info.size > MAX_IMPORT_BYTES) return null
  return readFile(real, 'utf8').catch(() => null)
}

type Table = Record<string, unknown>
const isTable = (v: unknown): v is Table => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => text(x) ?? []) : [])

/** A table from TOML or JSON text. Text that doesn't parse, or isn't a table, is null. */
function parsed(body: string, parse: (s: string) => unknown): Table | null {
  try { const doc = parse(body); return isTable(doc) ? doc : null } catch { return null }
}

/** A word for a command line, in double quotes when it needs them, so a `$NAME` in it still fills in. */
const word = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `"${s.replace(/["\\`]/g, '\\$&')}"`)

const inFolder = (cwd: string | undefined, script: string) => (cwd ? `cd ${word(cwd)} && ${script}` : script)

/** What a source's files ask for, in its own variable names. */
interface Found {
  setup?: string
  run?: string
  archive?: string
  runMode?: 'concurrent' | 'single'
  runScripts?: Record<string, string>
  notes?: string[]
}

/** The suggestion for what a source asks for, with Kernel's variable names. None when it asks for no script. */
function suggestion(source: ScriptSuggestion['source'], file: string, found: Found): ScriptSuggestion | undefined {
  const unknown = new Set<string>()
  const kernel = (script: string) => { const c = convertScriptVariables(script); for (const n of c.unknown) unknown.add(n); return c.script }
  const scripts: NonNullable<ProjectSettingsPatch['scripts']> = {}
  for (const k of ['setup', 'run', 'archive'] as const) if (found[k]) scripts[k] = kernel(found[k])
  const runScripts = Object.fromEntries(Object.entries(found.runScripts ?? {}).map(([name, command]) => [name, kernel(command)]))
  if (!Object.keys(scripts).length && !Object.keys(runScripts).length) return undefined
  if (found.runMode) scripts.runMode = found.runMode
  const notes = [...(found.notes ?? []), ...[...unknown].sort().map((n) => `Kernel has no variable for $${n}, so it stays as written.`)]
  return { source, file, patch: { ...(Object.keys(scripts).length ? { scripts } : {}), ...(Object.keys(runScripts).length ? { runScripts } : {}) }, notes }
}

const RUN_MODES: Record<string, Found['runMode']> = { concurrent: 'concurrent', nonconcurrent: 'single' }

/** The command of one `[scripts.run.<id>]` table: `options.cwd` first, then `command`, then `args`. */
function conductorCommand(entry: Table): string | undefined {
  const command = text(entry.command)
  if (!command) return undefined
  const args = typeof entry.args === 'string' ? text(entry.args) : texts(entry.args).map(word).join(' ')
  return inFolder(isTable(entry.options) ? text(entry.options.cwd) : undefined, args ? `${command} ${args}` : command)
}

/**
 * Conductor's run scripts. A string is the one run script. A table holds one per id: the one with `default = true`, or
 * the only one, is the project's `run`, and the rest keep their ids. One with `hide`, or one that runs in the cloud only
 * (`available_in` without `local`), is left out.
 */
function conductorRuns(run: unknown): Pick<Found, 'run' | 'runScripts' | 'notes'> {
  if (!isTable(run)) return { run: text(run) }
  const kept: { id: string; command: string; default: boolean }[] = []
  for (const [id, entry] of Object.entries(run)) {
    if (!isTable(entry) || entry.hide || (Array.isArray(entry.available_in) && !entry.available_in.includes('local'))) continue
    const command = conductorCommand(entry)
    if (command) kept.push({ id, command, default: entry.default === true })
  }
  const main = kept.find((e) => e.default) ?? (kept.length === 1 ? kept[0] : kept.find((e) => isRunName(e.id)))
  const runScripts: Record<string, string> = {}
  const notes: string[] = []
  for (const e of kept) {
    if (e === main) continue
    if (isRunName(e.id) || !RUN_SCRIPT_NAME.test(e.id)) notes.push(`The run script "${e.id}" is left out, because Kernel can't use that name.`)
    else runScripts[e.id] = e.command
  }
  return { run: main?.command, runScripts, notes }
}

/** The patterns in Conductor's `file_include_globs`, one per line or a list. */
const globsOf = (v: unknown) => (typeof v === 'string' ? v.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : texts(v))

/** `.conductor/settings.local.toml` over `.conductor/settings.toml`, key by key and run script by run script. `conductor.json` only when the repo has neither. */
async function fromConductor(repo: string): Promise<ScriptSuggestion | undefined> {
  const files = ['.conductor/settings.local.toml', '.conductor/settings.toml']
  const bodies = await Promise.all(files.map((f) => readInside(repo, f)))
  if (bodies.every((b) => b === undefined)) {
    const body = await readInside(repo, 'conductor.json')
    const doc = body ? parsed(body, JSON.parse) : null
    if (!doc || !isTable(doc.scripts)) return undefined
    const scripts = doc.scripts
    return suggestion('conductor', 'conductor.json', { setup: text(scripts.setup), run: text(scripts.run), archive: text(scripts.archive), runMode: RUN_MODES[String(doc.runScriptMode)] })
  }
  if (bodies.includes(null)) return undefined
  const docs = bodies.map((b) => (b ? parsed(b, parseToml) : {}))
  if (docs.includes(null)) return undefined
  const [local, shared] = docs.map((d) => ({ doc: d!, scripts: isTable(d!.scripts) ? d!.scripts : {} }))
  const scripts: Table = { ...shared.scripts, ...local.scripts }
  if (isTable(shared.scripts.run) && isTable(local.scripts.run)) scripts.run = { ...shared.scripts.run, ...local.scripts.run }
  const runs = conductorRuns(scripts.run)
  const globs = globsOf(local.doc.file_include_globs ?? shared.doc.file_include_globs)
  const notes = [...(runs.notes ?? []), ...(globs.length ? [`Conductor copies ${globs.join(', ')} into each workspace. Add them in Files to copy.`] : [])]
  return suggestion('conductor', files[bodies[0] === undefined ? 1 : 0], { setup: text(scripts.setup), archive: text(scripts.archive), runMode: RUN_MODES[String(scripts.run_mode)], ...runs, notes })
}

const SUPERSET_KEYS = ['setup', 'teardown', 'run'] as const

/**
 * Superset's scripts. The user's own `~/.superset/projects/<repo path>/config.json` goes over the repo's
 * `.superset/config.json`, key by key. `.superset/config.local.json` then changes each list: a list replaces it, and
 * `before` and `after` go around it. A repo with no config at all runs `.superset/setup.sh`, `teardown.sh` and `run.sh`.
 */
async function fromSuperset(repo: string, home: string): Promise<ScriptSuggestion | undefined> {
  const own = join('projects', repo, 'config.json')
  const bodies = [await readInside(repo, '.superset/config.json'), await readInside(join(home, '.superset'), own), await readInside(repo, '.superset/config.local.json')]
  if (bodies.includes(null)) return undefined
  if (bodies.every((b) => b === undefined)) return supersetFiles(repo)
  const docs = bodies.map((b) => (b ? parsed(b, JSON.parse) : {}))
  if (docs.includes(null)) return undefined
  const [shared, user, local] = docs as Table[]
  const config: Table = { ...shared, ...user }
  const lists = Object.fromEntries(SUPERSET_KEYS.map((k) => {
    const change = local[k]
    const list = Array.isArray(change) ? texts(change) : isTable(change) ? [...texts(change.before), ...texts(config[k]), ...texts(change.after)] : texts(config[k])
    return [k, list.length ? inFolder(text(config.cwd), list.join(' && ')) : undefined]
  }))
  const file = bodies[0] !== undefined ? '.superset/config.json' : bodies[1] !== undefined ? tildify(join(home, '.superset', own), home) : '.superset/config.local.json'
  return suggestion('superset', file, { setup: lists.setup, archive: lists.teardown, run: lists.run })
}

/** Superset's script files, each run with bash from the workspace. Kernel can't rename a variable inside one, so a note names each it reads. */
async function supersetFiles(repo: string): Promise<ScriptSuggestion | undefined> {
  const found: Found = { notes: [] }
  let first: string | undefined
  for (const [key, name] of [['setup', 'setup.sh'], ['archive', 'teardown.sh'], ['run', 'run.sh']] as const) {
    const file = `.superset/${name}`
    const body = await readInside(repo, file)
    if (typeof body !== 'string') continue
    found[key] = `bash ${file}`
    first ??= file
    const names = [...new Set([...body.matchAll(REFERENCE)].map((m) => m[2]))].sort()
    if (names.length) found.notes!.push(`${file} reads ${names.map((n) => `$${n}`).join(', ')}, which Kernel doesn't set. Change ${names.length > 1 ? 'them' : 'it'} in the file.`)
  }
  return first ? suggestion('superset', first, found) : undefined
}

/** The install the repo's lockfiles ask for, as a setup script. Kernel guesses no run script. */
async function fromLockfiles(repo: string): Promise<ScriptSuggestion | undefined> {
  const found = await stacksOf(repo)
  return suggestion('detected', found.map((s) => s.file).join(', '), { setup: installOf(found) })
}

/**
 * The suggestion with only what the project doesn't have yet: setup, run, archive, run mode and each named run script the
 * project has stay out, so saving it never replaces one (KERNEL-707). None when no script is left, as a run mode alone runs nothing.
 */
function missingOnly(s: ScriptSuggestion, current: Pick<ProjectSettings, 'scripts' | 'runScripts'>): ScriptSuggestion | undefined {
  const has = (v: unknown) => (typeof v === 'string' ? !!v.trim() : v !== undefined && v !== null)
  const scripts = Object.fromEntries(Object.entries(s.patch.scripts ?? {}).filter(([k]) => !has(current.scripts[k as keyof ProjectSettings['scripts']])))
  const runScripts = Object.fromEntries(Object.entries(s.patch.runScripts ?? {}).filter(([name]) => !current.runScripts.some((r) => r.name === name)))
  if (!Object.keys(scripts).some((k) => k !== 'runMode') && !Object.keys(runScripts).length) return undefined
  return { ...s, patch: { ...(Object.keys(scripts).length ? { scripts } : {}), ...(Object.keys(runScripts).length ? { runScripts } : {}) } }
}

/**
 * The scripts a project could take: Conductor's, Superset's, then the lockfiles' install. A source whose file is missing,
 * unreadable or broken offers nothing and raises nothing. Each offers only the scripts the project (`current`) doesn't
 * have, and one with none left is left out. Nothing is written.
 */
export async function suggestScripts(repo: string, current: Pick<ProjectSettings, 'scripts' | 'runScripts'>, home = homedir()): Promise<ScriptSuggestion[]> {
  const found = await Promise.all([fromConductor(repo), fromSuperset(repo, home), fromLockfiles(repo)].map((p) => p.catch(() => undefined)))
  return found.flatMap((s) => (s && missingOnly(s, current)) || [])
}
