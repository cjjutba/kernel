import { copyFile, mkdtemp, readdir, rm, rmdir, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Checkpoint, DiffStat } from '@shared/types'
import { exec, run } from './exec'
import { freeBranch } from './worktrees'

/**
 * Checkpoints (KERNEL-13). After every agent turn the worktree is saved as a commit under a hidden ref,
 * `refs/kernel/checkpoints/<workspace>/<turn>`. Saving goes through a throwaway index, so the real index, HEAD
 * and the files the agent sees never change. Untracked files are included; ignored files are not.
 *
 * What the drawer lists lives in the checkpoint commits themselves (trailers in the message), so the list is one
 * `for-each-ref` and survives restarts. `refs/kernel/checkpoint-head/<workspace>` points at the checkpoint the
 * worktree is at now: the newest one, or the one last reverted to.
 */

/** The parts of a workspace checkpoints need. */
export interface CheckpointWorkspace { id: string; name: string; path: string }

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const GITLINK = '160000'
/** commit-tree needs an identity; a repo without user.name must still get checkpoints. */
const IDENTITY = { GIT_AUTHOR_NAME: 'Kernel', GIT_AUTHOR_EMAIL: 'kernel@localhost', GIT_COMMITTER_NAME: 'Kernel', GIT_COMMITTER_EMAIL: 'kernel@localhost' }

export const checkpointRef = (workspaceId: string, turn: number) => `refs/kernel/checkpoints/${workspaceId}/${turn}`
const headRef = (workspaceId: string) => `refs/kernel/checkpoint-head/${workspaceId}`

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string) => run('git', ['-C', cwd, ...args], { env, input })

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

async function treeStat(cwd: string, from: string, to: string): Promise<DiffStat> {
  const out = await git(cwd, ['diff-tree', '-r', '--no-renames', '--numstat', from, to])
  const stat: DiffStat = { files: 0, added: 0, removed: 0 }
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t')
    stat.files++
    stat.added += Number(a) || 0
    stat.removed += Number(d) || 0
  }
  return stat
}

interface Stored { sha: string; turn: number; checkpoint: Checkpoint }

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
      sha, turn,
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
  return serial(ws.id, async () => {
    const tree = await worktreeTree(ws.path)
    const all = await readAll(ws)
    const turn = all.length ? all[0].turn + 1 : 0
    const start = !!o.start && turn === 0
    const prev = await revParse(ws.path, headRef(ws.id))
    const head = await revParse(ws.path, 'HEAD^{commit}')
    const from = prev ? `${prev}^{tree}` : head ? `${head}^{tree}` : EMPTY_TREE
    const stat = start ? { files: 0, added: 0, removed: 0 } : await treeStat(ws.path, from, tree)
    const ts = o.ts ?? Date.now()
    const title = checkpointTitle(o.title) || `Turn ${turn}`
    const message = [title, '', `Kernel-Chat: ${o.chatId}`, `Kernel-Turn: ${turn}`, `Kernel-Time: ${ts}`, `Kernel-Stat: ${stat.files} ${stat.added} ${stat.removed}`, ...(start ? ['Kernel-Start: true'] : [])].join('\n') + '\n'
    const parent = prev ?? head
    const sha = (await git(ws.path, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], IDENTITY, message)).trim()
    const ref = checkpointRef(ws.id, turn)
    await git(ws.path, ['update-ref', ref, sha])
    await git(ws.path, ['update-ref', headRef(ws.id), sha])
    return { id: String(turn), workspaceId: ws.id, chatId: o.chatId, ts, title, stat, ref, current: true, ...(start ? { start: true } : {}) }
  })
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

    const wanted = `${target.sha}^{tree}`
    const raw = await git(ws.path, ['diff-tree', '-r', '-z', '--no-renames', now, wanted])
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
    for (const path of remove) await removeFile(ws.path, path)
    if (write.length) await withTempIndex(ws.path, { tree: wanted }, (env) => git(ws.path, ['checkout-index', '-f', '-z', '--stdin'], env, write.join('\0') + '\0'))
    await git(ws.path, ['update-ref', headRef(ws.id), target.sha])
    return { checkpoint: { ...target.checkpoint, current: true }, backupBranch, restored: write, removed: remove.filter((p) => !write.includes(p)) }
  })
}
