import { stat } from 'node:fs/promises'
import type { DiffStat, LocalMerge, MergeMethod } from '@shared/types'
import { exec, type ExecResult, SLOW_MS } from './exec'
import { MIN_GIT } from './preflight'
import { tildify } from './projects'
import { listWorktrees } from './worktrees'

// A project with no GitHub merges its branches on the Mac (KERNEL-467). Reading and preparing a merge only writes git objects,
// which nothing refers to until `land` moves the base branch with a compare-and-swap and brings along the folder that has it
// checked out. Nothing here touches a file with uncommitted changes.

/** Why a local merge didn't happen. In each case the base branch and every folder are as they were. */
export type Refusal = 'empty' | 'conflict' | 'dirty' | 'moved'

export class LocalMergeError extends Error {
  constructor(readonly reason: Refusal, message: string, readonly files: string[] = []) { super(message) }
}

/** What git says about merging `branch` into `base`, before anything moves. `tree` is what a merge of the two holds. */
export interface LocalStatus {
  /** The local branch the work merges into. */
  base: string
  baseSha: string
  head: string
  ahead: number
  behind: number
  tree: string
  conflicts: string[]
  stat: DiffStat
  checkout?: NonNullable<LocalMerge['checkout']>
}

/** A merge commit made and not landed yet: `land` moves `base` from `from` to `to`. */
export interface Prepared { repo: string; branch: string; base: string; method: MergeMethod; from: string; to: string }

const MS = 60_000

/** Who git names on the stand-in commits a rebase makes, which nothing keeps, so a repo with no git identity can still rebase. */
const STAND_IN = { GIT_AUTHOR_NAME: 'Kernel', GIT_AUTHOR_EMAIL: 'kernel@localhost', GIT_COMMITTER_NAME: 'Kernel', GIT_COMMITTER_EMAIL: 'kernel@localhost' }

const failure = (r: ExecResult) => r.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? r.stdout.trim().split('\n')[0] ?? `git exited with code ${r.code}`

async function git(repo: string, args: string[], o: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): Promise<string> {
  const r = await exec('git', ['-C', repo, ...args], { timeoutMs: MS, ...o })
  if (r.code !== 0) throw new Error(r.timedOut ? `git ${args[0]} didn't finish in time.` : failure(r))
  return r.stdout
}

const shaOf = async (repo: string, ref: string) => {
  const r = await exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeoutMs: MS })
  return r.code === 0 ? r.stdout.trim() : undefined
}

/** "a", "a and b", "a, b, c and 2 more". */
function named(files: string[], max = 5): string {
  if (files.length <= max) return files.length > 1 ? `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}` : files[0] ?? ''
  return `${files.slice(0, max).join(', ')} and ${files.length - max} more`
}

const count = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`

/**
 * The branch in this repo that `baseRef` names. A workspace's base can be `origin/main` in a project whose remote isn't on
 * GitHub, and a local merge goes into `main`, never into a remote's ref.
 */
export async function localBase(repo: string, baseRef: string): Promise<string> {
  if (await shaOf(repo, `refs/heads/${baseRef}`)) return baseRef
  const slash = baseRef.indexOf('/')
  const name = slash > 0 && await shaOf(repo, `refs/remotes/${baseRef}`) ? baseRef.slice(slash + 1) : undefined
  if (name && await shaOf(repo, `refs/heads/${name}`)) return name
  throw new Error(`Kernel merges into a branch in this repo, and ${baseRef} isn't one.`)
}

/**
 * `git merge-tree --write-tree` (git 2.38): the merged tree and the files that conflict. It writes objects only, and changes
 * no ref, index or file.
 */
