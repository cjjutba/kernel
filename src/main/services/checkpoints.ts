import { copyFile, mkdtemp, readdir, rm, rmdir, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ChangedFile, Checkpoint, DiffStat } from '@shared/types'
import { exec, run, SLOW_MS } from './exec'
import { freeBranch } from './worktrees'

/**
 * Checkpoints (KERNEL-13). After every agent turn the worktree is saved as a commit under a hidden ref,
 * `refs/kernel/checkpoints/<workspace>/<turn>`. Saving goes through a throwaway index, so the real index, HEAD
 * and the files the agent sees never change. Untracked files are included; ignored files are not.
 *
 * What the drawer lists lives in the checkpoint commits themselves (trailers in the message), so the list is one
 * `for-each-ref` and survives restarts. `refs/kernel/checkpoint-head/<workspace>` points at the checkpoint the
 * worktree is at now: the newest one, or the one last reverted to.
 *
 * Each checkpoint also records its base, where HEAD meets the workspace's remote base, so a turn's files leave out what only
 * arrived from that base since the last checkpoint (KERNEL-603).
 */

/** The parts of a workspace checkpoints need. `baseRef` is the base it started from, as the workspace has it. */
export interface CheckpointWorkspace { id: string; name: string; path: string; baseRef?: string }

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const GITLINK = '160000'
/** commit-tree needs an identity; a repo without user.name must still get checkpoints. */
const IDENTITY = { GIT_AUTHOR_NAME: 'Kernel', GIT_AUTHOR_EMAIL: 'kernel@localhost', GIT_COMMITTER_NAME: 'Kernel', GIT_COMMITTER_EMAIL: 'kernel@localhost' }

export const checkpointRef = (workspaceId: string, turn: number) => `refs/kernel/checkpoints/${workspaceId}/${turn}`
const headRef = (workspaceId: string) => `refs/kernel/checkpoint-head/${workspaceId}`

/** A checkpoint hashes every file in the worktree, which in a big one takes longer than `exec`'s minute. */
const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string) => run('git', ['-C', cwd, ...args], { env, input, timeoutMs: SLOW_MS })

/** One git operation at a time per workspace, so two chats ending together do not race for the same turn number. */
const locks = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  locks.set(key, next)
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key) }).catch(() => undefined)
  return next
}

async function revParse(cwd: string, rev: string): Promise<string | undefined> {
  const r = await exec('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', rev])
  return r.code === 0 ? r.stdout.trim() : undefined
}

/** Run `fn` with GIT_INDEX_FILE pointing at a throwaway index, seeded from the real index or from a tree. */
async function withTempIndex<T>(cwd: string, seed: { index: true } | { tree: string } | { empty: true }, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-cp-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    if ('index' in seed) {
      // A copy of the real index carries its stat cache, so `git add -A` only rehashes files that changed.
      // The copy keeps the real index's mtime: git's racy-clean check compares file mtimes with it, and a newer
      // copy would make git trust stale stat entries and miss a same-size edit made in the same second.
      const real = resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', 'index'])).trim())
      const copied = await copyFile(real, env.GIT_INDEX_FILE).then(() => true, () => false)
      if (copied) { const s = await stat(real); await utimes(env.GIT_INDEX_FILE, s.atime, s.mtime) }
    } else if ('tree' in seed) {
      await git(cwd, ['read-tree', seed.tree], env)
    }
    return await fn(env)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The tree of the worktree as it is on disk, tracked and untracked files alike, without touching the real index. */
export async function worktreeTree(cwd: string): Promise<string> {
  const write = (env: NodeJS.ProcessEnv) => git(cwd, ['add', '-A'], env).then(() => git(cwd, ['write-tree'], env)).then((s) => s.trim())
  // A split or sparse index does not survive being copied; a fresh index is slower but always works.
  try { return await withTempIndex(cwd, { index: true }, write) } catch { return withTempIndex(cwd, { empty: true }, write) }
}

/** A file's row, with the mode and blob it had on each side: `000000 000…` on the side it wasn't on. */
interface DiffRow extends ChangedFile { was: string; now: string }

/**
 * What changed between two trees, a row per file with its status and line counts (KERNEL-584). `paths` limits it to those files,
 * and `counts: false` skips the line counts.
 */
async function treeDiff(cwd: string, from: string, to: string, o: { paths?: string[]; counts?: boolean } = {}): Promise<DiffRow[]> {
  // With -z, git prints every file's raw entry (`:modes shas status`, then the path) and then every file's numstat line.
  const counts = o.counts === false ? [] : ['--numstat']
  const fields = (await git(cwd, ['--literal-pathspecs', 'diff-tree', '-r', '-z', '--no-renames', '--raw', ...counts, from, to, ...(o.paths ? ['--', ...o.paths] : [])])).split('\0')
  const files = new Map<string, DiffRow>()
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].startsWith(':')) {
      const [srcMode, dstMode, src, dst, status] = fields[i].slice(1).split(' ')
      const path = fields[++i]
      // A file that changed type, as into a symlink, reads as modified.
      files.set(path, { path, status: status === 'A' || status === 'D' ? status : 'M', added: 0, removed: 0, was: `${srcMode} ${src}`, now: `${dstMode} ${dst}` })
      continue
    }
    // A binary file's counts are `-`, and count as 0.
    const m = /^([\d-]+)\t([\d-]+)\t(.*)$/s.exec(fields[i])
    const file = m && files.get(m[3])
    if (file) { file.added = Number(m[1]) || 0; file.removed = Number(m[2]) || 0 }
  }
  return [...files.values()]
}

