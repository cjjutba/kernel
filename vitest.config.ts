import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Cap the workers: the default is one per core, and several agents running tests at once ran the
// Mac out of memory. Not pool: 'threads', which makes every git child process 4 to 5x slower and
// breaks reviewCleanup's timing (KERNEL-184). better-sqlite3 points at a build for plain Node (KERNEL-735).
export default defineConfig({
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve('src/shared') },
      { find: /^better-sqlite3$/, replacement: resolve('test/support/sqlite.ts') }
    ]
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 20000, pool: 'forks', maxWorkers: 4, globalSetup: ['test/support/globalSetup.ts'] }
})
