import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, matchesGlob, posix, relative, sep } from 'node:path'
import type { FileToCopy, ProductionHint } from '@shared/types'
import { MAX_ENV_FILE, productionHints } from './env'
import { exec } from './exec'

/** The most files one worktree gets from the main checkout. */
export const MAX_FILES_TO_COPY = 500

const GLOB = /[*?[\]{}]/
/** An entry with glob characters is a pattern. Anything else is an exact path, as before KERNEL-245. */
export const isPattern = (entry: string) => GLOB.test(entry)

const SKIPPED_SEGMENTS = new Set(['node_modules', '.git'])
const skipped = (path: string) => path.split('/').some((s) => SKIPPED_SEGMENTS.has(s))
const escapes = (p: string) => p === '..' || p.startsWith('../')
const byPath = (a: string, b: string) => a.localeCompare(b)

/** Is `path` the folder `root` or inside it? Both are real paths (KERNEL-209). */
export const within = (root: string, path: string) => { const r = relative(root, path); return r === '' || (!escapes(r.split(sep).join('/')) && !isAbsolute(r)) }

/** The segments before the first one with a glob character: `secrets` for `secrets/*.env`, empty for `**\/*.env`. */
const literalPrefix = (pattern: string) => {
  const segments = pattern.split('/')
  return segments.slice(0, segments.findIndex(isPattern)).join('/')
}

/**
 * What Files to copy resolves to in `repo`, sorted by path and capped at MAX_FILES_TO_COPY (KERNEL-245).
 * Exact paths copy whatever file is there, following symlinks, as they always did. Patterns match the main checkout's
 * ignored files, listed by git, so a tracked file never matches and a wholly ignored folder is only walked when a
 * pattern names it. The project setup step, workspace create and restore, and `files.preview` all read this.
 */
export async function resolveFilesToCopy(repo: string, entries: string[], refused?: string[], exclude?: string[]): Promise<FileToCopy[]> {
  return (await resolveCopySources(repo, entries, refused, exclude)).map(({ path, size }) => ({ path, size }))
}

/** Does a `[files] exclude` entry, an exact path or a pattern, name `path` (KERNEL-449)? */
const excludes = (entry: string, path: string) => {
  const e = posix.normalize(entry.trim()).replace(/^\.?\//, '')
  return isPattern(e) ? matchesGlob(path, e) : e === path
}

/**
 * The same, with the real file each path copies from. Nothing leaves the repo (KERNEL-209): an exact path that climbs
 * out with `..`, a pattern that is absolute or has a `..` segment, and a file whose real path is outside the repo once
 * symlinks are followed, through the file or a folder on its way, are refused and named in `refused`. A file `exclude`
 * names is left out, whatever entry matched it (KERNEL-449).
 */
export async function resolveCopySources(repo: string, entries: string[], refused: string[] = [], exclude: string[] = []): Promise<(FileToCopy & { from: string })[]> {
  const wanted = entries.filter((e): e is string => typeof e === 'string').map((e) => e.trim()).filter(Boolean)
  const found = new Map<string, { size: number; from: string }>()
  const root = await realpath(repo).catch(() => undefined)
  if (!root) return []
  const refuse = (what: string) => { if (!refused.includes(what)) refused.push(what) }
  const excluded = (path: string) => exclude.some((e) => typeof e === 'string' && !!e.trim() && excludes(e, path))
  /** The real file behind `path`, when it is one and stays in the repo. */
  const source = async (path: string, entry: string) => {
    const from = await realpath(join(repo, path)).catch(() => undefined)
    if (!from) return undefined
    if (!within(root, from)) { refuse(entry); return undefined }
    const s = await stat(from).catch(() => undefined)
    return s?.isFile() ? { size: s.size, from } : undefined
  }

  for (const entry of wanted.filter((e) => !isPattern(e))) {
    // join() reads a leading slash as relative, which is how these entries always worked. Leaving the folder is not allowed.
    const path = relative(repo, join(repo, entry)).split(sep).join('/')
    if (path && escapes(path)) { refuse(entry); continue }
    if (!path || path.split('/').includes('.git') || found.has(path) || excluded(path)) continue
    const file = await source(path, entry)
    if (file) found.set(path, file)
  }

  const patterns: string[] = []
  for (const e of wanted.filter(isPattern)) {
    if (isAbsolute(e) || e.split(/[\\/]/).includes('..')) refuse(e)
    else patterns.push(posix.normalize(e).replace(/^\.\//, ''))
  }
  if (patterns.length) {
    for (const path of await candidates(repo, patterns)) {
      if (found.size >= MAX_FILES_TO_COPY) break
      if (found.has(path) || !patterns.some((p) => matchesGlob(path, p)) || excluded(path)) continue
      // A pattern match that is itself a symlink is skipped (KERNEL-245); one under a linked folder is refused.
      const s = await lstat(join(repo, path)).catch(() => undefined)
      if (!s?.isFile()) continue
      const file = await source(path, path)
      if (file) found.set(path, file)
    }
  }

  return [...found].map(([path, f]) => ({ path, ...f })).sort((a, b) => byPath(a.path, b.path)).slice(0, MAX_FILES_TO_COPY)
}

/** An env file by its name: `.env`, `.env.production`, `prod.env`. Only these are read for the production check. */
const envLike = (path: string) => { const name = posix.basename(path); return name.startsWith('.env') || name.endsWith('.env') }

/**
 * Every variable in the env files to copy that looks like production, by file, the strongest reason first in each file
 * (KERNEL-449). It reads the main checkout's files, the same ones a new worktree gets, and returns names, never values.
 */
export async function productionInCopy(repo: string, entries: string[], exclude: string[] = []): Promise<ProductionHint[]> {
  const out: ProductionHint[] = []
  for (const f of await resolveCopySources(repo, entries, [], exclude)) {
    if (!envLike(f.path) || f.size > MAX_ENV_FILE) continue
    const text = await readFile(f.from, 'utf8').catch(() => null)
    if (text !== null) out.push(...productionHints(f.path, text))
  }
  return out
}

/**
 * Ignored, untracked files in the main checkout, sorted by path. `--directory` reports a wholly ignored folder as one
 * `dir/` entry without listing what is inside it. When a pattern's literal prefix is inside one, like `secrets/*.env`
 * with `secrets/` ignored, git lists that prefix file by file. node_modules and .git are never expanded, even when named,
 * and nothing under them is returned. Only a folder with its own `.git` has candidates, the test `inspectFolder` uses,
 * so a folder project inside a parent repo doesn't match the parent's ignored files.
 */
async function candidates(repo: string, patterns: string[]): Promise<string[]> {
  if (!(await stat(join(repo, '.git')).then(() => true, () => false))) return []
  const listed = await ignored(repo, ['--directory'])
  const folders = listed.filter((p) => p.endsWith('/'))
  const named = [...new Set(patterns.map(literalPrefix))].filter((prefix) => prefix && !skipped(prefix) && folders.some((d) => `${prefix}/`.startsWith(d)))
  const files = listed.filter((p) => !p.endsWith('/'))
  // A prefix inside another named prefix is already listed with it.
  for (const prefix of named.filter((p) => !named.some((q) => q !== p && p.startsWith(`${q}/`)))) files.push(...await ignored(repo, ['--', prefix]))
  return [...new Set(files)].filter((p) => !skipped(p)).sort(byPath)
}

async function ignored(repo: string, args: string[]): Promise<string[]> {
  const r = await exec('git', ['-C', repo, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', ...args])
  return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : []
}
