import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ChangedFile, FileEntry, ResolvedFile, ResolvedPath, Skill } from '@shared/types'
import { maskSecrets } from '@shared/toolView'
import { EXEC_TIMEOUT_MS, exec, git } from './exec'
import { PLANS_DIR } from './plans'

const MAX_ENTRIES = 5000
export const MAX_FILE_BYTES = 1024 * 1024

/**
 * The All files tree: every tracked file and every untracked file git does not ignore, plus the directories above them.
 * Files in `changed` carry their change status. Directories first, then files, each sorted by name.
 */
export async function listTree(root: string, changed: ChangedFile[] = []): Promise<FileEntry[]> {
  const out = await git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
  const files = [...new Set(out.split('\0').filter(Boolean))].slice(0, MAX_ENTRIES)
  const status = new Map(changed.map((c) => [c.path, c.status]))
  const entries = new Map<string, FileEntry>()
  for (const file of files) {
    const parts = file.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!entries.has(dir)) entries.set(dir, { path: dir, dir: true })
    }
    entries.set(file, { path: file, dir: false, ...(status.has(file) ? { status: status.get(file) } : {}) })
  }
  return [...entries.values()].sort(compare)
}

/** Siblings sort directories first. Walking path segments keeps a directory next to its own children. */
function compare(a: FileEntry, b: FileEntry): number {
  const x = a.path.split('/'), y = b.path.split('/')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    const aDir = i < x.length - 1 || a.dir, bDir = i < y.length - 1 || b.dir
    if (aDir !== bDir) return aDir ? -1 : 1
    return x[i].localeCompare(y[i])
  }
  return x.length - y.length
}

const outside = () => new Error('That file is outside this workspace.')
const isOutside = (rel: string) => !rel || rel.startsWith('..') || isAbsolute(rel)

/**
 * The real path of a file in the worktree, or in one of the `also` folders (an agent's scratchpad), or null when it doesn't
 * exist. A relative path is read from the worktree. Throws for paths outside them all, symlinks included.
 */
async function insideWorkspace(root: string, path: string, also: string[] = []): Promise<string | null> {
  if (!path) throw outside()
  const base = await realpath(root)
  const full = await realpath(resolve(base, path)).catch(() => null)
  if (!full) return null
  const roots = [base, ...(await Promise.all(also.map((r) => realpath(r).catch(() => null)))).filter((r) => r !== null)]
  if (roots.every((r) => isOutside(relative(r, full)))) throw outside()
  return full
}

/**
 * Text of one file in the worktree or an `also` folder, for the file viewer. Refuses paths outside them (symlinks included), big
 * files and binaries.
 */
