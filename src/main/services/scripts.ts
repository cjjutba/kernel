import { spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { bus } from '../bus'

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

/** Copy gitignored files (like .env.local) from the main checkout into a fresh worktree. Globs are not expanded. */
export async function copyLocalFiles(repo: string, worktree: string, files: string[]): Promise<string[]> {
  const copied: string[] = []
  for (const f of files) {
    try {
      await stat(join(repo, f))
      await mkdir(dirname(join(worktree, f)), { recursive: true })
      await copyFile(join(repo, f), join(worktree, f))
      copied.push(f)
    } catch { /* missing files are fine */ }
  }
  return copied
}

/** CJ's login shell so nvm, pnpm and PATH tweaks apply. Falls back to sh. */
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
