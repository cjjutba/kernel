// How many vitest workers run at once. Each takes about 4 GB on a Mac, and two test runs share the Mac
// (scripts/testSlots.ts), so a local run uses 2. CI runs alone on a bigger machine.
export function workerCount(env: NodeJS.ProcessEnv): number {
  const n = Number(env.KERNEL_TEST_WORKERS)
  if (Number.isInteger(n) && n > 0) return n
  return env.CI ? 4 : 2
}