export async function readWorkspaceFile(root: string, path: string, also: string[] = []): Promise<string> {
  const full = await insideWorkspace(root, path, also)
  if (!full) throw new Error(`${path} is not a file in this workspace.`)
  const info = await stat(full)
  if (!info.isFile()) throw new Error(`${path} is not a file in this workspace.`)
  if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is too large to preview (${Math.round(info.size / 1024)} KB).`)
  const buf = await readFile(full)
  if (buf.includes(0)) throw new Error(`${path} is a binary file.`)
  return buf.toString('utf8')
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }
/** Images run bigger than the text the file viewer shows. A retina screenshot is often a few MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const execFileAsync = promisify(execFile)

/**
 * An image for the diff tab as a data URL (KERNEL-409). `since` set reads the blob at that commit, the way the diff does,
 * and leaves it unset to read the worktree. Null when the file isn't there. Refuses paths outside the workspace, other file
 * types and images over MAX_IMAGE_BYTES. An image on disk may be in one of the `also` folders too, by its absolute path.
 */
export async function readImage(root: string, path: string, since?: string, also: string[] = []): Promise<{ dataUrl: string } | null> {
  const type = IMAGE_TYPES[extname(path).slice(1).toLowerCase()]
  if (!type) throw new Error(`${path} is not an image Kernel can show.`)
  const rel = posix.normalize(path.replaceAll('\\', '/'))
  // A git blob is always in the worktree. A file on disk is checked by insideWorkspace, against the `also` folders too.
  if (isOutside(rel) && (since !== undefined || !also.length)) throw outside()
  const tooBig = (size: number) => new Error(`${path} is too large to preview (${Math.round(size / 1024)} KB).`)
  let bytes: Buffer
  if (since === undefined) {
    const full = await insideWorkspace(root, rel, also)
    if (!full) return null
    const info = await stat(full)
    if (!info.isFile()) return null
    if (info.size > MAX_IMAGE_BYTES) throw tooBig(info.size)
    bytes = await readFile(full)
  } else {
    // "<sha> blob <size>", or "<name> missing" when the file didn't exist at `since`.
    const [, kind, size] = (await exec('git', ['-C', root, 'cat-file', '--batch-check'], { input: `${since}:${rel}\n` })).stdout.trim().split(' ')
    if (kind !== 'blob') return null
    if (Number(size) > MAX_IMAGE_BYTES) throw tooBig(Number(size))
    // exec reads output as text, which would mangle the bytes.
    bytes = (await execFileAsync('git', ['-C', root, 'cat-file', 'blob', `${since}:${rel}`], { encoding: 'buffer', maxBuffer: MAX_IMAGE_BYTES + 1, timeout: EXEC_TIMEOUT_MS })).stdout
  }
  return { dataUrl: `data:${type};base64,${bytes.toString('base64')}` }
}

/**
 * Where Claude Code keeps a session's scratchpad: `<tmp>/claude-<uid>/<cwd with every other character a dash>/<session>/scratchpad`.
 * Kernel builds it from the chat's own session, never from what a message says.
 */
export function scratchpadDir(cwd: string, sessionId: string, tmp = process.env.CLAUDE_CODE_TMPDIR || '/tmp', uid = process.getuid?.() ?? 0): string {
  return join(tmp, `claude-${uid}`, cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'scratchpad')
}

/** A mention split from its line range: `a.ts:12`, `a.ts:12-30`, `a.ts:12:5` or `a.ts#L12-L30`. Backslashes read as slashes. */
export function parseMention(raw: string): { path: string; line?: number; endLine?: number } {
  let path = raw.trim().replaceAll('\\', '/')
  const m = /#L(\d+)(?:-L?(\d+))?$/.exec(path) ?? /:(\d+)(?:-(\d+))?(?::\d+)?$/.exec(path)
  if (!m) return { path }
  path = path.slice(0, m.index)
  const line = Number(m[1]), endLine = m[2] ? Number(m[2]) : undefined
  return { path, ...(line > 0 ? { line } : {}), ...(line > 0 && endLine && endLine > line ? { endLine } : {}) }
}

/** `.env`, `.env.local`, `prod.env` and `.envrc`, whatever they hold. */
const ENV_FILE = /^\.env(rc|\..+)?$|\.env$/i

/** Whether a file is `.env`-style or holds what secret masking would hide in a tool row. */
async function sensitiveFile(full: string, size: number): Promise<boolean> {
  if (ENV_FILE.test(basename(full))) return true
  if (size > MAX_FILE_BYTES) return false
  const buf = await readFile(full).catch(() => null)
  if (!buf || buf.includes(0)) return false
  const text = buf.toString('utf8')
  return maskSecrets(text) !== text
}

/**
 * Paths agents mentioned in chat, keyed by the raw string (clickable file mentions). Each one resolves inside the worktree, or
 * inside one of the `also` folders (the agent's scratchpad) by an absolute or `~/` path, or is null: outside them, symlinks out
 * included, or missing. A bare file name resolves only when exactly one file in the tree has it, and lists them all when several
 * do. One the tree doesn't list, such as an ignored `.env`, is looked for at the top of the worktree.
 */
export async function resolvePaths(root: string, raws: string[], o: { also?: string[]; home: string }): Promise<Record<string, ResolvedPath>> {
  const also = o.also ?? []
  const base = await realpath(root)
  let names: Promise<string[]> | undefined
  const files = () => (names ??= listTree(root).then((t) => t.filter((e) => !e.dir).map((e) => e.path)))
  const one = async (raw: string): Promise<ResolvedPath> => {
    const { path, line, endLine } = parseMention(raw)
    if (!path) return null
    let target = path === '~' || path.startsWith('~/') ? join(o.home, path.slice(1)) : path
    if (!target.includes('/')) {
      const found = (await files()).filter((f) => f.slice(f.lastIndexOf('/') + 1) === target)
      if (found.length > 1) return { matches: found }
      if (found.length === 1) target = found[0]
    }
    const full = await insideWorkspace(base, target, also).catch(() => null)
    if (!full) return null
    const info = await stat(full)
    const rel = relative(base, full)
    const at = isOutside(rel) ? full : rel
    if (info.isDirectory()) return { kind: 'dir', path: at }
    if (!info.isFile()) return null
    const kind: ResolvedFile['kind'] = IMAGE_TYPES[extname(full).slice(1).toLowerCase()] ? 'image' : 'file'
    const sensitive = kind === 'file' && await sensitiveFile(full, info.size)
    return { kind, path: at, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), ...(sensitive ? { sensitive: true as const } : {}) }
  }
  const unique = [...new Set(raws)]
  const out = await Promise.all(unique.map((raw) => one(raw).catch(() => null)))
  return Object.fromEntries(unique.map((raw, i) => [raw, out[i]]))
}