/**
 * The remote-tracking ref of a workspace's base: `baseRef` when it is on a remote, else the upstream of the local branch it
 * names. A local branch never counts by itself, since a current-branch chat may commit to it. None without a remote or once
 * the ref is gone, and then turns list every change, as before (KERNEL-603).
 */
async function remoteBase(cwd: string, baseRef?: string): Promise<string | undefined> {
  if (!baseRef) return undefined
  for (const rev of [baseRef, `${baseRef}@{upstream}`]) {
    const r = await exec('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', '--symbolic-full-name', rev])
    if (r.code === 0 && r.stdout.trim().startsWith('refs/remotes/')) return r.stdout.trim()
  }
}

/** Where `rev`'s history meets the remote base: the checkpoint's base. */
async function baseOf(cwd: string, ref: string, rev: string): Promise<string | undefined> {
  const r = await exec('git', ['-C', cwd, 'merge-base', rev, ref])
  return r.code === 0 ? r.stdout.trim().split('\n')[0] || undefined : undefined
}

/**
 * The files a turn changed, without what only arrived from the base (KERNEL-603). When the base moved forward between the two
 * checkpoints, as when Kernel fast-forwards the worktree or the agent pulls, rebases or merges, a file that held the old base's
 * content then and holds the new base's now came from the remote, and goes. Every other file stays, and one the base changed
 * too is counted against the new base. The agent's edits and its unpushed commits differ from the new base, so they stay.
 */
async function turnDiff(cwd: string, from: string, to: string, was?: string, now?: string): Promise<ChangedFile[]> {
  let rows = await treeDiff(cwd, from, to)
  if (rows.length && was && now && was !== now) {
    // A base git can't read any more lists the whole turn, as before.
    rows = await withoutBase(cwd, rows, was, now, to).catch(() => rows)
  }
  return rows.map(({ path, status, added, removed }) => ({ path, status, added, removed }))
}

async function withoutBase(cwd: string, rows: DiffRow[], was: string, now: string, to: string): Promise<DiffRow[]> {
  // A base that moved back or sideways, as after a reset or a rewritten main, brought nothing new, so the turn stays whole.
  if ((await exec('git', ['-C', cwd, 'merge-base', '--is-ancestor', was, now])).code !== 0) return rows
  const moved = new Map((await treeDiff(cwd, was, now, { counts: false })).map((b) => [b.path, b]))
  const kept = rows.filter((r) => { const b = moved.get(r.path); return !b || r.was !== b.was || r.now !== b.now })
  const recount = kept.filter((r) => { const b = moved.get(r.path); return b && r.now !== b.now }).map((r) => r.path)
  if (!recount.length) return kept
  const against = new Map((await treeDiff(cwd, now, to, { paths: recount })).map((r) => [r.path, r]))
  return kept.map((r) => against.get(r.path) ?? r)
}

const statOf = (files: ChangedFile[]): DiffStat => ({ files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) })

interface Stored { sha: string; turn: number; base?: string; checkpoint: Checkpoint }

function trailer(body: string, key: string): string | undefined {
  return new RegExp(`^${key}: (.*)$`, 'm').exec(body)?.[1]?.trim()
}

