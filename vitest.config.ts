import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

// Cap the workers: the default is one per core, and several agents running tests at once ran the
// Mac out of memory. Not pool: 'threads', which makes every git child process 4 to 5x slower and
// breaks reviewCleanup's timing (KERNEL-184). better-sqlite3 points at a build for plain Node (KERNEL-735).
// `test/*.mac.test.ts` needs the Mac (zsh, the Mac build of Codex), so it runs there only. On the Mac job alone:
// `pnpm exec vitest run mac.test.ts`.
export default defineConfig({
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve('src/shared') },
      { find: /^better-sqlite3$/, replacement: resolve('test/support/sqlite.ts') }
    ]
  },
  test: { include: ['test/**/*.test.ts'], exclude: process.platform === 'darwin' ? configDefaults.exclude : [...configDefaults.exclude, '**/*.mac.test.ts'], testTimeout: 20000, pool: 'forks', maxWorkers: 4, globalSetup: ['test/support/globalSetup.ts'] }
})
