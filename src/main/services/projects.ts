import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { FolderInfo, RepoSummary } from '@shared/types'
import { exec, git, gitSlow, run } from './exec'
import { ghError } from './github'
import { removeTree } from './removeTree'

// Everything a new project needs from the outside world: reading folders, GitHub through `gh`, the starter team and settings.toml.

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
export const exists = async (p: string) => !!(await stat(p).catch(() => null))

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

/** Project folders next to the projects you already have, and in ~/Projects, newest first. Folders that are already projects are left out. */
export async function recentFolders(projectPaths: string[], home = homedir(), limit = 6): Promise<FolderInfo[]> {
  const parents = new Set([join(home, 'Projects'), ...projectPaths.map((p) => dirname(p))])
  const taken = new Set(projectPaths)
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
  if (r.code !== 0 || r.timedOut) throw ghError(r, 'Could not list your repositories')
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

/**
 * From scratch: a shallow copy of the starter kit with its history dropped, so the project starts with one commit. The kit is
 * Kernel's own files in a folder that was empty, so committing them is safe. Works without a git identity.
 */
export async function copyTemplate(fullName: string, dest: string) {
  await cloneRepo(fullName, dest)
  await removeTree(join(dest, '.git'))
  await git(dest, 'init', '-q', '-b', 'main')
  await gitSlow(dest, 'add', '-A')
  await git(dest, '-c', 'user.name=Kernel', '-c', 'user.email=kernel@localhost', 'commit', '-q', '--allow-empty', '-m', 'Initial commit')
}

/** Past this many files, a folder is not a project to run `git init` in (KERNEL-231). */
export const INIT_MAX_FILES = 5000

/** The home folder is never a project: agents would work in all of it. */
export function refuseHome(path: string, home = homedir()) {
  if (resolve(path) === resolve(home)) throw new Error('Your home folder can\'t be a project. Pick a project folder inside it.')
}

/** Counts the files under `path`, `.git` left out, and stops once past `max`. Folders it can't read count as empty. */
export async function countFiles(path: string, max: number): Promise<number> {
  let n = 0
  const dirs = [path]
  while (dirs.length && n <= max) {
    const dir = dirs.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isDirectory()) { if (e.name !== '.git') dirs.push(join(dir, e.name)) }
      else if (++n > max) break
    }
  }
  return n
}

/** Refuses a folder `initGit` must not touch: the home folder, or one with more than INIT_MAX_FILES files. */
export async function assertInitable(path: string, home = homedir()) {
  refuseHome(path, home)
  if (await countFiles(path, INIT_MAX_FILES) > INIT_MAX_FILES) {
    throw new Error(`${tildify(path, home)} has more than ${INIT_MAX_FILES.toLocaleString('en-US')} files, so Kernel won't run git init there. Run git init yourself, add a .gitignore for folders like node_modules, make the first commit, then add the folder.`)
  }
}

/**
 * `git init` only (KERNEL-231). Kernel commits nothing, since the folder may hold secrets or build output: the user makes the
 * first commit, and until then the project has nothing to branch a worktree from.
 */
export async function initGit(path: string, home = homedir()) {
  await assertInitable(path, home)
  await git(path, 'init', '-q', '-b', 'main')
}

/**
 * The starter agents New project and Team can seat. Kernel leads without a file, so no Lead is seated (KERNEL-397),
 * and Customize on Kernel's profile writes kernel.md (KERNEL-692). Theo reviews as a starter like the others (KERNEL-553).
 */
export const STARTER_IDS = ['kai', 'noor', 'ivy', 'theo'] as const

/** Agent file names in .claude/agents. Empty when the folder is missing. */
export async function agentFiles(repoPath: string): Promise<string[]> {
  return (await readdir(join(repoPath, '.claude', 'agents')).catch(() => [] as string[])).filter((f) => f.endsWith('.md'))
}

/** Copy starter teammates into .claude/agents. A file the repo already has is left as it is. Returns the ids written. */
export async function seatStarterTeam(starterDir: string, repoPath: string, ids: string[]): Promise<string[]> {
  const dir = join(repoPath, '.claude', 'agents')
  const seated: string[] = []
  for (const id of new Set(ids)) {
    if (!(STARTER_IDS as readonly string[]).includes(id)) continue
    const from = join(starterDir, `${id}.md`)
    const to = join(dir, `${id}.md`)
    if (!(await exists(from)) || await exists(to)) continue
    await mkdir(dir, { recursive: true })
    await copyFile(from, to)
    seated.push(id)
  }
  return seated
}

/** Copy another project's agent files, retired ones excluded. Returns how many were written. */
export async function copyAgentFiles(fromRepo: string, toRepo: string): Promise<number> {
  const files = await agentFiles(fromRepo)
  if (!files.length) return 0
  const dir = join(toRepo, '.claude', 'agents')
  await mkdir(dir, { recursive: true })
  for (const f of files) await copyFile(join(fromRepo, '.claude', 'agents', f), join(dir, f))
  return files.length
}

/**
 * The file Kernel writes when a repo has none. It sets no script: the scripts are commented examples, `install` and `run`
 * the stack's own when Kernel knows it, and Settings, Scripts offers the real ones (`scripts.suggest`, KERNEL-682). It ends
 * with the example of one database per workspace (KERNEL-449).
 */