async function mergeTree(repo: string, ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] }> {
  const r = await exec('git', ['-C', repo, 'merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], { timeoutMs: MS })
  if (r.code === 129) throw new Error(`Merging on this Mac needs git ${MIN_GIT} or later.`)
  if (r.code !== 0 && r.code !== 1) throw new Error(failure(r))
  // The tree's id comes first, then each conflicted file once, then a blank line before the messages `--no-messages` drops.
  const [tree, ...lines] = r.stdout.split('\n')
  const end = lines.findIndex((l) => !l.trim())
  const conflicts = r.code === 1 ? (end < 0 ? lines : lines.slice(0, end)).map((l) => l.trim()).filter(Boolean) : []
  if (r.code === 1 && !conflicts.length) throw new Error('git found a conflict and named no file.')
  return { tree: tree.trim(), conflicts }
}

/** The files a merge writes: those that differ between the base and the merged tree or commit. */
async function written(repo: string, from: string, to: string): Promise<string[]> {
  return (await git(repo, ['diff', '--name-only', '--no-renames', '-z', from, to])).split('\0').filter(Boolean)
}

/**
 * The tracked files in `path` with uncommitted changes, and its untracked files where the merge writes, with git's status
 * letters. Untracked files elsewhere don't count, as for `fastForward` in worktrees.ts: the merge would leave them be.
 * `--no-optional-locks` keeps a poll from taking the index lock while the user runs git there.
 */
async function dirtyFiles(path: string, writes: string[]): Promise<{ status: string; path: string }[]> {
  const out = await git(path, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  const entries = out.split('\0')
  const files: { status: string; path: string }[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    const status = e.slice(0, 2), file = e.slice(3)
    // A rename or copy names its source next.
    if (status[0] === 'R' || status[0] === 'C') i++
    // An untracked folder shows once, with a slash, for every file under it.
    if (status === '??') { if (writes.some((w) => w === file || (file.endsWith('/') && w.startsWith(file)))) files.push({ status, path: file }); continue }
    files.push({ status: status.trim(), path: file })
  }
  return files
}

/** The folder with `base` checked out, if one still exists, and what in it would stop a merge from `from` to `to`. */
async function baseCheckout(repo: string, base: string, from: string, to: string): Promise<LocalStatus['checkout']> {
  const at = (await listWorktrees(repo)).find((w) => w.branch === base)
  if (!at || !(await stat(at.path).then((s) => s.isDirectory(), () => false))) return undefined
  return { path: at.path, dirty: await dirtyFiles(at.path, await written(repo, from, to)) }
}

/** Ahead and behind, conflicts, the diff stat and the base's checkout, for `branch` merging into `baseRef`. */
export async function localStatus(repo: string, branch: string, baseRef: string): Promise<LocalStatus> {
  const base = await localBase(repo, baseRef)
  const [baseSha, head] = await Promise.all([shaOf(repo, `refs/heads/${base}`), shaOf(repo, `refs/heads/${branch}`)])
  if (!baseSha) throw new Error(`${base} isn't a branch in this repo.`)
  if (!head) throw new Error(`${branch} isn't a branch in this repo.`)
  const [behind, ahead] = (await git(repo, ['rev-list', '--left-right', '--count', `${baseSha}...${head}`])).trim().split(/\s+/).map(Number)
  const { tree, conflicts } = await mergeTree(repo, baseSha, head)
  // What the branch changed since it left the base, as the Changes tab counts it.
  const stat: DiffStat = { files: 0, added: 0, removed: 0 }
  for (const line of (await git(repo, ['diff', '--numstat', `${baseSha}...${head}`])).split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t')
    stat.files++
    stat.added += a === '-' ? 0 : Number(a)
    stat.removed += d === '-' ? 0 : Number(d)
  }
  const checkout = await baseCheckout(repo, base, baseSha, tree)
  return { base, baseSha, head, ahead, behind, tree, conflicts, stat, ...(checkout ? { checkout } : {}) }
}

/**
 * A new commit of `tree` on `parents`. The message goes through stdin, so it keeps its lines, and ends in one newline, as
 * `git commit` leaves it: `%B` adds one of its own, and commit-tree keeps whatever it is given.
 */
async function commitTree(repo: string, tree: string, parents: string[], message: string, env: NodeJS.ProcessEnv = {}, sign = true): Promise<string> {
  return (await git(repo, ['commit-tree', ...(sign ? [] : ['--no-gpg-sign']), tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], { env, input: `${message.trimEnd()}\n` })).trim()
}

/** The branch's own commits since the base, oldest first. Merge commits are left out, as `git rebase` leaves them out. */
async function ownCommits(repo: string, s: LocalStatus): Promise<string[]> {
  return (await git(repo, ['rev-list', '--reverse', '--no-merges', `${s.baseSha}..${s.head}`])).split('\n').filter(Boolean)
}

/** One commit's message as is. With many, GitHub's squash message: the title, then each commit's subject. */
async function squashMessage(repo: string, s: LocalStatus, branch: string, title?: string): Promise<string> {
  const commits = await ownCommits(repo, s)
  if (commits.length === 1) return git(repo, ['log', '-1', '--format=%B', commits[0]])
  const subjects = commits.length ? (await git(repo, ['log', '--reverse', '--no-merges', '--format=%s', `${s.baseSha}..${s.head}`])).split('\n').filter(Boolean) : []
  return `${title || branch}\n${subjects.length ? `\n${subjects.map((x) => `* ${x}`).join('\n')}\n` : ''}`
}

/**
 * The branch's commits replayed onto the base, one commit-tree each, keeping their authors and messages. A commit whose
 * parent is already the tip is kept as it is, so a branch that is not behind fast-forwards. One that brings nothing new is
 * dropped. Git 2.38's merge-tree picks the merge base itself, so each step merges the commit with a stand-in for the tip
 * whose parent is the commit's parent: their merge base is that parent, which makes the merge a cherry-pick.
 */
async function replay(repo: string, s: LocalStatus): Promise<string> {
  let tip = s.baseSha
  for (const c of await ownCommits(repo, s)) {
    const parent = (await git(repo, ['rev-parse', `${c}^`])).trim()
    if (parent === tip) { tip = c; continue }
    const tipTree = (await git(repo, ['rev-parse', `${tip}^{tree}`])).trim()
    const standIn = await commitTree(repo, tipTree, [parent], 'Kernel rebase step', STAND_IN, false)
    const m = await mergeTree(repo, standIn, c)
    if (m.conflicts.length) {
      const subject = (await git(repo, ['log', '-1', '--format=%s', c])).trim()
      throw new LocalMergeError('conflict', `Rebasing onto ${s.base} would conflict at ${c.slice(0, 7)} (${subject}) in ${named(m.conflicts)}. Nothing was merged.`, m.conflicts)
    }
    if (m.tree === tipTree) continue
    const [name, email, date] = (await git(repo, ['log', '-1', '--date=raw', '--format=%an%x00%ae%x00%ad', c])).trim().split('\0')
    const message = await git(repo, ['log', '-1', '--format=%B', c])
    tip = await commitTree(repo, m.tree, [tip], message, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date })
  }
  if (tip === s.baseSha) throw new LocalMergeError('empty', `Everything on this branch is already in ${s.base}, so there is nothing to merge.`)
  return tip
}

/**
 * The commit that `branch` merging into `baseRef` leaves on the base, made with the project's method and not landed. It refuses
 * a branch with nothing to merge and one that conflicts. A branch that is behind merges when nothing conflicts, as GitHub
 * merges one when the repo doesn't require it to be up to date.
 */
export async function prepareMerge(o: { repo: string; branch: string; base: string; method: MergeMethod; title?: string }): Promise<Prepared> {
  const s = await localStatus(o.repo, o.branch, o.base)
  if (!s.ahead) throw new LocalMergeError('empty', `${o.branch} has no commits that ${s.base} doesn't, so there is nothing to merge.`)
  if (s.conflicts.length) throw new LocalMergeError('conflict', `Merging into ${s.base} would conflict in ${count(s.conflicts.length)}: ${named(s.conflicts)}. Nothing was merged.`, s.conflicts)
  const to = o.method === 'rebase' ? await replay(o.repo, s)
    : o.method === 'merge' ? await commitTree(o.repo, s.tree, [s.baseSha, s.head], `Merge branch '${o.branch}' into ${s.base}\n${o.title ? `\n${o.title}\n` : ''}`)
    : await commitTree(o.repo, s.tree, [s.baseSha], await squashMessage(o.repo, s, o.branch, o.title))
  return { repo: o.repo, branch: o.branch, base: s.base, method: o.method, from: s.baseSha, to }
}

/**
 * Moves the base branch to the prepared commit. A folder with the base checked out has to be clean first, and Kernel never
 * stashes or commits for the user. `update-ref` swaps the branch only if it still points where the merge started, so a commit
 * made there meanwhile is never lost. The folder then moves the way `git merge --ff-only` would move it. If a file there
 * changed in between and git won't move it, the branch goes back, so the folder and the branch agree again.
 */
export async function land(p: Prepared): Promise<void> {
  const checkout = await baseCheckout(p.repo, p.base, p.from, p.to)
  const where = checkout ? `The ${p.base} checkout at ${tildify(checkout.path)}` : ''
  if (checkout?.dirty.length) {
    const files = checkout.dirty.map((f) => f.path)
    throw new LocalMergeError('dirty', `${where} has uncommitted changes, so nothing was merged. Commit or stash ${named(files)} there, then try again.`, files)
  }
  if (checkout) await exec('git', ['-C', checkout.path, 'update-index', '-q', '--refresh'], { timeoutMs: MS })
  const swap = await exec('git', ['-C', p.repo, 'update-ref', '-m', `kernel: ${p.method} ${p.branch}`, `refs/heads/${p.base}`, p.to, p.from], { timeoutMs: MS })
  if (swap.code !== 0) {
    if (await shaOf(p.repo, `refs/heads/${p.base}`) !== p.from) throw new LocalMergeError('moved', `${p.base} moved while Kernel was merging, so nothing was merged. Try again.`)
    throw new Error(failure(swap))
  }
  if (!checkout) return
  // A folder switched to another branch meanwhile has nothing to move.
  const head = await exec('git', ['-C', checkout.path, 'symbolic-ref', '-q', 'HEAD'], { timeoutMs: MS })
  if (head.stdout.trim() !== `refs/heads/${p.base}`) return
  const moved = await exec('git', ['-C', checkout.path, 'read-tree', '-u', '-m', p.from, p.to], { timeoutMs: SLOW_MS })
  if (moved.code === 0) return
  const undo = await exec('git', ['-C', p.repo, 'update-ref', '-m', `kernel: undo ${p.method} ${p.branch}`, `refs/heads/${p.base}`, p.from, p.to], { timeoutMs: MS })
  if (undo.code !== 0) throw new Error(`${where} couldn't follow ${p.base} to the merge (${failure(moved)}), and ${p.base} has moved again since. Check that folder with git status.`)
  throw new LocalMergeError('dirty', `${where} changed while Kernel was merging, so nothing was merged (${failure(moved)}). Try again.`)
}

/** Merges `branch` into `base` on the Mac. The commit it left on the base, and the base's name. */
export async function localMerge(o: Parameters<typeof prepareMerge>[0]): Promise<{ sha: string; base: string }> {
  const p = await prepareMerge(o)
  await land(p)
  return { sha: p.to, base: p.base }
}
