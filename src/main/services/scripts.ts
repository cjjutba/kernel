import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, copyFile, lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { bus } from '../bus'
import { exec, git } from './exec'
import { resolveCopySources, within } from './filesToCopy'

/** Find a free TCP port, starting at `from`. Each workspace gets its own as $KERNEL_PORT. */
export async function freePort(from = 4300, taken: Set<number> = new Set()): Promise<number> {
  for (let p = from; p < from + 500; p++) {
    if (taken.has(p)) continue
    const ok = await new Promise<boolean>((res) => {
      const srv = createServer()
      srv.once('error', () => res(false))
      srv.listen(p, '127.0.0.1', () => srv.close(() => res(true)))
    })
    if (ok) return p
  }
  throw new Error('No free port found')
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

type Kind = 'setup' | 'run' | 'archive'
const running = new Map<string, ChildProcess>()
const key = (workspaceId: string, kind: Kind) => `${workspaceId}:${kind}`

/** Run a workspace script in a login shell, streaming lines to the UI. Resolves with the exit code. */
export function runScript(o: { workspaceId: string; kind: Kind; script: string; cwd: string; port: number; root: string }): Promise<number | null> {
  stopScript(o.workspaceId, o.kind)
  // Settings read from a repo are checked as text before they get here; anything else never reaches the shell (KERNEL-209).
  if (typeof o.script !== 'string') return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn(loginShell(), ['-lc', o.script], {
      cwd: o.cwd,
      env: { ...process.env, KERNEL_PORT: String(o.port), PORT: String(o.port), KERNEL_WORKSPACE: o.cwd, KERNEL_ROOT_PATH: o.root, FORCE_COLOR: '0' },
      detached: true
    })
    running.set(key(o.workspaceId, o.kind), child)
    bus.push({ type: 'script.output', workspaceId: o.workspaceId, kind: o.kind, line: `$ ${o.script.split('\n').join(' && ')}`, stream: 'stdout' })
    const pipe = (stream: 'stdout' | 'stderr') => (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line) bus.push({ type: 'script.output', workspaceId: o.workspaceId, kind: o.kind, line, stream })
    }
    child.stdout?.on('data', pipe('stdout'))
    child.stderr?.on('data', pipe('stderr'))
    child.on('error', (err) => { bus.push({ type: 'script.output', workspaceId: o.workspaceId, kind: o.kind, line: String(err), stream: 'stderr' }) })
    child.on('close', (code) => {
      running.delete(key(o.workspaceId, o.kind))
      bus.push({ type: 'script.exit', workspaceId: o.workspaceId, kind: o.kind, code })
      resolve(code)
    })
  })
}

/** Kill the whole process group so dev servers started by the script die too. */
export function stopScript(workspaceId: string, kind: Kind) {
  const child = running.get(key(workspaceId, kind))
  if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }
  running.delete(key(workspaceId, kind))
}

export function stopAllScripts() { for (const k of [...running.keys()]) { const [id, kind] = k.split(':'); stopScript(id, kind as Kind) } }