export function defaultRepoSettings(install?: string, run = 'pnpm dev --port $KERNEL_PORT'): string {
  return `# Kernel settings for this repo. Commit it so the whole team shares it.
# Personal overrides go in .kernel/settings.local.toml, which stays out of git.

[files]
# Copied from this checkout into every new worktree.
copy = [".env", ".env.local"]

# [scripts]
# Runs in every new workspace before the agent starts.
# setup = ${JSON.stringify(install ?? 'pnpm install')}
# run = ${JSON.stringify(run)}
# archive = ""

# One database per workspace: setup creates it and archive drops it.
#   setup = ${JSON.stringify(install ? `${install} && createdb $KERNEL_WORKSPACE_SLUG` : 'createdb $KERNEL_WORKSPACE_SLUG')}
#   archive = "dropdb --if-exists $KERNEL_WORKSPACE_SLUG"
# Agents, scripts and terminals read .env.kernel from this checkout when git
# doesn't track it, with \${KERNEL_*} names filled in for each workspace:
#   DATABASE_URL=postgres://localhost:5432/\${KERNEL_WORKSPACE_SLUG}
# Each worktree is also its own Docker Compose project.
# To read env files the repo commits, from each worktree, list them instead:
#   [env]
#   files = [".env.kernel"]
`
}

/** Writes .kernel/settings.toml when it is missing, with the checkout's install and run commands as commented examples. Returns true when it wrote one. */
export async function ensureRepoSettings(repoPath: string): Promise<boolean> {
  const file = join(repoPath, '.kernel', 'settings.toml')
  if (await exists(file)) return false
  await mkdir(dirname(file), { recursive: true })
  const found = await stacksOf(repoPath)
  await writeFile(file, defaultRepoSettings(installOf(found), found[0]?.run))
  return true
}

/**
 * One stack's install. `file` in the checkout's root says the repo uses it, and `leaves` is the folder the install leaves
 * in the checkout, when it leaves one there.
 */
export type Stack = { file: string; install: string; run: string; leaves?: string }

const js = (file: string, install: string, run: string): Stack => ({ file, install, run, leaves: 'node_modules' })

/**
 * The stacks Kernel knows, one list per language, each in the order it picks from. A checkout gets the first match of
 * every language, so a Rails app with a JS bundle installs both. JS comes last, as in Rails' and Laravel's own setup.
 */
const STACKS: Stack[][] = [
  [
    { file: 'uv.lock', install: 'uv sync', run: 'uv run uvicorn main:app --port $KERNEL_PORT', leaves: '.venv' },
    { file: 'poetry.lock', install: 'poetry install', run: 'poetry run uvicorn main:app --port $KERNEL_PORT' },
    // pip installs into whichever Python comes first, and Homebrew's refuses, so each checkout gets its own .venv.
    { file: 'requirements.txt', install: 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt', run: '.venv/bin/python -m uvicorn main:app --port $KERNEL_PORT', leaves: '.venv' }
  ],
  [{ file: 'Gemfile', install: 'bundle install', run: 'bin/rails server --port $KERNEL_PORT' }],
  [{ file: 'mix.exs', install: 'mix deps.get', run: 'PORT=$KERNEL_PORT mix phx.server', leaves: 'deps' }],
  [{ file: 'composer.json', install: 'composer install', run: 'php -S localhost:$KERNEL_PORT -t public', leaves: 'vendor' }],
  [{ file: 'Cargo.toml', install: 'cargo fetch', run: 'PORT=$KERNEL_PORT cargo run' }],
  [{ file: 'go.mod', install: 'go mod download', run: 'PORT=$KERNEL_PORT go run .' }],
  [
    js('pnpm-lock.yaml', 'pnpm install', 'pnpm dev --port $KERNEL_PORT'),
    js('yarn.lock', 'yarn install', 'yarn dev --port $KERNEL_PORT'),
    js('bun.lockb', 'bun install', 'bun run dev --port $KERNEL_PORT'),
    js('bun.lock', 'bun install', 'bun run dev --port $KERNEL_PORT'),
    js('package-lock.json', 'npm install', 'npm run dev -- --port $KERNEL_PORT'),
    js('package.json', 'npm install', 'npm run dev -- --port $KERNEL_PORT')
  ]
]

/** The stacks a checkout uses, from the files in its root. */
export async function stacksOf(repoPath: string): Promise<Stack[]> {
  const found: Stack[] = []
  for (const language of STACKS) {
    for (const stack of language) if (await exists(join(repoPath, stack.file))) { found.push(stack); break }
  }
  return found
}

export const installOf = (stacks: Stack[]) => (stacks.length ? stacks.map((s) => s.install).join(' && ') : undefined)

/** The install command a checkout's files ask for, whether or not it has run, one per stack. Undefined when it has no package manager Kernel knows. */
export async function lockfileInstall(repoPath: string): Promise<string | undefined> {
  return installOf(await stacksOf(repoPath))
}

/**
 * What project setup's Install step runs in a checkout: the install of each stack whose folder isn't there yet. An install that leaves nothing in the checkout runs every time, which changes
 * nothing once it has run. No command when the checkout has no package manager, or every install already left its folder.
 */
export async function installCommand(repoPath: string): Promise<{ command?: string; reason?: string }> {
  const found = await stacksOf(repoPath)
  if (!found.length) return { reason: 'Nothing to install' }
  const left: Stack[] = []
  for (const stack of found) if (!stack.leaves || !(await exists(join(repoPath, stack.leaves)))) left.push(stack)
  if (!left.length) return { reason: 'Already installed' }
  return { command: installOf(left) }
}
