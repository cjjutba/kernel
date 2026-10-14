import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { exec, git, gitSlow } from './exec'
import type { BranchCommit, ChangedFile, CompareTarget } from '@shared/types'

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

/**
 * Fill a branch pattern like "{type}/{task}-{slug}", "feat/{slug}" or a chat with Rowan's "{lead}/{slug}", cut to 60 characters.
 * `{lead}` is the Lead's name as a slug (KERNEL-405).
 */
export function branchName(pattern: string, vars: { slug: string; task?: string; type?: 'fix' | 'feat'; lead?: string }): string {
  return capBranch(pattern.replace('{type}', vars.type ?? 'feat').replace('{lead}', slugify(vars.lead ?? 'lead', 30)).replace('{slug}', vars.slug).replace('{task}', vars.task ? taskToken(vars.task) : '').replace(/\/-|-\//g, '/').replace(/-{2,}/g, '-').replace(/^[-/]+|[-/]+$/g, ''))
}

/**
 * A chat with Rowan's branch from the chat's first title (KERNEL-424): every word of it, cut only by `branchName`'s 60
 * characters. "Setup script tab Run button redundancy" -> `rowan/setup-script-tab-run-button-redundancy`.
 */
export function leadBranch(pattern: string, title: string, lead?: string): string {
  return branchName(pattern, { slug: slugify(title.replace(/['’]/g, ''), Infinity), lead })
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
 * Local branches and remote branches, newest first, for the From popover and the target branch menu. With `remote`, only that
 * remote's branches are listed; without one, every remote's, as before KERNEL-190 (KERNEL-244). `<remote>/HEAD` is left out.
 */
export async function listBranches(repo: string, remote?: string): Promise<string[]> {
  const out = await git(repo, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', remote ? `refs/remotes/${remote}` : 'refs/remotes')
  const names = out.split('\n').map((l) => l.trim()).filter((l) => l && !l.endsWith('/HEAD'))
    .map((l) => l.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, ''))
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

/**
 * Where the Lead's worktree starts (KERNEL-355): `<remote>/<default>`, else the local default branch when the remote
 * doesn't have it. Nothing for a folder that isn't a git repo or has no commit yet: that room's Lead stays on the checkout.
 * Reads the refs as they are, without fetching.
 */
export async function leadBase(repo: string, remote = 'origin'): Promise<string | undefined> {
  // Both at once: New chat's Create waits for this (KERNEL-542). A folder with no commit can't name its branch either.
  const [head, d] = await Promise.all([refExists(repo, 'HEAD'), defaultBranch(repo, remote).catch(() => undefined)])
  if (!head || !d) return undefined
  if (await refExists(repo, `${remote}/${d}`)) return `${remote}/${d}`
  return await refExists(repo, d) ? d : undefined
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0
}

/**
 * `git fetch <remote>`, with a 30 second limit. On failure: git's first line of stderr, or the timeout, and when the
 * room last fetched (FETCH_HEAD's mtime), so a caller can say how old `<remote>/<branch>` is (KERNEL-179). Git empties
 * FETCH_HEAD as a fetch starts, even one that fails, so it is read before the fetch, and an empty one (a fetch that
 * failed) gives no time. Fetch from the room's folder, not a worktree: each worktree keeps its own FETCH_HEAD.
 * With `check`, a branch name, a fetch that passed in the last minute is reused only while `<remote>/<check>` still
 * matches the remote's, read with `git ls-remote` (KERNEL-653).
 */
export function fetchOrigin(repo: string, remote = 'origin', o: { fresh?: boolean; check?: string } = {}): Promise<Fetched> {
  // Fetches that overlap share one. Two at once race for the remote's ref locks, and the loser fails. A `fresh` caller
  // needs what merged a moment ago, which a fetch already running may have missed, so it fetches again after that one.
  const key = `${repo}\n${remote}`
  const running = fetching.get(key)
  if (running && !o.fresh) return running
  // One that passed in the last minute is reused, as New chat's fetch on open is by Create (KERNEL-542).
  // A workspace being made checks the remote first, so a PR merged inside that minute is in it (KERNEL-653).
  if (!running && !o.fresh && Date.now() - (fetchedOk.get(key) ?? -Infinity) < FETCH_REUSE_MS) {
    if (!o.check) return Promise.resolve({ ok: true })
    return sameAsRemote(repo, remote, o.check).then((same) => same ? { ok: true } : fetchOrigin(repo, remote, { fresh: true }))
  }
  // A fetch that failed ends the reuse, so a later caller doesn't take the remote as reached (KERNEL-653).
  const next: Promise<Fetched> = (running ?? Promise.resolve()).catch(() => undefined).then(() => fetchNow(repo, remote))
    .then((r) => { if (r.ok) fetchedOk.set(key, Date.now()); else fetchedOk.delete(key); return r })
    .finally(() => { if (fetching.get(key) === next) fetching.delete(key) })
  fetching.set(key, next)
  return next
}
type Fetched = { ok: true } | { ok: false; error: string; lastFetch?: number }
const fetching = new Map<string, Promise<Fetched>>()
/** When each repo and remote's last fetch that passed finished. */
const fetchedOk = new Map<string, number>()
/** How long a fetch that passed is reused by a caller that isn't `fresh`. */
export const FETCH_REUSE_MS = 60_000

/** The remote's `branch` is where the last fetch left `<remote>/<branch>`. False when ls-remote fails or the remote has no such branch. */
async function sameAsRemote(repo: string, remote: string, branch: string): Promise<boolean> {
  const [there, here] = await Promise.all([
    exec('git', ['-C', repo, 'ls-remote', remote, `refs/heads/${branch}`], { timeoutMs: 10000 }),
    exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`])
  ])
  const sha = there.code === 0 ? there.stdout.trim().split(/\s/)[0] : ''
  return !!sha && here.code === 0 && here.stdout.trim() === sha
}

async function fetchNow(repo: string, remote: string): Promise<Fetched> {
  const head = await exec('git', ['-C', repo, 'rev-parse', '--git-path', 'FETCH_HEAD'])
  const lastFetch = head.code === 0 ? await stat(resolve(repo, head.stdout.trim())).then((s) => s.size > 0 ? s.mtimeMs : undefined, () => undefined) : undefined
  const r = await exec('git', ['-C', repo, 'fetch', '--quiet', remote], { timeoutMs: 30000 })
  if (r.code === 0) return { ok: true }
  const error = r.timedOut ? 'timed out after 30 seconds' : r.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? `git fetch exited with code ${r.code}`
  return { ok: false, error, ...(lastFetch === undefined ? {} : { lastFetch }) }
}

/**
 * The ref a workspace starts from: `wanted` when it exists, else the same branch without `<remote>/` locally,
 * else the default branch, `<remote>/<default>` when the remote has it. A folder with no remote and only
 * `master` gets `master` for the `origin/main` default (KERNEL-62). With `fetch`, a `<remote>/` ref fetches first,
 * through `fetchOrigin`.
 * `strict` is for a base the user picked (a PR or a branch): it throws rather than start somewhere else.
 */
export async function resolveBaseRef(repo: string, wanted: string, o: { fetch?: boolean; strict?: boolean; remote?: string } = {}): Promise<string> {
  const remote = o.remote ?? 'origin'
  if (o.fetch && wanted.startsWith(`${remote}/`)) await fetchOrigin(repo, remote)
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

/** `owner/name` from a GitHub remote URL, https or ssh. A dot in the name, a `.git` suffix and a trailing slash are fine (KERNEL-231). */
export function githubRepoOf(url: string): string | undefined {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : undefined
}

export async function remoteRepo(repo: string, remote = 'origin'): Promise<string | undefined> {
  const r = await exec('git', ['-C', repo, 'remote', 'get-url', remote])
  return r.code === 0 ? githubRepoOf(r.stdout) : undefined
}

/**
 * The folder a room's new worktrees go in. A room made since KERNEL-231 uses its id, so two rooms named "app" get two
 * folders. An older room keeps the slug of its name. Workspaces made before keep their own paths either way.
 */
export function roomWorktreeRoot(worktreeRoot: string, room: { name: string; worktreeDir?: string }): string {
  return join(worktreeRoot, room.worktreeDir ?? slugify(room.name))
}

/** Whether the repo has a commit to branch from. A fresh `git init` has none. */
export async function hasCommit(repo: string): Promise<boolean> {
  return refExists(repo, 'HEAD')
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await branchState(repo, branch)) === 'exists'
}

/**
 * Whether a local branch exists. `rev-parse --verify --quiet` exits 1 only for a missing ref; any other failure (128
 * outside a repo, 127 when git can't start) is `unknown`, which must count as neither free nor safe to delete (KERNEL-276).
 */
export async function branchState(repo: string, branch: string): Promise<'exists' | 'missing' | 'unknown'> {
  return refState(repo, `refs/heads/${branch}`)
}

async function refState(repo: string, ref: string): Promise<'exists' | 'missing' | 'unknown'> {
  const { code } = await exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref])
  return code === 0 ? 'exists' : code === 1 ? 'missing' : 'unknown'
}

/**
 * Pick a branch name that does not exist yet by appending -2, -3... A name `<remote>/<name>` has, as of the last fetch, is
 * taken too, so Kernel never picks a branch someone else already pushed (KERNEL-479), and so is a name in `taken`, which a
 * chat with Rowan holds before git makes it (KERNEL-542). Throws when git can't say whether a name is taken.
 */
export async function freeBranch(repo: string, wanted: string, remote = 'origin', taken?: ReadonlySet<string>): Promise<string> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? wanted : `${wanted}-${i}`
    if (taken?.has(name)) continue
    const local = await branchState(repo, name)
    const state = local === 'missing' ? await refState(repo, `refs/remotes/${remote}/${name}`) : local
    if (state === 'missing') return name
    if (state === 'unknown') throw new Error(`Kernel couldn't check whether the branch ${name} exists.`)
  }
}

/**
 * The branch names on `remote` as it has them now, with `git ls-remote --heads`, within `timeoutMs`. Nothing when the repo
 * has no such remote. Throws with git's first line, or the timeout, when the remote doesn't answer (KERNEL-479).
 */
export async function remoteBranches(repo: string, remote: string, timeoutMs: number): Promise<string[] | undefined> {
  if ((await exec('git', ['-C', repo, 'remote', 'get-url', remote])).code !== 0) return undefined
  // No terminal prompt: a remote that wants a password fails at once instead of waiting out the limit.
  const r = await exec('git', ['-C', repo, 'ls-remote', '--heads', remote], { timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } })
  if (r.timedOut) throw new Error(`no answer in ${Math.max(1, Math.round(timeoutMs / 1000))} seconds`)
  if (r.code !== 0) throw new Error(r.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? `git ls-remote exited with code ${r.code}`)
  return r.stdout.split('\n').flatMap((l) => { const ref = l.split('\t')[1]?.trim(); return ref?.startsWith('refs/heads/') ? [ref.slice('refs/heads/'.length)] : [] })
}

/**
 * `detach` makes no branch: the worktree's HEAD is detached at `baseRef` (the Lead's, KERNEL-355), and `branch` only names
 * the folder. `path` is a fixed folder instead of one picked under `root`.
 */
export interface CreateWorktree { repo: string; root: string; branch: string; baseRef: string; detach?: boolean; path?: string }

const FOLDER_MAX = 80

/** The folder name a branch's worktree gets when it is free: `rowan/plan-wave-3` -> `rowan-plan-wave-3`. */
export const worktreeFolder = (branch: string) => slugify(branch.replace(/\//g, '-'), FOLDER_MAX)

/**
 * A folder under `root` for `branch` that is neither on disk nor in git's worktree list: the branch slug, else the slug
 * cut short with -2, -3... Branches that share their first 80 characters, like a long branch and its `-review`, would
 * otherwise get the same folder (KERNEL-267). A folder in `taken` is held by a chat with Rowan whose worktree isn't made
 * yet (KERNEL-542).
 */
export async function freeWorktreePath(repo: string, root: string, branch: string, taken?: ReadonlySet<string>): Promise<string> {
  const stem = branch.replace(/\//g, '-')
  const registered = new Set((await listWorktrees(repo)).map((w) => w.path))
  // git may list a worktree by its real path (/private/var/... for /var/... on macOS).
  const real = await realpath(root)
  for (let i = 1; ; i++) {
    const name = i === 1 ? worktreeFolder(branch) : `${slugify(stem, FOLDER_MAX - `-${i}`.length)}-${i}`
    if (taken?.has(join(root, name))) continue
    if (!registered.has(join(root, name)) && !registered.has(join(real, name)) && await folderGone(join(root, name))) return join(root, name)
  }
}

/**
 * Moves a worktree's folder to `to` with `git worktree move`, which updates git's record of it, for a chat with Rowan whose
 * branch took its name from the chat's title (KERNEL-424). git refuses a locked worktree, one with submodules, and a `to` that
 * exists.
 */
export async function moveWorktree(repo: string, from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  await git(repo, 'worktree', 'move', from, to)
}

/**
 * Creates <root>/<branch-slug> on a new branch from baseRef (see `resolveBaseRef`). Returns the worktree path.
 * `worktree add -b` makes the branch before it checks the folder, so a failed add deletes the branch it made, never one
 * that was already there (KERNEL-276). A check git can't answer counts as "keep the branch". `--no-track` leaves the branch
 * without an upstream until its first `push -u`, so a bare `git push` can't land on the base (KERNEL-687).
 */
export async function createWorktree(o: CreateWorktree): Promise<string> {
  await mkdir(o.root, { recursive: true })
  const path = o.path ?? await freeWorktreePath(o.repo, o.root, o.branch)
  if (o.detach) { await gitSlow(o.repo, 'worktree', 'add', '--detach', path, o.baseRef); return path }
  const wasMissing = (await branchState(o.repo, o.branch)) === 'missing'
  try {
    await gitSlow(o.repo, 'worktree', 'add', '--no-track', '-b', o.branch, path, o.baseRef)
  } catch (e) {
    if (wasMissing && (await branchState(o.repo, o.branch)) === 'exists') await exec('git', ['-C', o.repo, 'branch', '-D', o.branch])
    throw e
  }
  return path
}

/**
 * The branch checked out in the git checkout holding `dir`, read from its HEAD file without running git, so the Bash guard
 * can ask in the hook (KERNEL-687). Follows a worktree's `.git` file to its own HEAD. Undefined when HEAD is detached, the
 * folder isn't in a checkout, or anything can't be read, including a reftable repo, whose HEAD names `.invalid`.
 */
export function checkedOutBranch(dir: string): string | undefined {
  try {
    for (let d = resolve(dir); ; d = dirname(d)) {
      const dotGit = join(d, '.git')
      const st = statSync(dotGit, { throwIfNoEntry: false })
      if (st) {
        const gitDir = st.isDirectory() ? dotGit : /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1].trim()
        if (!gitDir) return undefined
        const branch = /^ref: refs\/heads\/(.+)$/.exec(readFileSync(join(resolve(d, gitDir), 'HEAD'), 'utf8').trim())?.[1]
        return branch && branch !== '.invalid' ? branch : undefined
      }
      if (dirname(d) === d) return undefined
    }
  } catch {
    return undefined
  }
}

/**
 * Recreates a worktree for a branch that already exists, at `path`. Falls back to <remote>/<branch> when the
 * local branch was deleted on archive. Throws a plain message when the branch is gone everywhere.
 */
export async function restoreWorktree(o: { repo: string; path: string; branch: string; remote?: string }): Promise<void> {
  const remote = o.remote ?? 'origin'
  await mkdir(dirname(o.path), { recursive: true })
  if (await branchExists(o.repo, o.branch)) { await gitSlow(o.repo, 'worktree', 'add', o.path, o.branch); return }
  const copy = await exec('git', ['-C', o.repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${o.branch}`])
  if (copy.code !== 0) throw new Error(`The branch ${o.branch} no longer exists, so there is nothing to restore.`)
  await gitSlow(o.repo, 'worktree', 'add', '-b', o.branch, o.path, `${remote}/${o.branch}`)
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
  if (opts.deleteBranch) await dropBranch(repo, opts.deleteBranch)
}

/**
 * `removeWorktree` without the wait: the folder moves to `<parent>/.trash/<name>-<time>`, which is instant on the same
 * disk, and the caller deletes it later (KERNEL-284). `moving` gets that path before the move, so the caller can save it
 * first and a quit halfway still deletes it. Returns the path, or nothing when there was no folder to move or the move
 * failed and `git worktree remove` deleted it here. Same guards: a gone folder only prunes, an unreadable one throws, and
 * so does one that isn't this repo's worktree, the repo itself, or a locked one, whose record prune would keep.
 * `slugify` never starts a worktree folder with a dot, so `.trash` can't be one.
 */
export async function detachWorktree(repo: string, path: string, opts: { deleteBranch?: string; force?: boolean; moving?: (trash: string) => void } = {}): Promise<string | undefined> {
  let moved: string | undefined
  if (await folderGone(path)) await git(repo, 'worktree', 'prune')
  else {
    // git may list a worktree by its real path (/private/var/... for /var/... on macOS). The first entry is the repo.
    const real = await realpath(path)
    const entry = (await listWorktrees(repo)).slice(1).find((w) => w.path === path || w.path === real)
    if (!entry) throw new Error(`${path} is not a worktree of ${repo}.`)
    if (entry.locked) throw new Error(`git has locked the worktree at ${path}. Unlock it with git worktree unlock, then archive again.`)
    const trash = join(dirname(path), '.trash', `${basename(path)}-${Date.now()}`)
    opts.moving?.(trash)
    try {
      await mkdir(dirname(trash), { recursive: true })
      await rename(path, trash)
      moved = trash
    } catch {
      await git(repo, 'worktree', 'remove', ...(opts.force ? ['--force'] : []), path)
    }
    // The record points at a folder that is no longer there, so prune drops it. The folder has moved either way, so a
    // failed prune doesn't fail the archive: the next prune drops the record.
    if (moved) await exec('git', ['-C', repo, 'worktree', 'prune'])
  }
  if (opts.deleteBranch) await dropBranch(repo, opts.deleteBranch)
  return moved
}

/**
 * Whether `path` is one of `repo`'s worktrees, not the repo itself, with its folder there. git keeps listing a worktree whose
 * folder was deleted until a prune, so that one doesn't count. git may list it by its real path.
 */
export async function isWorktreeOf(repo: string, path: string): Promise<boolean> {
  if (await folderGone(path).catch(() => false)) return false
  const real = await realpath(path).catch(() => path)
  return (await listWorktrees(repo)).slice(1).some((w) => w.path === path || w.path === real)
}

/** Deletes a local branch. A failure is quiet: git refuses a branch checked out in a worktree, and that one stays. */
export async function dropBranch(repo: string, branch: string): Promise<void> {
  await exec('git', ['-C', repo, 'branch', '-D', branch])
}

export interface WorktreeInfo { path: string; branch?: string; head: string; locked?: boolean }
export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const out = await git(repo, 'worktree', 'list', '--porcelain')
  return out.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const get = (k: string) => block.split('\n').find((l) => l.startsWith(k + ' '))?.slice(k.length + 1)
    return { path: get('worktree') ?? '', head: get('HEAD') ?? '', branch: get('branch')?.replace('refs/heads/', ''), locked: block.split('\n').some((l) => l === 'locked' || l.startsWith('locked ')) }
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
  const untracked = await untrackedFiles(repo)
  return { ref, untracked }
}

/**
 * Untracked files, leaving out `.claude/worktrees/`, where Claude Code keeps its own worktrees. Repos rarely ignore
 * that folder, and we don't edit the user's .gitignore (KERNEL-350).
 */
async function untrackedFiles(path: string): Promise<string[]> {
  return (await git(path, 'ls-files', '--others', '--exclude-standard', '--', ':(top,exclude).claude/worktrees')).split('\n').filter(Boolean)
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
  for (const f of await untrackedChanges(path, ignoreUntracked)) files.set(f.path, f)
  return [...files.values()].sort((x, y) => x.path.localeCompare(y.path))
}

/** Each untracked file but those in `skip`, as all added lines. */
async function untrackedChanges(path: string, skip: string[] = []): Promise<ChangedFile[]> {
  const ignored = new Set(skip)
  const out: ChangedFile[] = []
  for (const file of (await untrackedFiles(path)).filter((f) => !ignored.has(f))) {
    const lines = (await exec('git', ['-C', path, 'diff', '--no-index', '--numstat', '/dev/null', file])).stdout.split('\t')[0]
    out.push({ path: file, status: 'A', added: Number(lines) || 0, removed: 0 })
  }
  return out
}

export async function mergeBase(path: string, baseRef: string): Promise<string> {
  return (await git(path, 'merge-base', 'HEAD', baseRef)).trim()
}

/** The diff since `since`, with every untracked file after it as all added lines, as changedFiles lists them (KERNEL-409). */
export async function diffText(path: string, since: string, file?: string): Promise<string> {
  return await git(path, 'diff', since, ...(file ? ['--', file] : [])) + await untrackedDiff(path, file)
}

/**
 * The diff of each untracked file, or of `file` alone when it is one, as all added lines. `git diff --no-index` exits 1 when
 * the files differ, so it runs through exec.
 */
async function untrackedDiff(path: string, file?: string): Promise<string> {
  let text = ''
  for (const f of (await untrackedFiles(path)).filter((f) => !file || f === file)) {
    text += (await exec('git', ['-C', path, 'diff', '--no-index', '/dev/null', f])).stdout
  }
  return text
}

/**
 * The two ends a compare target diffs (KERNEL-516): `from` and `to`, two commits, or `from` and the worktree, untracked files
 * included, when `to` is unset.
 */
export interface DiffRange { from: string; to?: string }

/** `ref` as a commit's full sha, or nothing when git finds no commit by that name. A name that starts with `-` would pass as an option. */
async function commitOf(path: string, ref: string): Promise<string | undefined> {
  if (!ref || ref.startsWith('-')) return undefined
  const r = await exec('git', ['-C', path, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.code === 0 ? r.stdout.trim() : undefined
}

/**
 * What a compare target other than the base diffs in the worktree at `path` (KERNEL-516). A branch: its merge base with HEAD,
 * or the branch itself when they share no history, to the worktree. Uncommitted: HEAD to the worktree. A commit: its first
 * parent to it, so a merge shows what it brought in, and a root commit starts from the empty tree. Throws for a branch or a
 * commit git can't find.
 */
export async function compareRange(path: string, target: Exclude<CompareTarget, { kind: 'base' }>): Promise<DiffRange> {
  if (target.kind === 'uncommitted') return { from: 'HEAD' }
  if (target.kind === 'branch') {
    const sha = await commitOf(path, target.ref)
    if (!sha) throw new Error(`Kernel can't find ${target.ref} in this repo to compare with.`)
    return { from: await mergeBase(path, sha).catch(() => sha) }
  }
  const sha = /^[0-9a-f]{4,64}$/i.test(target.sha) ? await commitOf(path, target.sha) : undefined
  if (!sha) throw new Error(`Kernel can't find the commit ${target.sha} in this repo.`)
  return { from: await commitOf(path, `${sha}^1`) ?? (await git(path, 'hash-object', '-t', 'tree', '/dev/null')).trim(), to: sha }
}

const rangeEnds = (r: DiffRange) => (r.to ? [r.from, r.to] : [r.from])

/** git's status letter as a ChangedFile's: a copy is a new file, and a type change or an unmerged path is a changed one. */
const STATUS: Record<string, ChangedFile['status']> = { A: 'A', C: 'A', D: 'D', M: 'M', R: 'R', T: 'M', U: 'M' }

/**
 * Each file's status in a range, with a renamed file's old path as `from`. With `-z`, git gives each path as it is and
 * doesn't quote one with unusual characters: the status, then the path, or the old and new paths for a rename or a copy.
 */
async function rangeNames(path: string, r: DiffRange): Promise<{ path: string; status: ChangedFile['status']; from?: string }[]> {
  const fields = (await git(path, 'diff', '--name-status', '-z', ...rangeEnds(r))).split('\0')
  const out: { path: string; status: ChangedFile['status']; from?: string }[] = []
  for (let i = 0; i < fields.length - 1; i++) {
    const st = fields[i][0]
    const from = st === 'R' || st === 'C' ? fields[++i] : undefined
    out.push({ path: fields[++i], status: STATUS[st] ?? 'M', ...(st === 'R' ? { from } : {}) })
  }
  return out
}

/**
 * The files `git diff` lists for a range, with its line counts (KERNEL-516). A rename is one row on the new path, with `from`
 * the old one. A range that ends at the worktree adds its untracked files as all added lines, as changedFiles does.
 */
export async function rangeFiles(path: string, r: DiffRange): Promise<ChangedFile[]> {
  const files = new Map<string, ChangedFile>()
  // "<added>\t<removed>\t<path>", or for a rename "<added>\t<removed>\t" with the old and new paths as the next two fields.
  const counts = (await git(path, 'diff', '--numstat', '-z', ...rangeEnds(r))).split('\0')
  for (let i = 0; i < counts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(counts[i])
    if (!m) continue
    const file = m[3] || counts[i += 2]
    files.set(file, { path: file, status: 'M', added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) })
  }
  for (const n of await rangeNames(path, r)) {
    const f = files.get(n.path)
    if (f) Object.assign(f, { status: n.status }, n.from ? { from: n.from } : {})
  }
  if (!r.to) for (const f of await untrackedChanges(path)) files.set(f.path, f)
  return [...files.values()].sort((x, y) => x.path.localeCompare(y.path))
}

/**
 * The diff of a range, or of one file in it, as `git diff` prints it (KERNEL-516). A renamed file's diff takes its old path
 * too, or git would show it as a new file. A range that ends at the worktree adds its untracked files, as diffText does.
 */
export async function rangeDiff(path: string, r: DiffRange, file?: string): Promise<string> {
  const from = file ? (await rangeNames(path, r)).find((n) => n.path === file)?.from : undefined
  const text = await git(path, 'diff', ...rangeEnds(r), ...(file ? ['--', ...(from ? [from] : []), file] : []))
  return r.to ? text : text + await untrackedDiff(path, file)
}

/** The commits `git log <base>..HEAD` lists, newest first, with their subjects, authors and author times (KERNEL-516). */
export async function branchCommits(path: string, base: string): Promise<BranchCommit[]> {
  const out = await git(path, 'log', '-z', '--no-show-signature', '--format=%H%x1f%s%x1f%an%x1f%at', `${base}..HEAD`)
  return out.split('\0').filter(Boolean).map((line) => {
    const [sha, subject, author, at] = line.split('\x1f')
    return { sha, subject, author, time: Number(at) * 1000 }
  })
}

/** An author for the commit below, which git won't make in a repo whose user has no git identity. Nothing keeps that commit. */
const SNAPSHOT_IDENTITY = { GIT_AUTHOR_NAME: 'Kernel', GIT_AUTHOR_EMAIL: 'kernel@localhost', GIT_COMMITTER_NAME: 'Kernel', GIT_COMMITTER_EMAIL: 'kernel@localhost' }

/**
 * A commit of the worktree's uncommitted tracked changes: HEAD's tree with each changed, staged or deleted file as it is on
 * disk. It is made in a copy of the index, so the real one is never locked or written. `git stash create` does both, and a
 * teammate's `git add` or `git commit` at that moment fails with "index.lock exists". The folder, the index and the stash list
 * stay as they are, and nothing refers to the commit. `HEAD` when there are no changes, or when git can't make one (unmerged
 * paths, a split index), so the caller reads the committed work either way (KERNEL-180).
 */
export async function snapshotCommit(path: string): Promise<string> {
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => exec('git', ['-C', path, ...args], { env, timeoutMs: 30000 })
  const index = await run(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  if (index.code !== 0) return 'HEAD'
  // Mid-merge or mid-rebase, `add -u` would take the conflict markers on disk for the resolved file.
  const unmerged = await run(['ls-files', '--unmerged'])
  if (unmerged.code !== 0 || unmerged.stdout.trim()) return 'HEAD'
  const copy = join(tmpdir(), `kernel-index-${randomUUID()}`)
  try {
    await copyFile(index.stdout.trim(), copy)
    const env = { ...SNAPSHOT_IDENTITY, GIT_INDEX_FILE: copy }
    if ((await run(['add', '-u'], env)).code !== 0) return 'HEAD'
    const [tree, head] = [await run(['write-tree'], env), await run(['rev-parse', 'HEAD^{tree}'])]
    if (tree.code !== 0 || head.code !== 0 || tree.stdout.trim() === head.stdout.trim()) return 'HEAD'
    const made = await run(['commit-tree', tree.stdout.trim(), '-p', 'HEAD', '-m', 'Kernel base check'], env)
    return made.code === 0 && /^[0-9a-f]{40,64}$/.test(made.stdout.trim()) ? made.stdout.trim() : 'HEAD'
  } catch { return 'HEAD' } finally { await rm(copy, { force: true }).catch(() => undefined) }
}

/** How many commits `ref` has that the worktree's HEAD hasn't. Undefined when git can't count them. */
export async function behindCount(path: string, ref: string): Promise<number | undefined> {
  const r = await exec('git', ['-C', path, 'rev-list', '--count', `HEAD..${ref}`], { timeoutMs: 30000 })
  const n = r.code === 0 ? Number(r.stdout.trim()) : NaN
  return Number.isInteger(n) ? n : undefined
}

/**
 * The files that would conflict if `theirs` were merged into `ours`, found with `git merge-tree --write-tree`, which writes
 * only objects and changes no ref or file. Empty when it merges cleanly. Undefined when git can't tell: it is older than 2.38
 * and doesn't know the option (exit 129), or it failed another way, or it named no file (KERNEL-180).
 */
export async function mergeTreeConflicts(path: string, ours: string, theirs: string): Promise<string[] | undefined> {
  const r = await exec('git', ['-C', path, 'merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], { timeoutMs: 30000 })
  if (r.code === 0) return []
  if (r.code !== 1) return undefined
  // The tree's id comes first, then each conflicted file, then a blank line and the messages `--no-messages` leaves out.
  const [, ...lines] = r.stdout.split('\n')
  const end = lines.findIndex((l) => !l.trim())
  const files = (end < 0 ? lines : lines.slice(0, end)).map((l) => l.trim())
  return files.length ? files : undefined
}

/** True when two worktrees changed the same file since their bases. Feeds the overlap warning in the Inbox. */
export function overlaps(a: ChangedFile[], b: ChangedFile[]): string[] {
  const set = new Set(a.map((f) => f.path))
  return b.filter((f) => set.has(f.path)).map((f) => f.path)
}
