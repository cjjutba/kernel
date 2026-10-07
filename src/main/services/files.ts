import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ChangedFile, FileEntry, Skill } from '@shared/types'
import { git } from './exec'

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

/** Text of one file in the worktree, for the file viewer. Refuses paths outside it (symlinks included), big files and binaries. */
export async function readWorkspaceFile(root: string, path: string): Promise<string> {
  const outside = () => new Error('That file is outside this workspace.')
  if (!path) throw outside()
  const base = await realpath(root)
  const full = await realpath(resolve(base, path)).catch(() => null)
  if (!full) throw new Error(`${path} is not a file in this workspace.`)
  const rel = relative(base, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw outside()
  const info = await stat(full)
  if (!info.isFile()) throw new Error(`${path} is not a file in this workspace.`)
  if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is too large to preview (${Math.round(info.size / 1024)} KB).`)
  const buf = await readFile(full)
  if (buf.includes(0)) throw new Error(`${path} is a binary file.`)
  return buf.toString('utf8')
}

/**
 * Files for the composer's @ menu, best match first. A match is every query letter in order. Letters that sit together,
 * start a path segment or fall in the file name score higher, and shorter paths win ties.
 */
export async function searchFiles(root: string, query: string, limit = 8): Promise<FileEntry[]> {
  const out = await git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
  const files = [...new Set(out.split('\0').filter(Boolean))].slice(0, MAX_ENTRIES)
  const q = query.trim().toLowerCase()
  if (!q) return files.slice(0, limit).map((path) => ({ path, dir: false }))
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const score = fuzzyScore(path, q)
    if (score !== null) scored.push({ path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map(({ path }) => ({ path, dir: false }))
}

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
export async function discoverSkills(root: string): Promise<Skill[]> {
  const found = new Map<string, Skill>()
  const add = (s: Skill) => { if (!found.has(s.name)) found.set(s.name, s) }
  const skillsDir = join(root, '.claude', 'skills')
  for (const dir of await readdir(skillsDir).catch(() => [])) {
    const text = await readFile(join(skillsDir, dir, 'SKILL.md'), 'utf8').catch(() => null)
    if (text === null) continue
    const { data, body } = frontmatter(text)
    add({ name: data.name || dir, description: data.description || firstLine(body), source: 'project', enabled: true })
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
