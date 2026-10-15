import { realpath } from 'node:fs/promises'
import { sep } from 'node:path'
import { exec } from './exec'

/** How long a process Kernel ends gets to exit on SIGTERM before SIGKILL (KERNEL-810). */
export const END_GRACE_MS = 2000

/** Sends `sig` to a pid, or to a process group when the target is negative. 0 only asks whether it exists. */
function send(target: number, sig: NodeJS.Signals | 0): boolean {
  try { process.kill(target, sig); return true } catch { return false }
}

/**
 * Ends each target with SIGTERM, then SIGKILL for the ones still there after `waitMs`. A negative target is a process
 * group. Kernel's own pid, and its own group, are never signalled.
 */
export async function endAll(targets: number[], waitMs = END_GRACE_MS): Promise<void> {
  const list = [...new Set(targets)].filter((t) => Math.abs(t) > 1 && Math.abs(t) !== process.pid)
  for (const t of list) send(t, 'SIGTERM')
  const until = Date.now() + waitMs
  let alive = list.filter((t) => send(t, 0))
  while (alive.length && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100))
    alive = alive.filter((t) => send(t, 0))
  }
  for (const t of alive) send(t, 'SIGKILL')
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** Kernel's own pid and every process above it, up to launchd. */
async function selfAndParents(): Promise<Set<number>> {
  const parent = new Map<number, number>()
  for (const line of (await exec('ps', ['-A', '-o', 'pid=,ppid='], { cwd: '/' })).stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid) parent.set(pid, ppid)
  }
  const mine = new Set<number>()
  for (let p: number | undefined = process.pid; p && !mine.has(p); p = parent.get(p)) mine.add(p)
  mine.add(process.ppid)
  return mine
}

/** The pids whose working folder is `dir` or inside it, from one `lsof` call matched against `dir`'s real path. */
export async function processesIn(dir: string): Promise<number[]> {
  const real = await realpath(dir).catch(() => undefined)
  if (!real) return []
  // lsof exits 1 when it can't read some processes, which still leaves the rest in stdout. It runs from `/`, so it never
  // finds itself.
  const out = (await exec('lsof', ['-a', '-d', 'cwd', '-Fpn'], { cwd: '/', timeoutMs: 30_000 })).stdout
  const pids = new Set<number>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid && inside(line.slice(1), real)) pids.add(pid)
  }
  return [...pids]
}

/**
 * Ends every process working inside a worktree that is about to be archived (KERNEL-810): a dev server or test run an
 * agent left, in its own group or started with `nohup` or `setsid`. Nothing happens unless `dir` is inside `root`, the
 * project's worktree folder, and does not hold one of `keep`, the project's own repo, where the user runs their own programs
 * such as `pnpm dev`. Kernel and the processes above it are never signalled. Returns the pids it signalled.
 */
export async function endProcessesIn(dir: string, o: { root: string; keep: string[]; waitMs?: number }): Promise<number[]> {
  const real = await realpath(dir).catch(() => undefined)
  const root = await realpath(o.root).catch(() => undefined)
  if (!real || !root || real === root || !inside(real, root)) return []
  for (const k of o.keep) {
    const kept = await realpath(k).catch(() => k)
    if (inside(kept, real)) return []
  }
  const found = await processesIn(real)
  if (!found.length) return []
  const mine = await selfAndParents()
  const pids = found.filter((p) => !mine.has(p))
  await endAll(pids, o.waitMs)
  return pids
}