/**
 * Files and folders for the composer's @ menu, best match first. A match is every query letter in order. Letters that sit
 * together, start a path segment or fall in the name score higher, and shorter paths win ties. Folders are the parent paths
 * of the listed files, scored the same way, and one whose name is the query ranks above the files inside it. Saved plans are
 * listed too, though git ignores them, so a new chat can build from one (D-092).
 *
 * Each of the project's `references` is searched the same way, as `<folder name>/<path>`, and its rows carry an absolute path
 * and the folder's name (KERNEL-748). One that can't be listed is skipped.
 */
export async function searchFiles(root: string, query: string, limit = 8, references: string[] = []): Promise<FileEntry[]> {
  const out = await git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
  const plans = await readdir(join(root, PLANS_DIR)).then((names) => names.filter((n) => n.endsWith('.md')).map((n) => `${PLANS_DIR}/${n}`), () => [])
  const files = [...new Set([...out.split('\0').filter(Boolean), ...plans])].slice(0, MAX_ENTRIES)
  const q = query.trim().toLowerCase()
  if (!q) return files.slice(0, limit).map((path) => ({ path, dir: false }))
  const scored: (FileEntry & { score: number; length: number })[] = []
  const score = (list: string[], row: (rel: string) => Pick<FileEntry, 'path' | 'reference'>, prefix = '') => {
    for (const rel of list) {
      const s = fuzzyScore(prefix + rel, q)
      if (s !== null) scored.push({ ...row(rel), dir: false, score: s, length: (prefix + rel).length })
    }
    const dirs = new Set<string>()
    for (const file of list) {
      const parts = file.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
    for (const rel of dirs) {
      const s = fuzzyScore(prefix + rel, q)
      if (s !== null) scored.push({ ...row(rel), dir: true, score: s + (rel.slice(rel.lastIndexOf('/') + 1).toLowerCase() === q ? EXACT_FOLDER : 0), length: (prefix + rel).length })
    }
  }
  score(files, (path) => ({ path }))
  for (const folder of references) {
    const name = basename(folder)
    const list = await referenceFiles(folder).catch(() => [])
    score(list, (rel) => ({ path: join(folder, rel), reference: name }), `${name}/`)
  }
  scored.sort((a, b) => b.score - a.score || a.length - b.length || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map(({ path, dir, reference }) => ({ path, dir, ...(reference ? { reference } : {}) }))
}

/** Folders a reference folder's walk never enters, when it isn't a git checkout. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor'])

/**
 * The files in a reference folder, relative to it (KERNEL-748): what git lists in a checkout, else a walk that leaves out
 * hidden entries and the usual build folders. At most MAX_ENTRIES either way.
 */
async function referenceFiles(folder: string): Promise<string[]> {
  const listed = await git(folder, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').then((out) => out.split('\0').filter(Boolean), () => undefined)
  if (listed) return listed.slice(0, MAX_ENTRIES)
  const found: string[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(folder, rel), { withFileTypes: true }).catch(() => [])) {
      if (found.length >= MAX_ENTRIES) return
      if (e.name.startsWith('.')) continue
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path) }
      else if (e.isFile()) found.push(path)
    }
  }
  await walk('')
  return found
}

