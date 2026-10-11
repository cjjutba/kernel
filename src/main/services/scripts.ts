import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, copyFile, lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { bus } from '../bus'
import { exec, git } from './exec'
import { resolveCopySources, within } from './filesToCopy'
import type { Readable } from 'node:stream'
import { PORT_BLOCK } from '@shared/types'
import { localUrlIn } from '@shared/previewUrl'

const canBind = (p: number) => new Promise<boolean>((res) => {
  const srv = createServer()
  srv.once('error', () => res(false))
  srv.listen(p, '127.0.0.1', () => srv.close(() => res(true)))
})

/** The first port of each block a workspace can get: 4300, 4310 and so on to 4800 (KERNEL-244). */
export const BLOCK_STARTS = Array.from({ length: (4800 - 4300) / PORT_BLOCK + 1 }, (_, i) => 4300 + i * PORT_BLOCK)

/** Whether the blocks starting at `a` and `b` share a port. A legacy port that isn't a multiple of 10 still has a whole block. */
export const blocksOverlap = (a: number, b: number) => Math.abs(a - b) < PORT_BLOCK

/**
 * A free block of `PORT_BLOCK` ports for a workspace, as its first port ($KERNEL_PORT). `taken` is read again for each candidate,
 * and the port goes in `reserved` before the bind check awaits, so two calls in one turn never get the same block. The caller
 * drops it from `reserved` once the workspace that holds it is saved.
 */
export async function portBlock(taken: () => number[], reserved: Set<number>): Promise<number> {
  for (const start of BLOCK_STARTS) {
    if ([...taken(), ...reserved].some((p) => blocksOverlap(p, start))) continue
    reserved.add(start)
    let free = true
    for (let p = start; p < start + PORT_BLOCK && free; p++) free = await canBind(p)
    if (free) return start
    reserved.delete(start)
  }
  throw new Error('No free block of ports between 4300 and 4809')
}

/**
 * Would writing `to` land outside the worktree? True when `to` is a symlink, or a folder on its way is one that points
 * out: a repo can commit either, and the copy would follow it. Checked before any folder is made (KERNEL-209).
 */
async function leavesWorktree(worktreeRoot: string, to: string): Promise<boolean> {
  if (await lstat(to).then((s) => s.isSymbolicLink(), () => false)) return true
  let dir = dirname(to)
  while (!(await lstat(dir).then(() => true, () => false))) dir = dirname(dir)
  return !within(worktreeRoot, await realpath(dir))
}

/**
 * Copy gitignored files (like .env.local) from the main checkout into a fresh worktree. `entries` are exact paths and
 * patterns (KERNEL-245), resolved by `resolveFilesToCopy`, which keeps every file inside the repo once symlinks are
 * followed and names the entries it refused. Each copy must also land inside the worktree, so a symlink the worktree
 * checked out can't carry it out (KERNEL-209). A worktree an archive already removed gets nothing.
 */
export async function copyLocalFiles(repo: string, worktree: string, entries: string[]): Promise<{ copied: string[]; refused: string[] }> {
  const copied: string[] = [], refused: string[] = []
  const worktreeRoot = await realpath(worktree).catch(() => undefined)
  if (!worktreeRoot) return { copied, refused }
  for (const { path, from } of await resolveCopySources(repo, entries, refused)) {
    const to = join(worktree, path)
    try {
      if (await leavesWorktree(worktreeRoot, to)) { refused.push(path); continue }
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
      copied.push(path)
    } catch { /* a file that went away is fine */ }
  }
  return { copied, refused }
}

/** Link the main checkout's node_modules into a fresh worktree. Skips when either side is missing or the worktree already has one. */
export async function linkNodeModules(repo: string, worktree: string): Promise<boolean> {
  const target = join(repo, 'node_modules')
  const link = join(worktree, 'node_modules')
  if (!existsSync(target)) return false
  if (await lstat(link).then(() => true, () => false)) return false
  await symlink(target, link, 'dir')
  // Git sees the link as a file, so a `node_modules/` line in .gitignore misses it. Exclude it locally instead.
  if ((await exec('git', ['-C', worktree, 'check-ignore', '-q', 'node_modules'])).code !== 0) {
    const exclude = resolve(worktree, (await git(worktree, 'rev-parse', '--git-path', 'info/exclude')).trim())
    await mkdir(dirname(exclude), { recursive: true })
    await appendFile(exclude, '/node_modules\n')
  }
  return true
}

/** The user's login shell so nvm, pnpm and PATH tweaks apply. Falls back to sh. */
export function loginShell(): string {
  if (process.env.SHELL && existsSync(process.env.SHELL)) return process.env.SHELL
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh'
}

/** The most characters a line can hold before it is cut and shown. A spinner writes `\r` and never a newline (KERNEL-246). */
export const MAX_LINE = 64 * 1024

/**
 * Calls `onLine` with each whole line `stream` writes, however the chunks split it, and a character split across two
 * chunks stays whole. A line longer than `MAX_LINE` characters goes out in pieces of `MAX_LINE`, never splitting an emoji.
 * Returns the flush for when the process closes, which hands over a last line with no newline.
 */
