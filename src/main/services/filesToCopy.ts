import { lstat, stat } from 'node:fs/promises'
import { isAbsolute, join, matchesGlob, posix, relative, sep } from 'node:path'
import type { FileToCopy } from '@shared/types'
import { exec } from './exec'

/** The most files one worktree gets from the main checkout. */
export const MAX_FILES_TO_COPY = 500

const GLOB = /[*?[\]{}]/
/** An entry with glob characters is a pattern. Anything else is an exact path, as before KERNEL-245. */
export const isPattern = (entry: string) => GLOB.test(entry)

const SKIPPED_SEGMENTS = new Set(['node_modules', '.git'])
const escapes = (p: string) => p === '..' || p.startsWith('../')

/**
 * What Files to copy resolves to in `repo`, sorted by path and capped at MAX_FILES_TO_COPY (KERNEL-245).
 * Exact paths copy whatever file is there, as they always did. Patterns match the main checkout's ignored files,
 * listed by git, so a tracked file never matches and a wholly ignored folder like node_modules is never walked.
 * The room setup step, workspace create and restore, and `files.preview` all read this.
 */
export async function resolveFilesToCopy(repo: string, entries: string[]): Promise<FileToCopy[]> {
  const wanted = entries.map((e) => e.trim()).filter(Boolean)
  const found = new Map<string, number>()

  for (const entry of wanted.filter((e) => !isPattern(e))) {
    // join() reads a leading slash as relative, which is how these entries always worked. Leaving the folder is not allowed.
    const path = relative(repo, join(repo, entry)).split(sep).join('/')
    if (!path || escapes(path) || found.has(path)) continue
    const s = await stat(join(repo, path)).catch(() => undefined)
    if (s?.isFile()) found.set(path, s.size)
  }

  const patterns = wanted.filter((e) => isPattern(e) && !isAbsolute(e) && !e.split(/[\\/]/).includes('..')).map((e) => posix.normalize(e).replace(/^\.\//, ''))
  if (patterns.length) {
    for (const path of await ignoredFiles(repo)) {
      if (found.size >= MAX_FILES_TO_COPY) break
      if (found.has(path) || !patterns.some((p) => matchesGlob(path, p))) continue
      const s = await lstat(join(repo, path)).catch(() => undefined)
      if (s?.isFile()) found.set(path, s.size)
    }
  }

  return [...found].map(([path, size]) => ({ path, size })).sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_FILES_TO_COPY)
}

/**
 * Ignored, untracked files in the main checkout. `--directory` reports a wholly ignored folder as one `dir/` entry
 * without listing what is inside it, and those are dropped here with anything under node_modules or .git.
 * A folder that isn't a git repo has none, so its patterns match nothing.
 */
async function ignoredFiles(repo: string): Promise<string[]> {
  const r = await exec('git', ['-C', repo, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  if (r.code !== 0) return []
  return r.stdout.split('\0').filter((p) => p && !p.endsWith('/') && !p.split('/').some((s) => SKIPPED_SEGMENTS.has(s)))
}
