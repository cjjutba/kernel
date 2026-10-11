import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The suite runs on Electron's binary (D-013), so every forked worker is a full Electron
// process with its own Dock tile. Cap them: the default is one per core, and several agents
// running tests at once ran the Mac out of memory. Not pool: 'threads', which makes every git
// child process 4 to 5x slower and breaks reviewCleanup's timing (KERNEL-184).
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 20000, pool: 'forks', maxWorkers: 4 }
})
