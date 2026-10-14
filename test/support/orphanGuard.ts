// A parent killed with SIGKILL runs no handler, so the processes it started check for themselves (KERNEL-812).
// The timers are unref'd, so a guard never keeps a process alive.
const INTERVAL_MS = 1000

// SIGKILL instead of process.exit, which a vitest worker intercepts.
const die = () => process.kill(process.pid, 'SIGKILL')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// vitest's main process: exits once the pid in KERNEL_TEST_RUNNER_PID, set by scripts/test.ts, has died. Does
// nothing without it (CI, `pnpm exec vitest`).
export function exitWhenRunnerDies(env: NodeJS.ProcessEnv = process.env, opts: { intervalMs?: number; exit?: () => void } = {}) {
  const pid = Number(env.KERNEL_TEST_RUNNER_PID)
  if (!Number.isInteger(pid) || pid <= 0) return
  const { intervalMs = INTERVAL_MS, exit = die } = opts
  setInterval(() => {
    if (!isAlive(pid)) exit()
  }, intervalMs).unref()
}

// A worker: exits once its parent has died, which shows as process.ppid changing (to 1, or a subreaper).
export function exitWhenParentDies(opts: { intervalMs?: number; exit?: () => void } = {}) {
  const key = Symbol.for('kernel.orphanGuard.parent')
  const g = globalThis as Record<symbol, unknown>
  if (g[key]) return
  g[key] = true
  const { intervalMs = INTERVAL_MS, exit = die } = opts
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid !== parent) exit()
  }, intervalMs).unref()
}