export function pipeLines(stream: Readable | null, onLine: (line: string) => void): () => void {
  let buf = ''
  stream?.setEncoding('utf8')
  stream?.on('data', (d: string) => {
    buf += d
    const lines = buf.split(/\r?\n/)
    buf = lines.pop()!
    for (const line of lines) onLine(line)
    while (buf.length >= MAX_LINE) {
      // A high surrogate at the cut would leave half an emoji on each side.
      const cut = /[\uD800-\uDBFF]/.test(buf[MAX_LINE - 1]) ? MAX_LINE - 1 : MAX_LINE
      onLine(buf.slice(0, cut))
      buf = buf.slice(cut)
    }
  })
  return () => { if (buf) onLine(buf); buf = '' }
}

type Kind = 'setup' | 'run' | 'archive'
/** Every script still running, by workspace, kind and run script name. Setup and archive have no name. */
const running = new Map<string, { workspaceId: string; kind: Kind; name?: string; child: ChildProcess }>()
const key = (workspaceId: string, kind: Kind, name?: string) => JSON.stringify([workspaceId, kind, name ?? null])
/** A run script is named, `run` when none is given. Setup and archive aren't. */
const nameOf = (kind: Kind, name?: string) => (kind === 'run' ? name ?? 'run' : undefined)

/**
 * Run a workspace script in a login shell, streaming lines to the UI. Resolves with the exit code. `env` is the whole
 * environment, from `Kernel.envFor` (KERNEL-247).
 */
export function runScript(o: { workspaceId: string; kind: Kind; name?: string; script: string; cwd: string; env: Record<string, string> }): Promise<number | null> {
  const name = nameOf(o.kind, o.name)
  const k = key(o.workspaceId, o.kind, name)
  stopScript(o.workspaceId, o.kind, name)
  const tag = { workspaceId: o.workspaceId, kind: o.kind, ...(name ? { name } : {}) }
  // Settings read from a repo are checked as text before they get here; anything else never reaches the shell (KERNEL-209).
  if (typeof o.script !== 'string') return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn(loginShell(), ['-lc', o.script], {
      cwd: o.cwd,
      env: o.env,
      detached: true
    })
    running.set(k, { workspaceId: o.workspaceId, kind: o.kind, name, child })
    const current = () => running.get(k)?.child === child
    // A run script's URL starts empty. The first local URL it prints is its URL until it exits (KERNEL-246).
    let url: string | null = null
    if (name) bus.push({ type: 'script.url', workspaceId: o.workspaceId, name, url })
    const emit = (line: string, stream: 'stdout' | 'stderr') => {
      if (!line) return
      bus.push({ type: 'script.output', ...tag, line, stream })
      // A process a restart replaced may still be printing. Its URL isn't the new run's.
      if (name && !url && current()) {
        url = localUrlIn(line)
        if (url) bus.push({ type: 'script.url', workspaceId: o.workspaceId, name, url })
      }
    }
    bus.push({ type: 'script.output', ...tag, line: `$ ${o.script.split('\n').join(' && ')}`, stream: 'stdout' })
    const flushes = (['stdout', 'stderr'] as const).map((stream) => pipeLines(child[stream], (line) => emit(line, stream)))
    child.on('error', (err) => { bus.push({ type: 'script.output', ...tag, line: String(err), stream: 'stderr' }) })
    child.on('close', (code) => {
      for (const flush of flushes) flush()
      // A restart already holds the slot with the new process, and its URL.
      const replaced = running.has(k) && !current()
      if (current()) running.delete(k)
      if (name && !replaced) bus.push({ type: 'script.url', workspaceId: o.workspaceId, name, url: null })
      bus.push({ type: 'script.exit', ...tag, code })
      resolve(code)
    })
  })
}

/** How long a stopped script's processes get to exit on SIGTERM before they get SIGKILL. */
const STOP_GRACE_MS = 3000

/** Kill the whole process group so dev servers started by the script die too. A run script without a name is `run`. */
export function stopScript(workspaceId: string, kind: Kind, name?: string, o: { now?: boolean } = {}) {
  const k = key(workspaceId, kind, nameOf(kind, name))
  const child = running.get(k)?.child
  if (child?.pid && o.now) {
    // Kernel is quitting and no timer would outlive it, so the group dies now.
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  } else if (child?.pid) {
    const group = -child.pid
    try { process.kill(group, 'SIGTERM') } catch { child.kill('SIGTERM') }
    // A server that ignores SIGTERM, or a command the shell forked just as the signal came, would keep running and hold the
    // output open, so the script would never report its exit. The group gets SIGKILL if it hasn't closed by then.
    const force = setTimeout(() => { try { process.kill(group, 'SIGKILL') } catch { /* already gone */ } }, STOP_GRACE_MS)
    force.unref()
    child.once('close', () => clearTimeout(force))
  }
  running.delete(k)
}

/** The names of the run scripts running in a workspace. */
export const runningRuns = (workspaceId: string): string[] =>
  [...running.values()].filter((r) => r.workspaceId === workspaceId && r.kind === 'run').map((r) => r.name!)

/** Stop every run script in a workspace (KERNEL-244). */
export function stopRuns(workspaceId: string) { for (const name of runningRuns(workspaceId)) stopScript(workspaceId, 'run', name) }

/** On quit: every script's process group gets SIGKILL at once, so a server that ignores SIGTERM doesn't outlive Kernel. */
export function stopAllScripts() { for (const r of [...running.values()]) stopScript(r.workspaceId, r.kind, r.name, { now: true }) }
