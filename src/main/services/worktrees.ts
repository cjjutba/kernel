import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exec, git } from './exec'
import type { ChangedFile } from '@shared/types'

/** "Export invoices as PDF" -> "export-invoices-as-pdf" (max 48 chars, no trailing dash). */
export function slugify(text: string, max = 48): string {
  const s = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (s.slice(0, max).replace(/-+$/, '') || 'workspace')
}

/** Fill a branch pattern like "feat/{slug}" or "feat/{task}-{slug}". */
export function branchName(pattern: string, vars: { slug: string; task?: string }): string {
  return pattern.replace('{slug}', vars.slug).replace('{task}', vars.task ? vars.task.toLowerCase() : '').replace(/\/-|-\//g, '/').replace(/-{2,}/g, '-').replace(/[-/]+$/, '')
}

/**
 * The branch for a task. With a task id (a Linear issue) the id leads the slug, `feat/{task}-{slug}`,
 * even when the configured pattern only has `{slug}`.
 */
export function taskBranch(pattern: string, title: string, task?: string): string {
  const p = task && !pattern.includes('{task}') ? pattern.replace('{slug}', '{task}-{slug}') : pattern
  return branchName(p, { slug: slugify(title), task })
}

/** Local and remote branches, newest first, for the From popover and the target branch menu. `origin/HEAD` is left out. */
export async function listBranches(repo: string): Promise<string[]> {
  const out = await git(repo, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes')
  const names = out.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'origin' && !l.endsWith('/HEAD'))
  return [...new Set(names)]
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
}

/** origin/HEAD when it is set, else main, then master (on origin or locally), else the current branch. */
export async function defaultBranch(repo: string): Promise<string> {
  const r = await exec('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (r.code === 0) return r.stdout.trim().replace(/^origin\//, '')
  for (const b of ['main', 'master']) if (await refExists(repo, `origin/${b}`) || await branchExists(repo, b)) return b
  return currentBranch(repo)
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0
}

/**
 * The ref a workspace starts from: `wanted` when it exists, else the same branch without `origin/` locally,
 * else the default branch, `origin/<default>` when the remote has it. A folder with no remote and only
 * `master` gets `master` for the `origin/main` default (KERNEL-62). With `fetch`, an `origin/` ref fetches first.
 * `strict` is for a base CJ picked (a PR or a branch): it throws rather than start somewhere else.
 */
export async function resolveBaseRef(repo: string, wanted: string, o: { fetch?: boolean; strict?: boolean } = {}): Promise<string> {
  if (o.fetch && wanted.startsWith('origin/')) await exec('git', ['-C', repo, 'fetch', '--quiet', 'origin'], { timeoutMs: 30000 })
  const name = wanted.replace(/^origin\//, '')
  for (const ref of new Set([wanted, name])) if (await refExists(repo, ref)) return ref
  if (o.strict) throw new Error(`${name} is not on origin or in this repo, so there is nothing to start from.`)
  const d = await defaultBranch(repo)
  return await refExists(repo, `origin/${d}`) ? `origin/${d}` : d
}

export async function remoteRepo(repo: string): Promise<string | undefined> {
  const r = await exec('git', ['-C', repo, 'remote', 'get-url', 'origin'])
  if (r.code !== 0) return undefined
  const m = /github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/.exec(r.stdout.trim())
  return m?.[1]
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
}

/** Pick a branch name that does not exist yet by appending -2, -3... */
export async function freeBranch(repo: string, wanted: string): Promise<string> {
  let name = wanted
  for (let i = 2; await branchExists(repo, name); i++) name = `${wanted}-${i}`
  return name
}

export interface CreateWorktree { repo: string; root: string; branch: string; baseRef: string }

/** Creates <root>/<branch-slug> on a new branch from baseRef (see `resolveBaseRef`). Returns the worktree path. */
export async function createWorktree(o: CreateWorktree): Promise<string> {
  await mkdir(o.root, { recursive: true })
  const path = join(o.root, slugify(o.branch.replace(/\//g, '-'), 80))
  await git(o.repo, 'worktree', 'add', '-b', o.branch, path, o.baseRef)
  return path
}

/**
 * Recreates a worktree for a branch that already exists, at `path`. Falls back to origin/<branch> when the
 * local branch was deleted on archive. Throws a plain message when the branch is gone everywhere.
 */
export async function restoreWorktree(o: { repo: string; path: string; branch: string }): Promise<void> {
  await mkdir(dirname(o.path), { recursive: true })
  if (await branchExists(o.repo, o.branch)) { await git(o.repo, 'worktree', 'add', o.path, o.branch); return }
  const remote = await exec('git', ['-C', o.repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${o.branch}`])
  if (remote.code !== 0) throw new Error(`The branch ${o.branch} no longer exists, so there is nothing to restore.`)
  await git(o.repo, 'worktree', 'add', '-b', o.branch, o.path, `origin/${o.branch}`)
}

export async function removeWorktree(repo: string, path: string, opts: { deleteBranch?: string; force?: boolean } = {}) {
  await git(repo, 'worktree', 'remove', ...(opts.force ? ['--force'] : []), path)
  if (opts.deleteBranch) await exec('git', ['-C', repo, 'branch', '-D', opts.deleteBranch])
}

export interface WorktreeInfo { path: string; branch?: string; head: string }
export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const out = await git(repo, 'worktree', 'list', '--porcelain')
  return out.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const get = (k: string) => block.split('\n').find((l) => l.startsWith(k + ' '))?.slice(k.length + 1)
    return { path: get('worktree') ?? '', head: get('HEAD') ?? '', branch: get('branch')?.replace('refs/heads/', '') }
  })
}

/** Rename the workspace branch once the task has a better name than the placeholder. */
export async function renameBranch(path: string, to: string) { await git(path, 'branch', '-m', to) }

/**
 * Current-branch workspaces start from whatever is already in the checkout.
 * `git stash create` writes a commit holding tracked changes without touching the working tree,
 * so diffs against it show only what the agent changed. Untracked files are recorded by name.
 */
export async function snapshotBaseline(repo: string): Promise<{ ref: string; untracked: string[] }> {
  const stash = (await git(repo, 'stash', 'create')).trim()
  const ref = stash || (await git(repo, 'rev-parse', 'HEAD')).trim()
  const untracked = (await git(repo, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean)
  return { ref, untracked }
}

/**
 * Files changed in a workspace. For worktrees pass the merge-base with the base branch;
 * for current-branch workspaces pass the baseline ref and the untracked list from snapshotBaseline.
 */
export async function changedFiles(path: string, since: string, ignoreUntracked: string[] = []): Promise<ChangedFile[]> {
  const files = new Map<string, ChangedFile>()
  const numstat = await git(path, 'diff', '--numstat', since)
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, d, file] = line.split('\t')
    files.set(file, { path: file, status: 'M', added: a === '-' ? 0 : Number(a), removed: d === '-' ? 0 : Number(d) })
  }
  const names = await git(path, 'diff', '--name-status', since)
  for (const line of names.split('\n').filter(Boolean)) {
    const [st, ...rest] = line.split('\t')
    const file = rest[rest.length - 1]
    const f = files.get(file)
    if (f) f.status = (st[0] as ChangedFile['status']) ?? 'M'
  }
  const skip = new Set(ignoreUntracked)
  const untracked = (await git(path, 'ls-files', '--others', '--exclude-standard')).split('\n').filter((f) => f && !skip.has(f))
  for (const file of untracked) {
    const lines = (await exec('git', ['-C', path, 'diff', '--no-index', '--numstat', '/dev/null', file])).stdout.split('\t')[0]
    files.set(file, { path: file, status: 'A', added: Number(lines) || 0, removed: 0 })
  }
  return [...files.values()].sort((x, y) => x.path.localeCompare(y.path))
}

export async function mergeBase(path: string, baseRef: string): Promise<string> {
  return (await git(path, 'merge-base', 'HEAD', baseRef)).trim()
}

export async function diffText(path: string, since: string, file?: string): Promise<string> {
  return git(path, 'diff', since, ...(file ? ['--', file] : []))
}

/** True when two worktrees changed the same file since their bases. Feeds the overlap warning on the floor. */
export function overlaps(a: ChangedFile[], b: ChangedFile[]): string[] {
  const set = new Set(a.map((f) => f.path))
  return b.filter((f) => set.has(f.path)).map((f) => f.path)
}