/** Enough to put a folder named exactly like the query above any file inside it. */
const EXACT_FOLDER = 30

export function fuzzyScore(path: string, q: string): number | null {
  const p = path.toLowerCase()
  const nameAt = p.lastIndexOf('/') + 1
  let score = 0, at = 0, prev = -2
  for (const ch of q) {
    const i = p.indexOf(ch, at)
    if (i < 0) return null
    if (i === prev + 1) score += 5
    if (i === 0 || '/-_.'.includes(p[i - 1])) score += 4
    if (i >= nameAt) score += 3
    prev = i; at = i + 1
  }
  if (p.slice(nameAt).includes(q)) score += 20
  return score - path.length / 100
}

/** Text between the `---` lines at the top of a markdown file, as simple key: value pairs. */
function frontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { data: {}, body: text }
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return { data, body: m[2] }
}

/** Commands Claude Code itself understands in a prompt. */
export const BUILT_IN_COMMANDS: Skill[] = [
  { name: 'compact', description: 'Summarize the conversation to free context', source: 'plugin', enabled: true },
  { name: 'review', description: 'Review the current changes', source: 'plugin', enabled: true },
  { name: 'init', description: 'Create a CLAUDE.md for this project', source: 'plugin', enabled: true }
]

/** Skills and commands the / menu offers: the repo's `.claude/skills/<name>/SKILL.md` and `.claude/commands/**.md`, then the built-ins. */
export async function discoverSkills(root: string, home?: string): Promise<Skill[]> {
  const found = new Map<string, Skill>()
  const add = (s: Skill) => { if (!found.has(s.name)) found.set(s.name, s) }
  const skillsDir = join(root, '.claude', 'skills')
  for (const dir of await readdir(skillsDir).catch(() => [])) {
    const text = await readFile(join(skillsDir, dir, 'SKILL.md'), 'utf8').catch(() => null)
    if (text === null) continue
    const { data, body } = frontmatter(text)
    add({ name: data.name || dir, description: data.description || firstLine(body), source: 'project', enabled: true })
  }
  // The user's own skills (Settings > Skills and MCP lists them next to the repo's). A repo skill of the same name wins.
  const userDir = home ? join(home, '.claude', 'skills') : undefined
  for (const dir of userDir ? await readdir(userDir).catch(() => []) : []) {
    const text = await readFile(join(userDir!, dir, 'SKILL.md'), 'utf8').catch(() => null)
    if (text === null) continue
    const { data, body } = frontmatter(text)
    add({ name: data.name || dir, description: data.description || firstLine(body), source: 'user', enabled: true })
  }
  const commandsDir = join(root, '.claude', 'commands')
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}:`)
      else if (e.name.endsWith('.md')) {
        const { data, body } = frontmatter(await readFile(join(dir, e.name), 'utf8').catch(() => ''))
        add({ name: `${prefix}${e.name.slice(0, -3)}`, description: data.description || firstLine(body), source: 'project', enabled: true })
      }
    }
  }
  await walk(commandsDir, '')
  const project = [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  return [...project, ...BUILT_IN_COMMANDS.filter((s) => !found.has(s.name))]
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '').slice(0, 120)
}