async function readAll(ws: CheckpointWorkspace): Promise<Stored[]> {
  const out = await git(ws.path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(contents)%00', `refs/kernel/checkpoints/${ws.id}/`])
  const parts = out.split('\0')
  const list: Stored[] = []
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const ref = parts[i].trim()
    const sha = parts[i + 1]
    const body = parts[i + 2]
    const turn = Number(ref.split('/').pop())
    if (!Number.isInteger(turn)) continue
    const [files, added, removed] = (trailer(body, 'Kernel-Stat') ?? '0 0 0').split(' ').map(Number)
    list.push({
      sha, turn, base: trailer(body, 'Kernel-Base'),
      checkpoint: {
        id: String(turn), workspaceId: ws.id, chatId: trailer(body, 'Kernel-Chat') ?? '', ts: Number(trailer(body, 'Kernel-Time')) || 0,
        title: body.split('\n')[0] ?? '', stat: { files: files || 0, added: added || 0, removed: removed || 0 }, ref,
        current: false, ...(trailer(body, 'Kernel-Start') === 'true' ? { start: true } : {})
      }
    })
  }
  return list.sort((a, b) => b.turn - a.turn)
}

/** Checkpoints of a workspace, newest first, with `current` on the one the worktree is at now. */
export async function listCheckpoints(ws: CheckpointWorkspace): Promise<Checkpoint[]> {
  const [all, head] = await Promise.all([readAll(ws), revParse(ws.path, headRef(ws.id))])
  return all.map((c) => ({ ...c.checkpoint, current: c.sha === head }))
}

/** First line of a prompt, trimmed for the drawer. */
export function checkpointTitle(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line
}

/**
 * Save the worktree as the next checkpoint. `start` marks the one taken before the first turn ("start of chat").
 * The stat is what changed since the current checkpoint, or since HEAD for the first one.
 */
export function snapshot(ws: CheckpointWorkspace, o: { chatId: string; title: string; start?: boolean; ts?: number }): Promise<Checkpoint> {
  return snapshotWithFiles(ws, o).then((s) => s.checkpoint)
}

/**
 * A snapshot and the files it changed, the rows its stat counts. The start checkpoint has none (KERNEL-584). Files that only
 * arrived from the workspace's base since the last checkpoint aren't the turn's, and are left out (KERNEL-603).
 */
export function snapshotWithFiles(ws: CheckpointWorkspace, o: { chatId: string; title: string; start?: boolean; ts?: number }): Promise<{ checkpoint: Checkpoint; files: ChangedFile[] }> {
  return serial(ws.id, async () => {
    const tree = await worktreeTree(ws.path)
    const all = await readAll(ws)
    const turn = all.length ? all[0].turn + 1 : 0
    const start = !!o.start && turn === 0
    const prev = await revParse(ws.path, headRef(ws.id))
    const head = await revParse(ws.path, 'HEAD^{commit}')
    const from = prev ? `${prev}^{tree}` : head ? `${head}^{tree}` : EMPTY_TREE
    const remote = await remoteBase(ws.path, ws.baseRef)
    const base = remote && head ? await baseOf(ws.path, remote, head) : undefined
    // A checkpoint saved before bases were recorded meets the base where the first checkpoint did. That base may be older,
    // and leaves out less.
    const was = prev && remote ? all.find((c) => c.sha === prev)?.base ?? await baseOf(ws.path, remote, prev) : base
    const files = start ? [] : await turnDiff(ws.path, from, tree, was, base)
    const stat = statOf(files)
    const ts = o.ts ?? Date.now()
    const title = checkpointTitle(o.title) || `Turn ${turn}`
    const message = [title, '', `Kernel-Chat: ${o.chatId}`, `Kernel-Turn: ${turn}`, `Kernel-Time: ${ts}`, `Kernel-Stat: ${stat.files} ${stat.added} ${stat.removed}`, ...(base ? [`Kernel-Base: ${base}`] : []), ...(start ? ['Kernel-Start: true'] : [])].join('\n') + '\n'
    const parent = prev ?? head
    const sha = (await git(ws.path, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], IDENTITY, message)).trim()
    const ref = checkpointRef(ws.id, turn)
    await git(ws.path, ['update-ref', ref, sha])
    await git(ws.path, ['update-ref', headRef(ws.id), sha])
    return { checkpoint: { id: String(turn), workspaceId: ws.id, chatId: o.chatId, ts, title, stat, ref, current: true, ...(start ? { start: true } : {}) }, files }
  })
}

