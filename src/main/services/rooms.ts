import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { FolderInfo, RepoSummary } from '@shared/types'
import { exec, git, run } from './exec'

// Everything a new room needs from the outside world: reading folders, GitHub through `gh`, the starter team and settings.toml.

/** "~/Projects/x" to an absolute path. */
export function expandHome(p: string, home = homedir()): string {
  if (p === '~') return home
  return p.startsWith('~/') ? join(home, p.slice(2)) : resolve(p)
}

/** The other way, for text the user reads. */
export function tildify(p: string, home = homedir()): string {
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false
const exists = async (p: string) => !!(await stat(p).catch(() => null))

/** Is this folder a git checkout, which branch is it on, and how many files have uncommitted changes. */
export async function inspectFolder(path: string, home = homedir()): Promise<FolderInfo> {
  const abs = expandHome(path, home)
  if (!(await isDir(abs))) throw new Error(`${tildify(abs, home)} is not a folder.`)
  if (!(await exists(join(abs, '.git')))) return { path: abs, git: false }
  const branch = await exec('git', ['-C', abs, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const status = await exec('git', ['-C', abs, 'status', '--porcelain'])
  return {
    path: abs,
    git: true,
    // A repo with no commits has no HEAD yet. Say so with the name git will use for the first branch.
    branch: branch.code === 0 ? branch.stdout.trim() : (await exec('git', ['-C', abs, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim() || 'main',
    dirty: status.code === 0 ? status.stdout.split('\n').filter(Boolean).length : 0
  }
}

/** Project folders next to the rooms you already have, and in ~/Projects, newest first. Folders that are already rooms are left out. */
export async function recentFolders(roomPaths: string[], home = homedir(), limit = 6): Promise<FolderInfo[]> {
  const parents = new Set([join(home, 'Projects'), ...roomPaths.map((p) => dirname(p))])
  const taken = new Set(roomPaths)
  const found: { path: string; mtime: number }[] = []
  for (const parent of parents) {
    const names = await readdir(parent).catch(() => [] as string[])
    for (const n of names) {
      if (n.startsWith('.')) continue
      const path = join(parent, n)
      const s = await stat(path).catch(() => null)
      if (s?.isDirectory() && !taken.has(path)) found.push({ path, mtime: s.mtimeMs })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  const out: FolderInfo[] = []
  for (const f of found.slice(0, limit)) out.push(await inspectFolder(f.path, home).catch(() => ({ path: f.path, git: false })))
  return out
}

/** The signed-in user's repos through `gh`, newest push first. `query` filters by name. */
export async function listRepos(query?: string): Promise<RepoSummary[]> {
  const r = await exec('gh', ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,name,isPrivate,pushedAt'], { timeoutMs: 30000 })
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'Could not list your repositories. Run gh auth login and try again.')
  const q = query?.trim().toLowerCase()
  return (JSON.parse(r.stdout) as { nameWithOwner: string; name: string; isPrivate: boolean; pushedAt: string }[])
    .map((x) => ({ fullName: x.nameWithOwner, name: x.name, private: x.isPrivate, updatedAt: Date.parse(x.pushedAt) || 0 }))
    .filter((x) => !q || x.fullName.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The folder must not exist yet, or be empty, so a clone never lands on top of someone's work. */
export async function assertFreeFolder(path: string, home = homedir()) {
  if (!(await exists(path))) return
  if (!(await isDir(path)) || (await readdir(path)).length) throw new Error(`${tildify(path, home)} already exists and is not empty. Pick another folder.`)
}

export async function cloneRepo(fullName: string, dest: string) {
  await mkdir(dirname(dest), { recursive: true })
  await run('gh', ['repo', 'clone', fullName, dest], { timeoutMs: 600_000 })
}

/** From scratch: a shallow copy of the starter kit with its history dropped, so the room starts with one commit. */
export async function copyTemplate(fullName: string, dest: string) {
  await cloneRepo(fullName, dest)
  await rm(join(dest, '.git'), { recursive: true, force: true })
  await initGit(dest)
}

/** `git init` plus a first commit, so worktrees have something to branch from. Works without a git identity. */
export async function initGit(path: string) {
  await git(path, 'init', '-q', '-b', 'main')
  await git(path, 'add', '-A')
  await git(path, '-c', 'user.name=Kernel', '-c', 'user.email=kernel@localhost', 'commit', '-q', '--allow-empty', '-m', 'Initial commit')
}

export const STARTER_IDS = ['rowan', 'kai', 'noor', 'ivy', 'theo'] as const

/** Agent file names in .claude/agents. Empty when the folder is missing. */
export async function agentFiles(repoPath: string): Promise<string[]> {
  return (await readdir(join(repoPath, '.claude', 'agents')).catch(() => [] as string[])).filter((f) => f.endsWith('.md'))
}

/** Copy starter agent files into .claude/agents. The Lead is always seated. Returns the ids written. */
export async function seatStarterTeam(starterDir: string, repoPath: string, ids: string[]): Promise<string[]> {
  const wanted = [...new Set(['rowan', ...ids])]
  const dir = join(repoPath, '.claude', 'agents')
  await mkdir(dir, { recursive: true })
  const seated: string[] = []
  for (const id of wanted) {
    if (!/^[a-z0-9-]+$/.test(id)) continue
    const from = join(starterDir, `${id}.md`)
    if (!(await exists(from))) continue
    await copyFile(from, join(dir, `${id}.md`))
    seated.push(id)
  }
  return seated
}

/** Copy another room's agent files, retired ones excluded. Returns how many were written. */
export async function copyAgentFiles(fromRepo: string, toRepo: string): Promise<number> {
  const files = await agentFiles(fromRepo)
  if (!files.length) return 0
  const dir = join(toRepo, '.claude', 'agents')
  await mkdir(dir, { recursive: true })
  for (const f of files) await copyFile(join(fromRepo, '.claude', 'agents', f), join(dir, f))
  return files.length
}

/**
 * The file Kernel writes when a repo has none. With an install command, setup is a real line, so every new worktree
 * installs what the room's own checkout installed. Without one, the scripts stay commented examples.
 */
export function defaultRepoSettings(setup?: string): string {
  const scripts = setup
    ? `[scripts]\n# Runs in every new workspace before the agent starts.\nsetup = ${JSON.stringify(setup)}\n# run = "pnpm dev --port $KERNEL_PORT"\n# archive = ""\n`
    : '# [scripts]\n# setup = "pnpm install"\n# run = "pnpm dev --port $KERNEL_PORT"\n# archive = ""\n'
  return `# Kernel settings for this repo. Commit it so the whole team shares it.
# Personal overrides go in .kernel/settings.local.toml, which stays out of git.

[files]
# Copied from this checkout into every new worktree.
copy = [".env", ".env.local"]

${scripts}`
}

/** Writes .kernel/settings.toml when it is missing, with the checkout's install command as the setup script. Returns true when it wrote one. */
export async function ensureRepoSettings(repoPath: string): Promise<boolean> {
  const file = join(repoPath, '.kernel', 'settings.toml')
  if (await exists(file)) return false
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, defaultRepoSettings(await lockfileInstall(repoPath)))
  return true
}

/** The install command a checkout's lockfile asks for, whether or not it has run. Undefined when it has no package manager. */
export async function lockfileInstall(repoPath: string): Promise<string | undefined> {
  const locks: [string, string][] = [['pnpm-lock.yaml', 'pnpm install'], ['yarn.lock', 'yarn install'], ['bun.lockb', 'bun install'], ['bun.lock', 'bun install'], ['package-lock.json', 'npm install']]
  for (const [lock, command] of locks) if (await exists(join(repoPath, lock))) return command
  return (await exists(join(repoPath, 'package.json'))) ? 'npm install' : undefined
}

/** The install command for a checkout, from its lockfile. Undefined when it has no package manager or already has node_modules. */
export async function installCommand(repoPath: string): Promise<{ command?: string; reason?: string }> {
  const command = await lockfileInstall(repoPath)
  if (!command) return { reason: 'Nothing to install' }
  return (await exists(join(repoPath, 'node_modules'))) ? { reason: 'Already installed' } : { command }
}
