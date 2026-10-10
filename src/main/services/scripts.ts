import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, copyFile, lstat, mkdir, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { bus } from '../bus'
import { exec, git } from './exec'
import { resolveFilesToCopy } from './filesToCopy'
import { PORT_BLOCK } from '@shared/types'

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

/** Copy gitignored files (like .env.local) from the main checkout into a fresh worktree. `entries` are exact paths and patterns (KERNEL-245). */
export async function copyLocalFiles(repo: string, worktree: string, entries: string[]): Promise<string[]> {
  const copied: string[] = []
  for (const { path } of await resolveFilesToCopy(repo, entries)) {
    try {
      await mkdir(dirname(join(worktree, path)), { recursive: true })
      await copyFile(join(repo, path), join(worktree, path))
      copied.push(path)
    } catch { /* a file that went away is fine */ }
  }
  return copied
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

type Kind = 'setup' | 'run' | 'archive'
/** Every script still running, by workspace, kind and run script name. Setup and archive have no name. */
const running = new Map<string, { workspaceId: string; kind: Kind; name?: string; child: ChildProcess }>()
const key = (workspaceId: string, kind: Kind, name?: string) => JSON.stringify([workspaceId, kind, name ?? null])
/** A run script is named, `run` when none is given. Setup and archive aren't. */
const nameOf = (kind: Kind, name?: string) => (kind === 'run' ? name ?? 'run' : undefined)

/** Run a workspace script in a login shell, streaming lines to the UI. Resolves with the exit code. */
export function runScript(o: { workspaceId: string; kind: Kind; name?: string; script: string; cwd: string; port: number; root: string }): Promise<number | null> {
  const name = nameOf(o.kind, o.name)
  const k = key(o.workspaceId, o.kind, name)
  stopScript(o.workspaceId, o.kind, name)
  const tag = { workspaceId: o.workspaceId, kind: o.kind, ...(name ? { name } : {}) }
  return new Promise((resolve) => {
    const child = spawn(loginShell(), ['-lc', o.script], {
      cwd: o.cwd,
      env: { ...process.env, KERNEL_PORT: String(o.port), PORT: String(o.port), KERNEL_WORKSPACE: o.cwd, KERNEL_ROOT_PATH: o.root, FORCE_COLOR: '0' },
      detached: true
    })
    running.set(k, { workspaceId: o.workspaceId, kind: o.kind, name, child })
    bus.push({ type: 'script.output', ...tag, line: `$ ${o.script.split('\n').join(' && ')}`, stream: 'stdout' })
    const pipe = (stream: 'stdout' | 'stderr') => (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line) bus.push({ type: 'script.output', ...tag, line, stream })
    }
    child.stdout?.on('data', pipe('stdout'))
    child.stderr?.on('data', pipe('stderr'))
    child.on('error', (err) => { bus.push({ type: 'script.output', ...tag, line: String(err), stream: 'stderr' }) })
    child.on('close', (code) => {
      // A restart already holds the slot with the new process.
      if (running.get(k)?.child === child) running.delete(k)
      bus.push({ type: 'script.exit', ...tag, code })
      resolve(code)
    })
  })
}

/** Kill the whole process group so dev servers started by the script die too. A run script without a name is `run`. */
export function stopScript(workspaceId: string, kind: Kind, name?: string) {
  const k = key(workspaceId, kind, nameOf(kind, name))
  const child = running.get(k)?.child
  if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }
  running.delete(k)
}

/** The names of the run scripts running in a workspace. */
export const runningRuns = (workspaceId: string): string[] =>
  [...running.values()].filter((r) => r.workspaceId === workspaceId && r.kind === 'run').map((r) => r.name!)

/** Stop every run script in a workspace (KERNEL-244). */
export function stopRuns(workspaceId: string) { for (const name of runningRuns(workspaceId)) stopScript(workspaceId, 'run', name) }

export function stopAllScripts() { for (const r of [...running.values()]) stopScript(r.workspaceId, r.kind, r.name) }
