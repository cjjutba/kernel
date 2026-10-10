import { mkdir, realpath, rename, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { exec, git } from './exec'
import type { ChangedFile } from '@shared/types'

/** "Export invoices as PDF" -> "export-invoices-as-pdf" (max 48 chars, no trailing dash). */
export function slugify(text: string, max = 48): string {
  const s = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (s.slice(0, max).replace(/-+$/, '') || 'workspace')
}

/** Words a branch name can do without (KERNEL-275). */
const FILLER = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'when', 'that', 'its'])

/**
 * A few words of a title for a branch: "A review can't start when the reviewed branch name is long" ->
 * "review-cant-start-reviewed-branch". Filler words go unless nothing else is left. Whole words up to `max` characters,
 * and a single longer word is cut.
 */
export function shortSlug(text: string, max = 35): string {
  const all = slugify(text.replace(/['’]/g, ''), Infinity).split('-')
  const kept = all.filter((w) => !FILLER.has(w))
  const words = kept.length ? kept : all
  let out = words[0].slice(0, max)
  for (const w of words.slice(1)) { if (out.length + 1 + w.length > max) break; out += `-${w}` }
  return out.replace(/-+$/, '') || 'workspace'
}

/** An issue key for a branch: "KERNEL-267" -> "kernel-267", "#41" -> "41". */
export const taskToken = (task: string) => task.toLowerCase().replace(/[^a-z0-9-]/g, '')

/** Cuts a branch name to `max` characters at its last `-` or `/`, with no trailing `-`, `/` or `.`. */
export function capBranch(name: string, max = 60): string {
  if (name.length <= max) return name
  const head = name.slice(0, max + 1)
  const at = Math.max(head.lastIndexOf('-'), head.lastIndexOf('/'))
  return (at > 0 ? head.slice(0, at) : name.slice(0, max)).replace(/[-/.]+$/, '')
}

/** `fix` for an issue with a label named Bug, in any case, else `feat`. */
export const branchType = (labels: string[] = []): 'fix' | 'feat' => labels.some((l) => l.toLowerCase() === 'bug') ? 'fix' : 'feat'

/** A review's branch: `review/<key>` for an issue's work, else `review/<a few words of its title>`. */
export function reviewBranch(title: string, task?: string): string {
  const key = task ? taskToken(task) : ''
  return capBranch(`review/${key || shortSlug(title)}`)
}

/** Fill a branch pattern like "{type}/{task}-{slug}" or "feat/{slug}", cut to 60 characters. */
export function branchName(pattern: string, vars: { slug: string; task?: string; type?: 'fix' | 'feat' }): string {
  return capBranch(pattern.replace('{type}', vars.type ?? 'feat').replace('{slug}', vars.slug).replace('{task}', vars.task ? taskToken(vars.task) : '').replace(/\/-|-\//g, '/').replace(/-{2,}/g, '-').replace(/[-/]+$/, ''))
}

/**
 * The branch for a task. With a task id (a Linear issue) the id leads the slug, `feat/{task}-{slug}`,
 * even when the configured pattern only has `{slug}`.
 */
export function taskBranch(pattern: string, title: string, task?: string, type?: 'fix' | 'feat'): string {
  const p = task && !pattern.includes('{task}') ? pattern.replace('{slug}', '{task}-{slug}') : pattern
  return branchName(p, { slug: shortSlug(title), task, type })
}

/** `origin/main` -> `main` for the room's remote. Any other ref comes back as it is. */
export const stripRemote = (ref: string, remote = 'origin') => (ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref)

/**
 * A base ref from Settings names the remote `origin`, since that was the only one (`origin/main`). With another remote
 * set, it means that remote's branch (KERNEL-190).
 */
export const onRemote = (ref: string, remote = 'origin') => (remote !== 'origin' && ref.startsWith('origin/') ? `${remote}/${ref.slice('origin/'.length)}` : ref)

/**
 * Local branches and the room remote's, newest first, for the From popover and the target branch menu. `<remote>/HEAD`
 * is left out.
 */
export async function listBranches(repo: string, remote = 'origin'): Promise<string[]> {
  const out = await git(repo, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', `refs/remotes/${remote}`)
  const names = out.split('\n').map((l) => l.trim()).filter((l) => l && l !== remote && !l.endsWith('/HEAD'))
  return [...new Set(names)]
}

/** Whether git accepts `name` as a branch name (`git check-ref-format --branch`). */
export async function validBranchName(repo: string, name: string): Promise<boolean> {
  return (await exec('git', ['-C', repo, 'check-ref-format', '--branch', name])).code === 0
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
}

/** `<remote>/HEAD` when it is set, else main, then master (on the remote or locally), else the current branch. */
export async function defaultBranch(repo: string, remote = 'origin'): Promise<string> {
  const r = await exec('git', ['-C', repo, 'symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])
  if (r.code === 0) return stripRemote(r.stdout.trim(), remote)
  for (const b of ['main', 'master']) if (await refExists(repo, `${remote}/${b}`) || await branchExists(repo, b)) return b
  return currentBranch(repo)
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0
}

/**
 * The ref a workspace starts from: `wanted` when it exists, else the same branch without `<remote>/` locally,
 * else the default branch, `<remote>/<default>` when the remote has it. A folder with no remote and only
 * `master` gets `master` for the `origin/main` default (KERNEL-62). With `fetch`, a `<remote>/` ref fetches first.
 * `strict` is for a base the user picked (a PR or a branch): it throws rather than start somewhere else.
 */
export async function resolveBaseRef(repo: string, wanted: string, o: { fetch?: boolean; strict?: boolean; remote?: string } = {}): Promise<string> {
  const remote = o.remote ?? 'origin'
  if (o.fetch && wanted.startsWith(`${remote}/`)) await exec('git', ['-C', repo, 'fetch', '--quiet', remote], { timeoutMs: 30000 })
  const name = stripRemote(wanted, remote)
  for (const ref of new Set([wanted, name])) if (await refExists(repo, ref)) return ref
  if (o.strict) throw new Error(`${name} is not on ${remote} or in this repo, so there is nothing to start from.`)
  const d = await defaultBranch(repo, remote)
  return await refExists(repo, `${remote}/${d}`) ? `${remote}/${d}` : d
}

/**
 * Moves the branch checked out at `path` forward to `ref`, only when that needs no merge commit and no tracked file has
 * uncommitted changes. Untracked files don't count: the fast-forward stops on its own if one is in the way. False when
 * it didn't move, and the agent is told to rebase instead (KERNEL-259).
 */
export async function fastForward(path: string, ref: string): Promise<boolean> {
  const status = await exec('git', ['-C', path, 'status', '--porcelain', '--untracked-files=no'])
  if (status.code !== 0 || status.stdout.trim()) return false
  return (await exec('git', ['-C', path, 'merge', '--ff-only', '--quiet', ref])).code === 0
}

export async function remoteRepo(repo: string, remote = 'origin'): Promise<string | undefined> {
  const r = await exec('git', ['-C', repo, 'remote', 'get-url', remote])
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

/**
 * A folder under `root` for `branch` that is neither on disk nor in git's worktree list: the branch slug, else the slug
 * cut short with -2, -3... Branches that share their first 80 characters, like a long branch and its `-review`, would
 * otherwise get the same folder (KERNEL-267).
 */
export async function freeWorktreePath(repo: string, root: string, branch: string): Promise<string> {
  const max = 80
  const stem = branch.replace(/\//g, '-')
  const registered = new Set((await listWorktrees(repo)).map((w) => w.path))
  // git may list a worktree by its real path (/private/var/... for /var/... on macOS).
  const real = await realpath(root)
  for (let i = 1; ; i++) {
    const name = i === 1 ? slugify(stem, max) : `${slugify(stem, max - `-${i}`.length)}-${i}`
    if (!registered.has(join(root, name)) && !registered.has(join(real, name)) && await folderGone(join(root, name))) return join(root, name)
  }
}

/** Creates <root>/<branch-slug> on a new branch from baseRef (see `resolveBaseRef`). Returns the worktree path. */
export async function createWorktree(o: CreateWorktree): Promise<string> {
  await mkdir(o.root, { recursive: true })
  const path = await freeWorktreePath(o.repo, o.root, o.branch)
  await git(o.repo, 'worktree', 'add', '-b', o.branch, path, o.baseRef)
  return path
}

/**
 * Recreates a worktree for a branch that already exists, at `path`. Falls back to <remote>/<branch> when the
 * local branch was deleted on archive. Throws a plain message when the branch is gone everywhere.
 */
export async function restoreWorktree(o: { repo: string; path: string; branch: string; remote?: string }): Promise<void> {
  const remote = o.remote ?? 'origin'
  await mkdir(dirname(o.path), { recursive: true })
  if (await branchExists(o.repo, o.branch)) { await git(o.repo, 'worktree', 'add', o.path, o.branch); return }
  const copy = await exec('git', ['-C', o.repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${o.branch}`])
  if (copy.code !== 0) throw new Error(`The branch ${o.branch} no longer exists, so there is nothing to restore.`)
  await git(o.repo, 'worktree', 'add', '-b', o.branch, o.path, `${remote}/${o.branch}`)
}

/**
 * Whether the folder at `path` no longer exists. Only ENOENT says so: a folder Kernel can't read (EACCES) may still hold
 * files, so any other error is thrown (KERNEL-109).
 */
export async function folderGone(path: string): Promise<boolean> {
  try {
    await stat(path)
    return false
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw e
  }
}

/**
 * A folder that is already gone counts as removed: git only needs its record pruned (KERNEL-109). A folder that exists
 * but isn't a worktree still throws, since it may hold the user's files, and so does one that can't be read.
 */
export async function removeWorktree(repo: string, path: string, opts: { deleteBranch?: string; force?: boolean } = {}) {
  if (await folderGone(path)) await git(repo, 'worktree', 'prune')
  else await git(repo, 'worktree', 'remove', ...(opts.force ? ['--force'] : []), path)
  if (opts.deleteBranch) await exec('git', ['-C', repo, 'branch', '-D', opts.deleteBranch])
}

/**
 * `removeWorktree` without the wait: the folder moves to `<parent>/.trash/<name>-<time>`, which is instant on the same
 * disk, and the caller deletes it later (KERNEL-284). Returns that path, or nothing when there was no folder to move or
 * the move failed and `git worktree remove` deleted it here. Same guards: a gone folder only prunes, an unreadable one
 * throws, and so does one that isn't this repo's worktree or is the repo itself. `slugify` never starts a worktree
 * folder with a dot, so `.trash` can't be one.
 */
export async function detachWorktree(repo: string, path: string, opts: { deleteBranch?: string; force?: boolean } = {}): Promise<string | undefined> {
  let moved: string | undefined
  if (await folderGone(path)) await git(repo, 'worktree', 'prune')
  else {
    // git may list a worktree by its real path (/private/var/... for /var/... on macOS). The first entry is the repo.
    const real = await realpath(path)
    if (!(await listWorktrees(repo)).slice(1).some((w) => w.path === path || w.path === real)) throw new Error(`${path} is not a worktree of ${repo}.`)
    const trash = join(dirname(path), '.trash', `${basename(path)}-${Date.now()}`)
    try {
      await mkdir(dirname(trash), { recursive: true })
      await rename(path, trash)
      moved = trash
    } catch {
      await git(repo, 'worktree', 'remove', ...(opts.force ? ['--force'] : []), path)
    }
    // The record points at a folder that is no longer there, so prune drops it.
    if (moved) await git(repo, 'worktree', 'prune')
  }
  if (opts.deleteBranch) await exec('git', ['-C', repo, 'branch', '-D', opts.deleteBranch])
  return moved
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