/**
 * Deletes every checkpoint ref of a workspace: its turns and its head (KERNEL-333). Run it in the main repo, since refs live
 * there and the worktree folder is gone. `kernel/backup/*` branches that Revert made are the user's, and stay. The commits
 * are unreachable afterwards and git collects them in its own time. Returns how many refs went.
 */
export async function dropCheckpoints(repo: string, workspaceId: string): Promise<number> {
  // An id that isn't a plain id would widen the patterns below to other workspaces' refs.
  if (!/^[A-Za-z0-9-]+$/.test(workspaceId)) return 0
  const refs = (await git(repo, ['for-each-ref', '--format=delete %(refname)', `refs/kernel/checkpoints/${workspaceId}/`, headRef(workspaceId)])).trim()
  if (!refs) return 0
  await git(repo, ['update-ref', '--stdin'], undefined, refs + '\n')
  return refs.split('\n').length
}

const pad = (n: number) => String(n).padStart(2, '0')
/** 10:24, the time the drawer and the revert note show. */
export const clock = (ts: number) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

export interface Reverted { checkpoint: Checkpoint; backupBranch: string; restored: string[]; removed: string[] }

/** Remove a file, then any folders it leaves empty, up to the worktree root. */
async function removeFile(root: string, path: string) {
  const full = join(root, path)
  await rm(full, { force: true })
  for (let dir = dirname(full); dir.startsWith(root) && dir !== root; dir = dirname(dir)) {
    if ((await readdir(dir).catch(() => ['x'])).length) break
    await rmdir(dir).catch(() => undefined)
  }
}

/**
 * Put the worktree's files back the way they were at a checkpoint. The current state is saved first on a new branch,
 * `kernel/backup/<workspace>-<time>`. Only paths that differ between now and the checkpoint are written or removed;
 * HEAD, the real index and ignored files are left alone. Every checkpoint is taken after the workspace started, so
 * changes that were in a current-branch checkout before then (the baseline) are in every checkpoint and survive.
 */
export function revertTo(ws: CheckpointWorkspace, checkpointId: string, o: { now?: Date } = {}): Promise<Reverted> {
  return serial(ws.id, async () => {
    const target = (await readAll(ws)).find((c) => c.checkpoint.id === checkpointId)
    if (!target) throw new Error('That checkpoint no longer exists.')
    const now = await worktreeTree(ws.path)
    const head = await revParse(ws.path, 'HEAD^{commit}')
    const backup = (await git(ws.path, ['commit-tree', now, ...(head ? ['-p', head] : [])], IDENTITY, `Backup of ${ws.name} before reverting to ${clock(target.checkpoint.ts)}\n`)).trim()
    const backupBranch = await freeBranch(ws.path, `kernel/backup/${ws.name}-${stamp(o.now ?? new Date())}`)
    await git(ws.path, ['branch', backupBranch, backup])
    const { written, removed } = await writeTree(ws.path, now, `${target.sha}^{tree}`)
    await git(ws.path, ['update-ref', headRef(ws.id), target.sha])
    return { checkpoint: { ...target.checkpoint, current: true }, backupBranch, restored: written, removed }
  })
}

/**
 * Make the files of the worktree at `cwd`, which hold the tree `now`, hold `wanted`: only paths that differ are written or
 * removed. HEAD, the real index, ignored files and submodules are left alone. Revert uses it, and so does Fork into new
 * workspace, to give a new worktree the files its source has (KERNEL-346).
 */
export async function writeTree(cwd: string, now: string, wanted: string): Promise<{ written: string[]; removed: string[] }> {
  const raw = await git(cwd, ['diff-tree', '-r', '-z', '--no-renames', now, wanted])
  const fields = raw.split('\0')
  const write: string[] = []
  const remove: string[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [srcMode, dstMode, , , status] = fields[i].replace(/^:/, '').split(' ')
    const path = fields[i + 1]
    if (!path || srcMode === GITLINK || dstMode === GITLINK) continue
    if (status === 'D' || status === 'T') remove.push(path)
    if (status !== 'D') write.push(path)
  }
  for (const path of remove) await removeFile(cwd, path)
  if (write.length) await withTempIndex(cwd, { tree: wanted }, (env) => git(cwd, ['checkout-index', '-f', '-z', '--stdin'], env, write.join('\0') + '\0'))
  return { written: write, removed: remove.filter((p) => !write.includes(p)) }
}
