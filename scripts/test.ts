// Runs vitest once a test slot is free, so at most 2 test runs share the Mac (KERNEL-736). Runs on plain Node
// with built-in type stripping, so only erasable TypeScript here.
//
//   pnpm test [vitest args]            KERNEL_TEST_SLOTS sets how many runs at once. CI takes no slot.
//   pnpm test:changed [vitest args]
import { createRequire } from 'node:module'
import { runInSlot } from './testSlots.ts'

const args = process.argv.slice(2)
// pnpm passes a `--` through (`pnpm test -- test/db.test.ts`), so drop it.
if (args[0] === '--') args.shift()
const vitest = createRequire(import.meta.url).resolve('vitest/vitest.mjs')
process.exitCode = await runInSlot(process.execPath, [vitest, 'run', ...args])
